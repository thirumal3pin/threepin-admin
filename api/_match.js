// ═══════════════════════════════════════════════════════════════════════════
// /api/match — the matching API the Match page and Eåsy share
// ═══════════════════════════════════════════════════════════════════════════
//
// Rides on api/bot-test-message.js (?op=match, vercel.json rewrite /api/match): the Hobby plan
// allows 12 functions and all 12 are taken. Every answer comes from the same two browser files the
// CRM panels run — shared-assets/match-engine.js (PinMatch: the score) and match-sources.js
// (PinSources: every property opportunity, onboarded or not) — so a search here, a panel in the
// CRM and an Eåsy reply cannot disagree.
//
//   POST { action: 'search',     mode: 'smart'|'properties'|'clients'|'demand', text?, leadId?, reqIndex?,
//                                item?, details?, propertyId?, listingId?, sellerLeadId?, filters?, sort?, limit? }
//   POST { action: 'interpret',  text }                 what the engine (and the AI) read in a sentence
//   POST { action: 'structure',  leadId | text }        an AI read of a lead's requirements, NOT saved
//   POST { action: 'save-req',   leadId, items }        a reviewed requirement → lead.reqs (+ history)
//   POST { action: 'req-history', leadId }              the requirement's revisions
//
// Who sees what (the agent layer's own rules, shared-assets/agent-access.js):
//   admins and staff  everything.
//   agents            their own leads and their own / co / granted properties in full; any other
//                     client comes back as the restricted card the admin's settings allow (no id —
//                     a reference to request it with), and any other property as its summary.
//
// AI is used to READ text only (a requirement into fields). Every score is the engine's,
// deterministic, and every reason is traceable to a field and a rule. If the AI is down, the
// engine's own reading is used and the answer says so.

import Anthropic from '@anthropic-ai/sdk';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { readLeads, writeLead } from './_lead-views.js';
import * as AA from '../shared-assets/agent-access.js';
import { effectiveConfig } from '../shared-assets/agent-config.js';
import { teamOf, nameIn, loadConfig, loadGrants, leadRef } from './_agent-work.js';
import '../dashboard-assets/search-engine.js';
import '../shared-assets/chennai-geo.js';
import '../shared-assets/area-model.js';
import '../shared-assets/match-engine.js';
import '../shared-assets/match-sources.js';

const PinMatch = globalThis.PinMatch;
const PS = globalThis.PinSources;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const lc = s => String(s == null ? '' : s).trim().toLowerCase();

// ── Data, cached per warm instance ─────────────────────────────────────────
// Leads come from the lead views (a read per ~20 leads); the rest is small and changes slowly.
const STOCK_TTL = 5 * 60000, LEADS_TTL = 60000;
const cache = new Map();
let source = null;            // tests: () => ({ properties, listings, leads, submissions, trackStages, stages })
export const __setSource = fn => { source = fn; cache.clear(); };

async function loadAll(db, tenantId, { fresh = false } = {}) {
  if (source) {
    const d = await source(tenantId);
    return { ...d, unified: PS.buildUnified(d), at: Date.now() };
  }
  const now = Date.now();
  let c = cache.get(tenantId);
  if (fresh || !c || now - c.stockAt > STOCK_TTL) {
    const [props, listings, subs, track, pipe] = await Promise.all([
      db.collection('properties').where('tenantId', '==', tenantId).get(),
      db.collection('listings').where('tenantId', '==', tenantId).get(),
      db.collection('propertySubmissions').where('tenantId', '==', tenantId).where('status', '==', 'pending').get().catch(() => ({ docs: [] })),
      db.collection('trackPipelines').doc(tenantId).get(),
      db.collection('pipelines').doc(tenantId).get()
    ]);
    c = {
      properties: props.docs.map(d => ({ ...d.data(), id: d.id })),
      listings: listings.docs.map(d => ({ ...d.data(), id: d.id })),
      submissions: subs.docs.map(d => ({ ...d.data(), id: d.id })),
      trackStages: (track.exists && track.data().stages) || [],
      stages: (pipe.exists && pipe.data().stages) || [],
      stockAt: now, leadsAt: 0, leads: null, unified: null
    };
    cache.set(tenantId, c);
  }
  if (fresh || !c.leads || now - c.leadsAt > LEADS_TTL) {
    c.leads = await readLeads(db, tenantId);
    c.leadsAt = now;
    c.unified = null;
  }
  if (!c.unified) c.unified = PS.buildUnified({ properties: c.properties, listings: c.listings, leads: c.leads, submissions: c.submissions, trackStages: c.trackStages });
  return c;
}

// ── Who is asking ──────────────────────────────────────────────────────────
async function viewerOf(db, user) {
  const me = lc(user.email);
  const team = await teamOf(db, user.tenantId).catch(() => []);
  if (user.role !== 'agent') return { me, agent: false, team };
  const cfg = effectiveConfig(await loadConfig(db, user.tenantId), me);
  const grants = await loadGrants(db, user.tenantId).catch(() => []);
  const agentSet = new Set(team.filter(u => u.role === 'agent').map(u => u.email));
  return { me, agent: true, team, cfg, grants, agentSet };
}

// A client row as this viewer may see it.
function shapeClient(row, lead, v, tenantId) {
  if (!v.agent || AA.leadVisibleTo(lead, v.me) || hasLeadGrant(v, lead)) return { ...row, access: 'full' };
  const card = AA.matchCard(lead, v.cfg.matchingLeadFields || [], {});
  // Only what the settings allow, plus the score and reasons (which quote no contact detail).
  const scrub = t => AA.scrubText(String(t || ''), [lead.name]);
  return {
    id: 'ref:' + leadRef(tenantId, lead.id), ref: leadRef(tenantId, lead.id), access: 'restricted',
    name: card.name || 'A matching client', phone: card.phone || '', stage: card.stage ? row.stage : '', leadSource: card.source || '',
    // A band, never the figure: the figure can quote another agent's property ("₹3.25 Cr quoted for ANR003").
    // No "asked for" text: the client's own words can carry figures and names; the structured rows
    // (wants, areas, a budget band) say the same safely.
    budget: budgetBand(row.budgetMax, row.budgetMode), locations: row.locations, exclude: row.exclude, config: row.config, types: row.types, sub: row.sub,
    area: row.area, dealLabel: row.dealLabel, deal: row.deal, pct: row.pct, vetoed: row.vetoed, band: row.band, confidence: row.confidence, confidenceValue: row.confidenceValue,
    for: row.for.map(x => ({ ...x, why: scrub(x.why) })), against: row.against.map(x => ({ key: x.key, label: x.label, lost: x.lost, why: scrub(x.why) })),
    unknown: row.unknown.map(x => ({ key: x.key, label: x.label, why: scrub(x.why) })), vetoes: (row.vetoes || []).map(x => ({ key: x.key, label: x.label, why: scrub(x.why) })),
    budgetDiff: row.budgetDiff ? { within: row.budgetDiff.within, text: row.budgetDiff.within ? 'Within their budget' : 'Over their budget' } : null,
    location2: row.location2, interest: row.interest,
    owner: '', ownerName: row.ownerName === 'Office' ? 'Office' : row.ownerName && row.ownerName !== 'Unassigned' ? row.ownerName : 'Office',
    requested: !!(v.requested && v.requested.has(leadRef(tenantId, lead.id))),
    next: '', rank: row.rank
  };
}
// A client row with the property's price taken out of every line that would quote it.
function hidePrice(r) {
  const swap = x => (x && x.key === 'budget' ? { ...x, why: /over/i.test(x.why || '') ? 'Over their budget' : 'In their budget' } : x);
  return { ...r, for: (r.for || []).map(swap), against: (r.against || []).map(swap), breakdown: (r.breakdown || []).map(swap),
    budgetDiff: r.budgetDiff ? { within: r.budgetDiff.within, soft: r.budgetDiff.soft, text: r.budgetDiff.within ? 'In their budget' : 'Over their budget' } : null };
}
function budgetBand(max, mode) {
  if (!max) return '';
  if (mode === 'monthly') { const k = Math.round(max / 1000); return k < 30 ? 'Under ₹30k a month' : k < 60 ? '₹30k–60k a month' : k < 150 ? '₹60k–1.5 L a month' : 'Above ₹1.5 L a month'; }
  const cr = max / 1e7;
  return cr < 0.75 ? 'Under ₹75 L' : cr < 1.5 ? '₹75 L – 1.5 Cr' : cr < 3 ? '₹1.5–3 Cr' : cr < 5 ? '₹3–5 Cr' : 'Above ₹5 Cr';
}
function hasLeadGrant(v, lead) {
  return (v.grants || []).some(g => g.kind === 'lead' && String(g.targetId) === String(lead.id) && lc(g.agentEmail) === v.me && AA.grantLive(g));
}

// A property row as this viewer may see it.
function shapeProperty(row, v, unified) {
  if (!v.agent) return { ...row, access: 'full' };
  if (row.source === 'onboarded') {
    const p = (unified.raw || []).find(x => String(x.id) === String(row.link.id));
    const role = p ? AA.roleOn(p, v.me) : null;
    const granted = p && (v.grants || []).some(g => g.kind === 'property' && String(g.targetId) === String(p.id) && lc(g.agentEmail) === v.me && AA.grantLive(g));
    if (role || granted) return { ...row, access: role ? 'own' : 'granted' };
    const allowed = new Set(v.cfg.otherPropertyFields || []);
    return {
      ...row, access: 'summary', facts: row.facts.filter(f => allowed.has('price') || f.label !== 'Price'),
      price: allowed.has('price') || allowed.has('startingPrice') ? row.price : '', alsoIn: [],
      requested: !!(v.requested && v.requested.has(String(row.link.id))),
      // With the price hidden, "₹25 L over budget" would give it away.
      budget: allowed.has('price') || allowed.has('startingPrice') || !row.budget ? row.budget : { within: row.budget.within, soft: !!row.budget.soft, pct: null, text: row.budget.within ? 'Within budget' : 'Over budget' },
      next: 'Request this property’s details to share it'
    };
  }
  // Not yet onboarded: an agent sees their own cards and submissions in full; anyone else's as
  // "an opportunity in <area>" — never the seller's name or number.
  if (row.agent && row.agent === v.me) return { ...row, access: 'own' };
  return {
    ...row, access: 'restricted', name: [row.config || (row.bhk && row.bhk.length ? row.bhk.join('/') + ' BHK' : ''), (globalThis.PinSearch.TYPE_LABEL[row.type] || ''), row.location ? 'in ' + row.location : ''].filter(Boolean).join(' ') || 'A seller enquiry',
    alsoIn: [], link: { type: 'restricted', id: '' }, next: 'Ask the office about this opportunity'
  };
}

// ── The AI reader ──────────────────────────────────────────────────────────
//
// Turns a sentence (or a lead's case file) into ITEMs (match-sources.js cleanItem). Gemini
// Flash-Lite first — the owner's choice of the lowest-cost model for lead reading — then Claude
// Haiku, then nothing: the engine's own reading stands.
const ITEM_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['direction', 'items', 'questions'],
  properties: {
    direction: { type: 'string', enum: ['properties', 'clients', 'unclear'] },
    questions: { type: 'array', items: { type: 'string' } },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['status', 'deal', 'types', 'sub', 'bhk', 'locations', 'exclude', 'anywhere', 'radiusKm', 'budget', 'area', 'condition', 'possession', 'mustHave', 'facing', 'furnishing', 'uncertain', 'missing', 'label'],
        properties: {
          status: { type: 'string', enum: ['active', 'previous', 'closed'] },
          deal: { anyOf: [{ type: 'string', enum: ['buy', 'rent', 'lease', 'jv', 'either'] }, { type: 'null' }] },
          types: { type: 'array', items: { type: 'string', enum: ['apartment', 'villa', 'independent_house', 'plot', 'commercial'] } },
          sub: { anyOf: [{ type: 'string', enum: PinMatch.SUBTYPES.map(x => x.sub) }, { type: 'null' }] },
          bhk: { type: 'array', items: { type: 'integer' } },
          locations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pref'], properties: { name: { type: 'string' }, pref: { type: 'string', enum: ['primary', 'secondary'] } } } },
          exclude: { type: 'array', items: { type: 'string' } },
          anywhere: { type: 'boolean' },
          radiusKm: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          budget: { anyOf: [{ type: 'object', additionalProperties: false, required: ['min', 'max', 'unit', 'flex'], properties: {
            min: { anyOf: [{ type: 'number' }, { type: 'null' }] }, max: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            unit: { type: 'string', enum: ['total', 'per_month', 'per_sqft', 'lease_amount'] }, flex: { type: 'string', enum: ['fixed', 'approximate', 'negotiable', 'maximum', 'minimum'] } } }, { type: 'null' }] },
          area: { anyOf: [{ type: 'object', additionalProperties: false, required: ['min', 'max', 'unit', 'kind'], properties: {
            min: { anyOf: [{ type: 'number' }, { type: 'null' }] }, max: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            unit: { type: 'string', enum: ['sqft', 'sqm', 'grounds', 'cents', 'acres'] }, kind: { type: 'string', enum: ['built', 'carpet', 'land'] } } }, { type: 'null' }] },
          condition: { type: 'array', items: { type: 'string', enum: ['new', 'resale', 'ready', 'under_construction'] } },
          possession: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          mustHave: { type: 'array', items: { type: 'string' } },
          facing: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          furnishing: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          uncertain: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' } },
          label: { type: 'string' }
        }
      }
    }
  }
};

export const STRUCTURE_SYSTEM = [
  'You are a senior Chennai real-estate requirements analyst at 3 PIN Realty, a brokerage. You turn what a client, an agent or a CRM note says into structured property requirements. You never invent a fact: a field nobody stated is null or [], and a field you had to guess is ALSO named in `uncertain`.',
  '',
  'Read Indian and Chennai real-estate usage exactly:',
  '- Money in rupees: 1 Cr = 10000000, 1 lakh/L = 100000, 45k = 45000. "around 3 Cr" → max 30000000, flex approximate; "max 2.5 Cr"/"under"/"within"/"kulla" → flex maximum; "above"/"minimum" → min with flex minimum; "negotiable"/"flexible" → negotiable; a range → min and max.',
  '- Rent is per month (unit per_month) unless they say per annum/yearly (divide by 12). A lump-sum lease deposit (otti/bhogya/lease amount) is unit lease_amount. A rate "per sqft" is unit per_sqft. Never confuse rent with a sale price.',
  '- Land: 1 ground = 2400 sq ft, 1 cent = 435.6 sq ft, 1 acre = 43560 sq ft. Keep the unit they used (grounds/cents/acres) with kind "land". A flat\'s size is built (or carpet if they said carpet).',
  '- deal: buy (incl. "for sale", resale, outright purchase), rent (monthly), lease (lump-sum lease), jv (joint venture / joint development / JD / area sharing with a builder), either (only when they said rent or buy).',
  '- types and sub: apartment / villa / independent_house / plot / commercial. sub refines land (res_plot, commercial_land, industrial_land, agri_land) and commercial (office, retail, warehouse, industrial, hospitality, coworking, building). "Showroom"/"shop" = retail; "godown" = warehouse; "factory"/"shed" = industrial; "restaurant"/"hotel" = hospitality; "commercial building for lease" = building. Industrial land is a plot with sub industrial_land, never commercial.',
  '- locations: Chennai localities as they wrote them, corrected for obvious misspellings (anna nagr → Anna Nagar, velachery/velacheri). pref primary for the first/main one, secondary for "or"/"also"/"preferably nearby". exclude: places they ruled out ("not interested in Mogappair", "except OMR", "X vendam"). anywhere: true only for "anywhere in Chennai"/"any area". radiusKm for "within N km".',
  '- condition: new / resale / ready / under_construction — "new or resale" is both. possession: "immediate" for ready-to-move/immediate, or "YYYY-MM" for a stated deadline.',
  '- mustHave: each specific ask in a few words (covered car parking, lift, frontage, private pool, gated community, east facing, near a school). Tamil-English is normal: "venum" = want, "vendam" = do not want, "kulla" = within.',
  '- More than one property wanted (a flat to live in AND a plot to invest, a home AND a shop) → one item each. A requirement they replaced or dropped → status "previous", and only the latest stays active. Older notes lose to newer ones; dates are given where known.',
  '- uncertain: the field names you inferred rather than read (e.g. "budget" when only an EMI was mentioned). missing: the essentials still unknown among deal, types, locations, budget, bhk (bhk only for homes), area (for land/commercial).',
  '- label: a 3–8 word title, e.g. "3 BHK in Anna Nagar, ~₹3 Cr".',
  '- direction: "clients" when the text asks to FIND CLIENTS/BUYERS/TENANTS for a property (or describes a property someone is offering), "properties" when it describes what someone wants, else "unclear".',
  '- questions: at most 2 short clarification questions, ONLY when an essential fact is missing or contradictory (e.g. a 2 BHK at ₹8 Cr in Velachery). Usually [].',
  'Answer only with the JSON object.'
].join('\n');

const aiMemo = new Map();
let _anthropic = null;
let aiImpl = null;     // tests: async (system, text) => raw JSON
export const __setAi = fn => { aiImpl = fn; aiMemo.clear(); };

async function askGemini(system, text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no Gemini key');
  const model = process.env.MATCH_AI_MODEL && /^gemini-/.test(process.env.MATCH_AI_MODEL) ? process.env.MATCH_AI_MODEL : 'gemini-3.5-flash-lite';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: ITEM_SCHEMA, thinkingConfig: { thinkingLevel: 'minimal' }, maxOutputTokens: 3000 } })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Gemini ' + res.status);
    const cand = (body.candidates || [])[0];
    const out = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
    return { raw: JSON.parse(out), model };
  } finally { clearTimeout(timer); }
}
async function askClaude(system, text) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('no Claude key');
  if (!_anthropic) _anthropic = new Anthropic();
  const model = 'claude-haiku-5-5';
  const msg = await _anthropic.messages.create({
    model, max_tokens: 3000, system, messages: [{ role: 'user', content: text }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ITEM_SCHEMA } }
  }, { timeout: 20000 });
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') throw new Error('Claude ' + msg.stop_reason);
  const t = (msg.content || []).find(b => b.type === 'text');
  return { raw: JSON.parse(t ? t.text : '{}'), model: msg.model || model };
}

export async function structureText(text) {
  const key = String(text || '').slice(0, 6000);
  if (!key.trim()) return { ok: false, error: 'Nothing to read' };
  if (aiMemo.has(key)) return aiMemo.get(key);
  let got = null, error = null;
  const tries = aiImpl ? [() => aiImpl(STRUCTURE_SYSTEM, key).then(raw => ({ raw, model: 'test' }))] : [() => askGemini(STRUCTURE_SYSTEM, key), () => askClaude(STRUCTURE_SYSTEM, key)];
  for (const t of tries) {
    try { got = await t(); break; } catch (e) { error = e.message; }
  }
  if (!got) return { ok: false, error: error || 'AI unavailable' };
  const raw = got.raw || {};
  const items = (Array.isArray(raw.items) ? raw.items : []).map(PS.cleanItem).filter(Boolean).slice(0, 5);
  const out = { ok: true, model: got.model, direction: ['properties', 'clients'].includes(raw.direction) ? raw.direction : 'unclear',
    items, questions: (Array.isArray(raw.questions) ? raw.questions : []).map(q => String(q).slice(0, 160)).slice(0, 2) };
  if (aiMemo.size > 300) aiMemo.clear();
  aiMemo.set(key, out);
  return out;
}

// A lead's requirement, as one case file for the reader: the CRM fields, TailorTalk's profile, the
// latest ask and the newest team notes — dated, newest last. Phone numbers never leave.
const maskContacts = s => String(s || '').replace(/\+?\d[\d\s-]{8,}\d/g, '[number]').replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]');
async function caseFileOf(db, lead) {
  const lines = [];
  const at = t => (t ? new Date(t).toISOString().slice(0, 10) : '');
  const add = (label, v, t) => { const s = maskContacts(v).trim(); if (s) lines.push(`${label}${t ? ' (' + at(t) + ')' : ''}: ${s.slice(0, 700)}`); };
  const tt = lead.tt || {}, prof = tt.profile || {};
  add('CRM requirement', lead.propertyInterest, lead.updatedAt);
  add('CRM budget', lead.budget, lead.updatedAt);
  add('Enquiry type', lead.enquiryType);
  add('TailorTalk requirement', prof.requirement_details, tt.lastMessageAt);
  add('TailorTalk budget', prof.budget_and_finance, tt.lastMessageAt);
  add('TailorTalk preferred location', prof.preferred_location, tt.lastMessageAt);
  add('TailorTalk objections', prof.objections_and_blockers, tt.lastMessageAt);
  add('Their latest ask', tt.latestAsk, tt.lastMessageAt);
  Object.entries(lead.rawFieldData || {}).forEach(([k, v]) => { if (!/name|phone|email/.test(k)) add('Ad form ' + k.replace(/_/g, ' '), v, lead.createdAt); });
  try {
    const notes = await db.collection('leads').doc(lead.id).collection('notes').orderBy('createdAt', 'desc').limit(8).get();
    notes.docs.reverse().forEach(d => add('Team note', d.data().text, d.data().createdAt));
  } catch { if (lead.lastNote) add('Team note', lead.lastNote.text, lead.lastNote.createdAt); }
  return lines.join('\n');
}

// May this person change this lead's requirement? Staff always; an agent only a lead they work.
function canWork(v, lead) {
  if (!v.agent) return true;
  return AA.canWorkLead ? AA.canWorkLead(lead, v.me, v.agentSet) : AA.leadVisibleTo(lead, v.me);
}

// ── Searching ──────────────────────────────────────────────────────────────
function leadOf(data, id) { return (data.leads || []).find(l => String(l.id) === String(id)) || null; }

// A client by name or number (the people this viewer may open), best first: whole-name and
// start-of-word hits before anything containing the words; a number by its last digits.
function pickLeads(d, text, v) {
  const q = lc(text).replace(/\s+/g, ' ').trim();
  const digits = q.replace(/\D/g, '');
  if (!q) return [];
  const words = q.split(' ').filter(Boolean);
  const out = [];
  for (const l of d.leads || []) {
    if (v.agent && !AA.leadVisibleTo(l, v.me) && !hasLeadGrant(v, l)) continue;
    if (PinMatch.isClosedLead(l)) continue;
    const name = lc(l.name);
    const phone = String(l.phone || '').replace(/\D/g, '');
    let score = 0;
    if (digits.length >= 4 && phone.endsWith(digits)) score = 3;
    else if (digits.length >= 5 && phone.includes(digits)) score = 2;
    else if (name && words.every(w => name.split(/\s+/).some(x => x.startsWith(w)))) score = name === q ? 4 : 2.5;
    else if (name && words.every(w => name.includes(w))) score = 1;
    if (!score) continue;
    const seller = PS.isSellerLead(l);
    out.push({ score, leadId: String(l.id), name: l.name || '(no name)', seller, stage: PS.stageOf(l, d.stages).name,
      requirement: AA.requirementOf ? AA.requirementOf(l).slice(0, 140) : String(l.propertyInterest || ''), phoneEnd: phone ? '…' + phone.slice(-4) : '', updatedAt: PS.lastTouch(l) });
  }
  return out.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, 12).map(({ score, ...x }) => x);
}
// A property by code or name, among those this viewer may open.
function pickProperties(d, text, v) {
  const q = lc(text).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const key = q.replace(/ /g, '');
  if (!q) return [];
  const out = [];
  for (const p of d.properties || []) {
    if (!PS.propertyStatus(p)) continue;
    const code = lc(p.propertyCode || p.id).replace(/[^a-z0-9]/g, '');
    const name = lc(p.name).replace(/[^a-z0-9 ]/g, ' ');
    let score = 0;
    if (code === key) score = 5;
    else if (key.length >= 3 && code.startsWith(key)) score = 3;
    else if (q.split(' ').every(w => name.includes(w))) score = 2;
    if (!score) continue;
    out.push({ score, propertyId: String(p.id), code: p.propertyCode || p.id, name: p.name || '', location: p.location || '', price: p.startingPrice || '' });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 12).map(({ score, ...x }) => x);
}

export async function runSearch({ db, user, body: body0, viewer, data }) {
  let body = body0 || {};
  const v = viewer || await viewerOf(db, user);
  const d = data || await loadAll(db, user.tenantId);
  // An agent's requests still waiting: the rows say "Requested · waiting" after a reload too.
  if (v.agent && !v.requested && db) {
    try {
      const q = await db.collection('accessRequests').where('tenantId', '==', user.tenantId).where('requesterEmail', '==', v.me).where('status', '==', 'pending').get();
      v.requested = new Set(q.docs.map(x => String(x.data().targetRef || x.data().targetId || '')));
    } catch (e) { v.requested = new Set(); }
  }
  const now = Date.now();
  const limit = Math.min(Math.max(Number(body.limit) || 60, 1), 200);
  let mode = body.mode || 'smart';
  let text = String(body.text || '').slice(0, 1000);
  let scope = null, clientBudget = null;
  if (mode === 'smart') {
    const q = PS.parseSmartQuery(text);
    mode = q.direction; text = q.text; scope = q.scope; clientBudget = q.budgetFilter;
    // The tab the person is on settles a sentence that names no direction of its own: on "Find
    // clients", "3 BHK Anna Nagar 3 Cr" describes the property to find clients for.
    // Only words that ask for a direction outright keep the sentence from following the toggle.
    const said = q.direction !== 'properties' || q.scope || /\b(?:properties\s+(?:for|in|at|near)|find\s+(?:me\s+)?(?:a\s+)?(?:flat|property|properties|house|home)\s+for\s+(?:my|a|our)\s+(?:client|buyer|tenant))\b/i.test(String(body.text || ''));
    if (body.prefer === 'clients' && mode === 'properties' && !scope && !said) mode = 'clients';
    // Words with no requirement in them at all — a name, a phone number, a code: look the person
    // (or the property) up instead of matching nonsense.
    const r0 = PinMatch.briefProfile(text, {});
    const facts = [r0.deal, r0.budget, r0.localities, r0.bhk, r0.types, r0.size].filter(Boolean).length;
    if (!facts && mode !== 'demand') {
      // Which kind of name: the tab says (a property's on "Find clients", a client's otherwise).
      const forProperty = body.prefer === 'clients';
      const raw = String(body.text || '').replace(/^\s*(?:find|show|search)?\s*(?:the\s+)?(?:client|customer|lead|buyer|tenant|property|code)s?\s*[:\-]?\s*/i, '').trim() || text;
      const found = forProperty ? pickProperties(d, raw, v) : pickLeads(d, raw, v);
      if (found.length === 1 && forProperty) { body = { ...body, propertyId: found[0].propertyId }; mode = 'clients'; }
      else return { mode: 'pick', pick: forProperty ? 'property' : 'lead', text: raw, rows: found, total: found.length };
    }
  } else if (body.scope) scope = String(body.scope);
  // The person who works the client: their name; an admin's login means the office has it.
  const nameOf = e => {
    const em = lc(e);
    if (!em) return 'Unassigned';
    const u = (v.team || []).find(x => x.email === em);
    if (u && u.role === 'admin') return 'Office';
    // A shared office login ("admin@…", "info@…", "office@…") is the office, not a person.
    if (/^(?:admin|office|info|sales|team|3pin|threepin)\b/.test(em.split('@')[0])) return 'Office';
    return u ? u.name : (em.includes('@') ? em.split('@')[0] : em);
  };
  const filters = Object.assign({}, body.filters || {}, clientBudget ? { clientBudget } : {});
  const sort = body.sort || 'score';
  // Ruled-out rows are always scored so the page can say "No match yet — 58 were ruled out"; they
  // are only SENT when asked for (Show ruled out).
  const showOut = !!(filters && filters.showRuledOut);
  const includeVetoed = true;
  const cut = list => { const out = list.filter(r => r.vetoed).length; return { rows: showOut ? list : list.filter(r => !r.vetoed), out }; };

  if (mode === 'demand') {
    const statusKeys = scope === 'shoot' ? ['shoot_scheduled', 'shoot_done', 'media_ready', 'for_approval', 'approved'] : null;
    const all = PS.demandFor(d.unified, d.leads, { stages: d.stages, statusKeys, now })
    const kept = all
      .filter(x => !filters.sources || !filters.sources.length || filters.sources.includes(x.entry.src.kind))
      .filter(x => !filters.types || !filters.types.length || filters.types.includes(x.entry.type))
      .filter(x => !filters.location || [x.entry.locationText].concat((x.entry.localities || []).map(k => globalThis.PinGeo.label(k))).join(' ').toLowerCase().includes(String(filters.location).toLowerCase()))
    const rows = kept.slice(0, limit).map(x => ({
        property: shapeProperty(PS.propertyRow({ property: x.entry, p: x.entry.p, pct: 0, confidence: x.entry.src ? 0 : 0, vetoed: false, vetoes: [], for: [], against: [], unknown: [], breakdown: [], rank: 0 }), v, d.unified),
        buyers: x.buyers, strong: x.strong,
        top: x.top.map(t => { const l = leadOf(d, t.leadId); return v.agent && l && !AA.leadVisibleTo(l, v.me) ? { pct: t.pct, name: 'A matching client', ref: leadRef(user.tenantId, t.leadId), held: true } : t; }),
        ...(v.agent ? (() => { const ids = x.ids || []; const yours = ids.filter(id => { const l = leadOf(d, id); return l && AA.leadVisibleTo(l, v.me); }).length; return { yours, held: x.buyers - yours }; })() : {})
      }));
    return { mode, scope, rows, total: kept.length };
  }

  if (mode === 'clients') {
    let prop = null, about = null;
    if (body.propertyId) {
      // By document id, or by the code people type (any case, any spacing).
      const key = String(body.propertyId).toLowerCase().replace(/[^a-z0-9]/g, '');
      const raw = d.properties.find(x => String(x.id) === String(body.propertyId))
        || d.properties.find(x => String(x.id).toLowerCase().replace(/[^a-z0-9]/g, '') === key || String(x.propertyCode || '').toLowerCase().replace(/[^a-z0-9]/g, '') === key);
      if (raw) {
        body.propertyId = String(raw.id);
        prop = d.unified.find(e => e.src && e.src.kind === 'onboarded' && String(e.src.link.id) === String(raw.id)) || PinMatch.propertyProfile(raw);
      }
    } else if (body.submissionId) prop = d.unified.find(e => e.src && e.src.kind === 'submission' && String(e.src.ids.submissionId) === String(body.submissionId));
    else if (body.listingId) prop = d.unified.find(e => e.src && String(e.src.ids.listingId) === String(body.listingId));
    else if (body.sellerLeadId) {
      prop = d.unified.find(e => e.src && String(e.src.ids.leadId) === String(body.sellerLeadId));
      if (!prop) { const l = leadOf(d, body.sellerLeadId); if (l) prop = PinMatch.ownerPropertyProfile(l); }
    } else if (body.details) prop = PS.propertyFromDetails(body.details);
    else if (text) prop = PS.propertyFromBrief(text);
    if (!prop) return { mode, error: 'Tell me about the property — a code, or its type, place and price' };
    if (v.agent && body.propertyId) {
      const shaped = shapeProperty({ source: 'onboarded', link: { id: String(body.propertyId) }, facts: [] }, v, d.unified);
      if (shaped.access === 'summary' && !d.properties.some(p => String(p.id) === String(body.propertyId))) return { mode, error: 'No such property' };
    }
    // An agent searching another agent's property (or the office's seller enquiry) whose price they
    // may not see: no figure anywhere — not in the reading, not in a client's budget line.
    let priceHidden = false;
    if (v.agent && !body.details && !(body.text && !body.propertyId && !body.listingId && !body.sellerLeadId)) {
      const raw = prop.p || null;
      const own = raw && (AA.roleOn(raw, v.me) || (v.grants || []).some(g => g.kind === 'property' && String(g.targetId) === String(raw.id) && lc(g.agentEmail) === v.me && AA.grantLive(g)));
      const mineCard = prop.src && prop.src.agent && prop.src.agent === v.me;
      const allowed = new Set((v.cfg && v.cfg.otherPropertyFields) || []);
      priceHidden = !own && !mineCard && !(allowed.has('price') || allowed.has('startingPrice'));
    }
    about = { name: prop.name, type: prop.type, sub: prop.sub, deal: prop.deal, price: priceHidden ? '' : PinMatch.priceLabel(prop), priceHidden, location: (prop.localities || []).map(k => globalThis.PinGeo.label(k)).join(', ') || prop.locationText };
    let rows = PS.findClients(prop, d.leads, { inventory: d.unified.raw, unified: d.unified, stages: d.stages, nameOf, now, minPct: filters.minPct || 50, includeVetoed });
    rows = PS.sortRows(PS.filterRows(rows, { ...filters, showRuledOut: true }), sort);
    const c1 = cut(rows); rows = c1.rows;
    const total = rows.filter(r => !r.vetoed).length, ruledOut = c1.out;
    const byId = new Map(d.leads.map(l => [String(l.id), l]));
    let shaped = rows.map(r => shapeClient(r, byId.get(r.leadId), v, user.tenantId));
    if (about.priceHidden) shaped = shaped.map(r => hidePrice(r));
    // "Mine": only the clients this agent works.
    if (filters.mine) shaped = shaped.filter(r => r.access === 'full');
    // Counted before "Mine" narrows the list, so the header always says how many are theirs and held.
    const allShaped = filters.mine ? rows.map(r => shapeClient(r, byId.get(r.leadId), v, user.tenantId)) : shaped;
    const held = v.agent ? allShaped.filter(r => r.access === 'restricted' && !r.vetoed).length : 0;
    const yours = v.agent ? allShaped.filter(r => r.access !== 'restricted' && !r.vetoed).length : 0;
    const shownTotal = filters.mine ? shaped.filter(r => !r.vetoed).length : total;
    return { mode, about, rows: shaped.slice(0, limit), total: shownTotal, ruledOut, ...(v.agent ? { yours, held } : {}) };
  }

  // properties
  let req = null, reading = null;
  if (body.leadId) {
    const lead = leadOf(d, body.leadId);
    if (!lead) return { mode, error: 'That lead is not here' };
    if (v.agent && !AA.leadVisibleTo(lead, v.me) && !hasLeadGrant(v, lead)) return { mode, error: 'That lead is not yours' };
    const profs = PinMatch.requirementProfiles(lead, { inventory: d.unified.raw, now });
    req = body.reqIndex != null ? (profs.find(p => p.reqIndex === Number(body.reqIndex)) || profs[0]) : profs[0];
    // Every saved item, previous ones too (with their status), so a form saving them back never
    // drops one; `requirements` is what is matched now (the live ones).
    const allItems = lead.reqs && Array.isArray(lead.reqs.items) ? lead.reqs.items.map(PS.cleanItem).filter(Boolean) : null;
    reading = { from: 'lead', leadName: lead.name || '', allItems, reviewedAt: (lead.reqs && lead.reqs.at) || null, reviewedBy: (lead.reqs && lead.reqs.by) || null,
      reviewedByName: lead.reqs && lead.reqs.by ? nameIn(v.team || [], lead.reqs.by) : null,
      requirements: profs.map(p => ({ index: p.reqIndex, text: p.reqText || '', src: p.reqSrc || 'lead', stale: !!p.reqStale, item: p.reqItem || PS.itemFromProfile(p), ...PS.explainReq(p) })) };
  } else if (body.item) {
    const it = PS.cleanItem(body.item);
    if (!it) return { mode, error: 'That requirement has nothing to search on yet' };
    req = PinMatch.briefProfile(PinMatch.reqSentence(it), { now, inventory: d.unified.raw });
    reading = { from: 'item', sentence: PinMatch.reqSentence(it), ...PS.explainReq(req) };
  } else if (text) {
    req = PinMatch.briefProfile(text, { now, inventory: d.unified.raw });
    reading = { from: 'text', ...PS.explainReq(req), item: PS.itemFromProfile(req) };
  } else return { mode, error: 'Type a requirement, or pick a client' };

  let rows = PS.findProperties(req, d.unified, { now, minPct: filters.minPct || 50, includeVetoed });
  if (scope === 'unonboarded') rows = rows.filter(r => r.source !== 'onboarded');
  rows = PS.sortRows(PS.filterRows(rows, { ...filters, showRuledOut: true }), sort);
  const c2 = cut(rows); rows = c2.rows;
  const total = rows.filter(r => !r.vetoed).length, ruledOut = c2.out;
  const counts = rows.reduce((o, r) => { o[r.source] = (o[r.source] || 0) + 1; return o; }, {});
  rows = rows.slice(0, limit).map(r => shapeProperty(r, v, d.unified));
  return { mode, scope, reading, rows, total, ruledOut, counts };
}

// ── The endpoint ───────────────────────────────────────────────────────────
export async function matchPost(request) {
  let body;
  try { body = await request.clone().json(); } catch { return json({ error: 'Bad request' }, 400); }
  const user = await verifyCrmUser(request, { allowAgent: true });
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);
  const db = getDb();
  const action = body && body.action;
  try {
    const v = await viewerOf(db, user);
    // An agent needs Properties or the CRM (leads) in their access to match at all.
    if (v.agent && v.cfg && Array.isArray(v.cfg.tabs) && !v.cfg.tabs.some(t => ['properties', 'crm'].includes(t))) return json({ error: 'Matching is not part of your access' }, 403);

    if (action === 'search') {
      const out = await runSearch({ db, user, body, viewer: v });
      return json({ ok: !out.error, ...out });
    }

    if (action === 'interpret') {
      const text = String(body.text || '').slice(0, 2000);
      if (!text.trim()) return json({ error: 'Type something first' }, 400);
      const q = PS.parseSmartQuery(text);
      const req = PinMatch.briefProfile(q.text, {});
      const engine = { ...PS.explainReq(req), item: PS.itemFromProfile(req) };
      const ai = body.ai === false ? null : await structureText(text);
      return json({ ok: true, direction: q.direction, scope: q.scope, engine, ai: ai && ai.ok ? ai : null, aiError: ai && !ai.ok ? ai.error : null });
    }

    if (action === 'structure') {
      let text = String(body.text || '');
      let lead = null;
      if (body.leadId) {
        const d = await loadAll(db, user.tenantId);
        lead = leadOf(d, body.leadId);
        if (!lead) return json({ error: 'That lead is not here' }, 404);
        if (!canWork(v, lead)) return json({ error: 'That lead is not yours' }, 403);
        text = await caseFileOf(db, lead);
      }
      const ai = await structureText(text);
      // No AI: the engine's own reading, so the form still opens filled in.
      const fallback = (lead ? PinMatch.requirementProfiles(lead, {}) : [PinMatch.briefProfile(text, {})]).map(PS.itemFromProfile).map(PS.cleanItem).filter(Boolean);
      return json({ ok: true, items: ai.ok && ai.items.length ? ai.items : fallback, questions: ai.ok ? ai.questions : [], src: ai.ok ? 'ai' : 'engine', model: ai.model || null, aiError: ai.ok ? null : ai.error });
    }

    if (action === 'save-req') {
      const leadId = String(body.leadId || '');
      if (!leadId || leadId.includes('/')) return json({ error: 'Which lead?' }, 400);
      const ref = db.collection('leads').doc(leadId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().tenantId !== user.tenantId) return json({ error: 'That lead is not here' }, 404);
      const lead = { ...snap.data(), id: snap.id };
      if (!canWork(v, lead)) return json({ error: 'That lead is not yours' }, 403);
      const items = (Array.isArray(body.items) ? body.items : []).map(PS.cleanItem).filter(Boolean).slice(0, 5);
      const now = Date.now();
      const rev = ((lead.reqs && lead.reqs.rev) || 0) + 1;
      const reqs = items.length ? { items, src: 'reviewed', at: now, by: v.me, rev, fp: PinMatch.reqFingerprint(lead), aiModel: body.aiModel ? String(body.aiModel).slice(0, 60) : null } : null;
      // The lead's own fields (propertyInterest, budget…) are never touched: the reviewed version
      // lives beside them, and every version is kept.
      await writeLead(db, user.tenantId, ref, { reqs }, 'update');
      // What it was before: the last saved version, or — on a first save — how the CRM and the chat
      // read until now, so "Before" in History is never empty.
      let was = (lead.reqs && lead.reqs.items) || null;
      if (!was) { try { was = PinMatch.requirementProfiles(lead, {}).map(PS.itemFromProfile).map(PS.cleanItem).filter(Boolean); } catch (e) { was = null; } }
      await ref.collection('reqRevisions').doc('r' + String(rev).padStart(4, '0') + '_' + now).set({ at: now, by: v.me, byName: nameIn(v.team || [], v.me), src: 'reviewed', rev, items, was, wasSrc: lead.reqs ? 'reviewed' : 'crm' });
      const c = cache.get(user.tenantId); if (c) c.leadsAt = 0;
      return json({ ok: true, reqs });
    }

    if (action === 'req-history') {
      const leadId = String(body.leadId || '');
      const snap = leadId && !leadId.includes('/') ? await db.collection('leads').doc(leadId).get() : null;
      if (!snap || !snap.exists || snap.data().tenantId !== user.tenantId) return json({ error: 'That lead is not here' }, 404);
      if (!canWork(v, { ...snap.data(), id: snap.id }) && !(v.agent && AA.leadVisibleTo(snap.data(), v.me))) return json({ error: 'That lead is not yours' }, 403);
      const q = await snap.ref.collection('reqRevisions').orderBy('at', 'desc').limit(20).get();
      return json({ ok: true, revisions: q.docs.map(x => { const r = x.data(); return { id: x.id, ...r, byName: r.byName || (r.by === 'AI' ? 'AI (from the chat)' : nameIn(v.team || [], r.by || '')) }; }) });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error('match action failed:', action, e);
    return json({ error: 'Something went wrong — try again' }, 500);
  }
}

export { loadAll, viewerOf, shapeClient, shapeProperty };
