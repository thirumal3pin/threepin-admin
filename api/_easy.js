import Anthropic from '@anthropic-ai/sdk';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { writeLead } from './_lead-views.js';
import { computeAttention, SEVERITY_RANK, isBusinessLead } from '../crm-assets/leadAttention.js';
import { stageKindOf, visitOf, VISIT_STATUS } from '../crm-assets/pipeline.js';
import * as TM from '../shared-assets/task-model.js';
import * as ED from './_easy-data.js';
// The CRM's match engine, the same file the match panels run (plain scripts that attach to globalThis).
import '../dashboard-assets/search-engine.js';
import '../shared-assets/chennai-geo.js';
import '../shared-assets/area-model.js';
import '../shared-assets/match-engine.js';

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
const C = { drafts: 'easyDrafts', changes: 'easyChanges', gaps: 'easyGaps', audit: 'easyAudit' };

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
  { name: 'search_leads', description: 'Find leads by any words — name, phone, area, budget, configuration, source, stage name. Every word must match. Empty query lists the most recently touched. cold_days lists only open leads untouched for at least that many days.', input_schema: obj({ query: S('Words to match, e.g. "velachery 3bhk" or "shiva"'), cold_days: { type: 'integer', description: 'Only leads untouched for at least this many days' } }) },
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
  { name: 'team_overview', description: "MVP-16, for the admin: each agent's day — visits today, follow-ups due, messages drafted / opened / confirmed sent this week, pending changes, open seller-detail asks. Refused for non-admins.", input_schema: obj({}) }
];

const SYSTEM = `You are Eåsy by 3 PIN (spoken "easy"), the assistant inside 3 PIN Realty's CRM in Chennai. The people asking are 3 PIN's own team: agents and the admin. Agents often ask while on a call with a client, so be quick and to the point.

Answer only from what your tools return. If the tools do not have it, say the record doesn't hold that detail; never guess a name, number, price or date. When a name matches more than one lead or property, ask one short question listing the options instead of picking one. Read dates in Indian time: "Saturday 11" is the coming Saturday at 11:00, "tomorrow 2" is 14:00.

You read, you draft, and you prepare changes. You never send anything and never change a record yourself:
- Any message for a lead or a property owner goes through draft_message (or ask_owner_for_missing), one per person, never as text in your reply. Then say in one line what you drafted.
- Adding or changing a property, and saving a note, go through the propose_ tools; the agent confirms on the card. Say what you prepared in one line; do not ask "shall I?" — the card asks.
Write drafts the way a polite Chennai agent writes on WhatsApp, in Tamil if the person writes in Tamil. Never put an owner's phone number in a message to a lead, and never share a property's exact address with a lead — area and landmark only.

Keep answers short and scannable: a line or two, then a short list if needed. Use ₹ and Indian number style (L, Cr). When you name a lead, add its id in this exact form so the page can link it: [lead:THE_ID].`;

// ── The tools ─────────────────────────────────────────────────────────────

function makeTools(db, user, now, out) {
  let leadsP, stagesP, propsP, cfgP;
  const T = user.tenantId;
  const stages = () => stagesP || (stagesP = db.collection('pipelines').doc(T).get().then(s => (s.exists ? s.data().stages : null) || []));
  const leads = () => leadsP || (leadsP = db.collection('leads').where('tenantId', '==', T).get().then(s => s.docs.map(d => ({ ...d.data(), id: d.id }))));
  const props = () => propsP || (propsP = db.collection('properties').where('tenantId', '==', T).get().then(s => s.docs.map(d => ({ ...d.data(), id: d.id }))));
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
      return { you: user.email, plan: plan.map(p => ({ time: p.time, priority: p.priority, title: p.title, detail: p.detail || null, leadId: p.leadId || null })) };
    },

    async search_leads({ query, cold_days } = {}) {
      const [ls, st] = await Promise.all([leads(), stages()]);
      let list = ls;
      if (cold_days) list = list.filter(l => !['won', 'lost'].includes(kindOf(l, st)) && (now - (l.updatedAt || 0)) >= cold_days * 86400000);
      const rows = list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(l => leadRow(l, st)).filter(r => matches(r, wordsOf(query)));
      return { total: rows.length, leads: rows.slice(0, MAX_ROWS) };
    },

    async lead_summary({ id }) {
      const ref = db.collection('leads').doc(String(id || ''));
      const snap = await ref.get();
      if (!snap.exists || snap.data().tenantId !== T) return { error: 'No such lead' };
      const lead = { ...snap.data(), id: snap.id };
      const [st, list, notes, chat] = await Promise.all([
        stages(), props(), notesOf(ref),
        ref.collection('tailortalk').doc('state').get()
          .then(s => ((s.exists && s.data().chat) || []).filter(m => m && m.content).slice(-6)
            .map(m => ({ from: m.role === 'user' ? 'lead' : m.role === 'human_agent' ? 'team' : 'bot', text: String(m.content).slice(0, 400) })))
          .catch(() => [])
      ]);
      const best = PinMatch.propertiesFor(lead, list, { now, minPct: 55, limit: 3 })
        .map(m => ({ code: codeOf(m.p), name: m.p.name || null, price: PinMatch.priceLabel(m.property) || null, match: m.pct + '%', why: (m.for || []).slice(0, 2).map(f => f.why) }));
      return { ...leadRow(lead, st), latestChat: chat, notes: notes.map(n => ({ at: istDate(n.createdAt), by: n.by || n.author || null, text: String(n.text || '').slice(0, 500) })), matchedProperties: best };
    },

    async search_properties({ query } = {}) {
      const rows = (await props()).map(propertyRow).filter(r => matches(r, wordsOf(query)));
      return { total: rows.length, properties: rows.slice(0, MAX_ROWS) };
    },

    async property_summary({ code }) {
      const p = await findProperty(code);
      if (!p) return { error: `No property ${code}` };
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
      const [ls, list, st] = await Promise.all([leads(), props(), stages()]);
      const all = PinMatch.buyersFor(p, ls, {
        inventory: list, now, minPct: 55, limit: 40,
        stageKeyOf: l => { const k = kindOf(l, st); return k === 'won' || k === 'lost' ? k : null; }
      });
      const row = m => ({
        id: m.lead.id, name: m.lead.name || null, match: m.pct + '%',
        wants: [m.lead.propertyInterest, m.lead.budget && 'budget ' + m.lead.budget].filter(Boolean).join(' · ') || null,
        heat: m.lead.tt && m.lead.tt.status ? m.lead.tt.status : null,
        lastContact: istDate((m.lead.tt && m.lead.tt.lastMessageAt) || m.lead.updatedAt),
        why: (m.for || []).slice(0, 2).map(f => f.why), against: (m.against || []).slice(0, 1).map(f => f.why)
      });
      return { property: propertyRow(p), matches: all.filter(m => m.pct >= 70).slice(0, 15).map(row), nearMatches: all.filter(m => m.pct < 70).slice(0, 10).map(row) };
    },

    async draft_message({ to, lead_id, code, text }) {
      return saveDraft({ to, leadId: lead_id, property: to === 'owner' ? await findProperty(code) : null, text });
    },

    async ask_owner_for_missing({ code, fields, text }) {
      const p = await findProperty(code);
      if (!p) return { error: `No property ${code}` };
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
        const snap = await db.collection('leads').doc(String(lead_id)).get();
        if (!snap.exists || snap.data().tenantId !== T) return { error: 'No such lead' };
        lead = { id: snap.id, name: snap.data().name || 'lead' };
      }
      if (code) { p = await findProperty(code); if (!p) return { error: `No property ${code}` }; }
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
      if (p.brochureLink) { out.links.push({ label: `Brochure — ${codeOf(p)}`, url: p.brochureLink }); return { code: codeOf(p), brochure: p.brochureLink, shownAsLink: true }; }
      return { code: codeOf(p), brochure: null, note: 'No brochure on this property yet. New brochures come from the brochure pipeline; the photos link and highlights should be filled first.', missing: ED.completeness(p).missing };
    },

    async seller_summaries({ code } = {}) {
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
    const list = await db.collection('properties').where('tenantId', '==', T).get().then(s => s.docs.map(d => d.data()));
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

/** One Eåsy request, given the database, the signed-in user and the body. Returns [object, status]. */
export async function easyHandle({ db, user, body, now = Date.now() }) {
  body = body || {};
  if (body.action === 'ping') return [{ enabled: true }, 200];

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
    await c.ref.set({ status: r.error ? 'failed' : 'applied', decidedAt: Date.now(), result: r.error || r.done }, { merge: true });
    return [r.error ? { error: r.error } : { ok: true, status: 'applied', done: r.done }, r.error ? 409 : 200];
  }

  // Reminders the page polls for (MVP-11 visit, MVP-12 follow-up, MVP-13 gist).
  if (body.action === 'reminders') {
    const T = user.tenantId;
    const [ls, st, ps] = await Promise.all([
      db.collection('leads').where('tenantId', '==', T).get().then(s => s.docs.map(d => ({ ...d.data(), id: d.id }))),
      db.collection('pipelines').doc(T).get().then(s => (s.exists ? s.data().stages : null) || []),
      db.collection('properties').where('tenantId', '==', T).get().then(s => s.docs.map(d => ({ ...d.data(), id: d.id })))
    ]);
    const due = ED.remindersDue({ leads: ls, stages: st, properties: ps, email: user.email, now });
    // The gist carries the lead's last notes.
    await Promise.all(due.filter(r => r.kind === 'gist').map(async r => {
      const notes = await db.collection('leads').doc(r.leadId).collection('notes').orderBy('createdAt', 'desc').limit(2).get().then(s => s.docs.map(d => d.data())).catch(() => []);
      r.gist.lead.lastNotes = notes.map(n => n.text);
    }));
    return [{ reminders: due, at: now }, 200];
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
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }, { type: 'text', text: `Now: ${istNow(now)} (IST). Asked by ${user.email}.` + (body.voice
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
          console.error('easy: tool failed', b.name, e);
          return { type: 'tool_result', tool_use_id: b.id, content: 'That lookup failed: ' + (e.message || 'error'), is_error: true };
        }
      }));
      messages.push({ role: 'user', content: results });
    }
    return done('That took too many steps — try asking it in a simpler way.');
  } catch (e) {
    console.error('easy: failed', e);
    const status = e instanceof Anthropic.RateLimitError ? 429 : 502;
    return [{ error: status === 429 ? 'Eåsy is busy — try again in a minute' : 'Eåsy could not answer just now' }, status];
  }
}

export async function easyPost(request) {
  if (!easyEnabled()) return json({ disabled: true, error: 'Eåsy is switched off' }, 503);
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const [o, status] = await easyHandle({ db: getDb(), user, body });
  return json(o, status);
}
