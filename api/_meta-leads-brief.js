// ═══════════════════════════════════════════════════════════════════════
// META ADS LEADS — the AI brief for one person (POST /api/meta-leads, actions 'brief' / 'briefs').
//
// What an agent needs before the call, read from everything we have on the person: the ad form's
// answers (each enquiry), what the team wrote in the sheet (Remarks, Follow up 1, 2 … — undated
// cells, oldest left), and, when they are already a CRM lead, the CRM record, its notes and the
// TailorTalk chat. The reading itself is the CRM's own lead AI (api/_lead-ai.js — the same
// prompt, JSON schema and validation the lead automation uses), so a stage, a next step, a loss
// reason or a requirement means the same thing here as on the CRM board.
//
// Runs on Claude Haiku 4.5 — the Claude the CRM already uses (the owner's choice, 7 Nov 2026), with
// the lead automation's own key when it is set, else the CRM summaries' key. Capped per day (IST)
// so a burst of new leads cannot run up the bill; over the cap a brief waits for the next day.
// Nothing is written to the sheet or the CRM.
//
//   metaLeadBriefs/{tenant}  { b: { [id]: { k, sig, key, at, model, v, src, err } }, day, runs }
//     id   — a hash of the person's key (phone or email), safe as a field name
//     sig  — the page's own hash of what it sent: when the sheet changes, the page asks again
//     key  — the server's hash of the whole case file (incl. the CRM side): same key, same answer
//     v    — the validated verdict (normaliseVerdict); err — why the last read failed
//
// Firestore cost: 'briefs' 1 read; 'brief' 1 read (+3 for a CRM lead) and, when read, 1 write.
// ═══════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { buildCaseFile, classifyLead, redact, fmtIstLong, LEAD_AI_CLAUDE_MODEL, LEAD_AI_SYSTEM, LEAD_AI_SCHEMA, LEAD_AI_VERSION } from './_lead-ai.js';

export const BRIEFS = 'metaLeadBriefs';
export const BRIEF_VERSION = 1;
export const BRIEF_MODEL = LEAD_AI_CLAUDE_MODEL;   // Claude Haiku 4.5, as the CRM's lead reading on Claude
// Reads a day (IST). ~5,000 tokens in and ~200 out — about $0.006 a read, so 50 is at most ~$0.30 a
// day. Briefs are read only when a lead is opened (or "Read again"), never in the background.
export const BRIEF_DAILY_CAP = Number(process.env.META_BRIEF_DAILY_CAP) || 50;
const istDay = t => new Date(t + 5.5 * 3600000).toISOString().slice(0, 10);
let _claude;
export function briefClaude() {
  const apiKey = process.env.LEAD_AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_claude) _claude = new Anthropic({ apiKey });
  return _claude;
}

const MAX_ROWS = 12, MAX_ANSWERS = 12, MAX_NOTES = 12;
const clip = (s, n) => { const t = redact(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const shortName = name => { const w = String(name || '').trim().split(/\s+/); return (/^(dr|mr|mrs|ms|miss)\.?$/i.test(w[0]) ? w.slice(0, 2) : w.slice(0, 1)).join(' '); };
const sha = s => createHash('sha256').update(s).digest('hex');
export const briefId = personKey => sha(String(personKey || '')).slice(0, 16);
const PROMPT_KEY = sha(`${LEAD_AI_VERSION}\n${BRIEF_VERSION}\n${LEAD_AI_SYSTEM}\n${JSON.stringify(LEAD_AI_SCHEMA)}`).slice(0, 12);

/** What the page sends, made safe and small: the person, their enquiries, the sheet's notes. */
export function cleanPerson(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const rows = (Array.isArray(p.rows) ? p.rows : []).slice(-MAX_ROWS).map(r => ({
    at: Number(r && r.at) || 0,
    code: clip(r && r.code, 20), where: clip(r && r.where, 120), tag: clip(r && r.tag, 40), tabNote: clip(r && r.tabNote, 200),
    ad: clip(r && r.ad, 80), platform: clip(r && r.platform, 20), form: clip(r && r.form, 80),
    answers: (Array.isArray(r && r.answers) ? r.answers : []).slice(0, MAX_ANSWERS).map(a => [clip(a && a[0], 80), clip(a && a[1], 160)]).filter(a => a[0] && a[1]),
    assigned: clip(r && r.assigned, 60), rating: clip(r && r.rating, 20),
    notes: (Array.isArray(r && r.notes) ? r.notes : []).slice(0, MAX_NOTES).map(n => [clip(n && n[0], 40), clip(n && n[1], 400)]).filter(n => n[1])
  })).sort((a, b) => a.at - b.at);
  return {
    k: String(p.k || '').slice(0, 200), sig: String(p.sig || '').slice(0, 40),
    name: clip(p.name, 60), crmId: String(p.crmId || '').slice(0, 100),
    props: (Array.isArray(p.props) ? p.props : []).slice(0, 8).map(x => ({ code: clip(x && x.code, 20), name: clip(x && x.name, 80) })),
    rows
  };
}

/**
 * The case file for one ad lead: how to read it, the ad enquiries with the sheet's notes, and the
 * CRM's own case file when they are a CRM lead.
 */
export function buildMetaCaseFile({ person, lead, state, notes, stages, now }) {
  const L = [];
  L.push(`Now: ${fmtIstLong(now)} IST`, '');
  L.push('HOW TO READ THIS FILE');
  L.push('- This person enquired through a Meta (Facebook / Instagram) lead ad: they filled the ad\'s form, and the form\'s answers are what they told us. The team then called them and wrote what happened in the lead sheet.');
  L.push('- Sheet notes have no timestamps. In each row they were written left to right, oldest first: Remarks, then Follow up 1, 2, 3 … A later enquiry\'s notes are newer than an earlier one\'s.');
  L.push('- A date written inside a note — "(24/10)", "(7 Nov)", "Nov9", "9th" — is day/month, this year unless it says otherwise, and dates the note. Resolve "Monday", "tomorrow" or "next week" only against a date written in the same note or the note before it; with no such date, next_due is null.');
  L.push('- "RNR", "not answering", "no answer", "busy", "switched off" mean the call did not get through: the lead has not reached a new milestone — the team calls again.');
  L.push('- A rating is the team\'s own 1–5 score of the lead (5 = best, 1 = weakest), not something the lead said.');
  L.push('- Someone filling the form again for the same property (a repeat enquiry) is renewed interest.');
  L.push('');
  L.push('LEAD');
  L.push(`Name: ${clip(shortName(person.name) || 'Unknown', 40)}`);
  L.push(`Channel: Meta lead ad${person.rows.some(r => r.platform) ? ' (' + [...new Set(person.rows.map(r => r.platform).filter(Boolean))].join(', ') + ')' : ''}`);
  if (person.props.length) L.push(`Properties enquired about: ${person.props.map(x => x.code + (x.name ? ' (' + x.name + ')' : '')).join('; ')}`);
  L.push('');
  L.push(`AD ENQUIRIES (${person.rows.length}, oldest first):`);
  person.rows.forEach((r, i) => {
    L.push(`${i + 1}. [${r.at ? fmtIstLong(r.at) : 'date unknown'}] ${r.code || ''}${r.ad ? ' · ad: ' + r.ad : ''}${r.form ? ' · form: "' + r.form + '"' : ''}${r.where ? ' · sheet: ' + r.where : ''}${r.tag ? ' (' + r.tag + ')' : ''}`);
    if (r.tabNote) L.push(`   About this sheet tab: ${r.tabNote}`);
    if (r.answers.length) L.push(`   Form answers: ${r.answers.map(a => a[0] + ': ' + a[1]).join('; ')}`);
    const team = [r.assigned ? 'assigned to ' + r.assigned : '', r.rating ? 'rating ' + r.rating + '/5' : ''].filter(Boolean).join(' · ');
    if (team) L.push(`   Team: ${team}`);
    if (r.notes.length) r.notes.forEach(n => L.push(`   ${n[0] || 'Note'}: ${n[1]}`));
    else L.push('   Notes: none written yet (not contacted, or not recorded).');
  });
  L.push('');
  if (lead) {
    L.push('CRM RECORD — this person is also a lead in the CRM; its file follows (team notes and chat there are dated and are the latest word):');
    L.push(buildCaseFile({ lead, state, notes, stages, now }).split('\n').filter(l => !/^Now: /.test(l)).join('\n'));
  } else {
    L.push('CRM: not a CRM lead yet.');
    L.push('CONVERSATION: none recorded — judge from the ad form answers and the sheet notes.');
  }
  return L.join('\n');
}

const keyOf = (caseFile, model) => sha(JSON.stringify([PROMPT_KEY, model, caseFile.split('\n').filter(l => !/^Now: /.test(l)).join('\n')])).slice(0, 24);
const briefRef = (db, T) => db.collection(BRIEFS).doc(T);

/** 'briefs': every stored brief of the tenant, by person key. */
export async function briefsAction(user, deps) {
  const snap = await briefRef(deps.db, user.tenantId).get();
  const b = (snap.exists && snap.data().b) || {};
  const out = {};
  for (const e of Object.values(b)) if (e && e.k) out[e.k] = e;
  return [{ ok: true, briefs: out }, 200];
}

/** 'brief': read one person (or answer from the stored brief when nothing has changed). */
export async function briefAction(user, body, deps) {
  const T = user.tenantId, db = deps.db, now = deps.now();
  const person = cleanPerson(body.person);
  if (!person.k || !person.rows.length) return [{ ok: false, error: 'Nothing to read for this lead' }, 400];
  const id = briefId(person.k);

  // The CRM side, when they are a CRM lead of this tenant: the record, its notes, the chat.
  let lead = null, state = null, notes = [], stages = [];
  if (person.crmId) {
    const ref = db.collection('leads').doc(person.crmId);
    const [ls, ss, ns, ps] = await Promise.all([ref.get(), ref.collection('tailortalk').doc('state').get(), ref.collection('notes').get(), db.collection('pipelines').doc(T).get()]);
    if (ls.exists && ls.data().tenantId === T) {
      lead = ls.data();
      state = ss.exists ? ss.data() : null;
      notes = ns.docs.map(d => d.data()).filter(n => n && n.by !== 'TailorTalk');
      stages = ps.exists ? (ps.data().stages || []) : [];
    }
  }
  const model = BRIEF_MODEL;
  const caseFile = buildMetaCaseFile({ person, lead, state, notes, stages, now });
  const key = keyOf(caseFile, model);
  const src = {
    rows: person.rows.length, notes: person.rows.reduce((n, r) => n + r.notes.length, 0),
    crm: !!lead, crmNotes: notes.length, chat: state && Array.isArray(state.chat) ? state.chat.length : 0
  };

  const snap = await briefRef(db, T).get();
  const doc = snap.exists ? snap.data() : {};
  const prev = doc.b ? doc.b[id] : null;
  // Nothing new since the last read: the same answer, at no cost. A failed read is tried again.
  if (prev && prev.key === key && !prev.err && !body.force) {
    if (prev.sig !== person.sig) await briefRef(db, T).set({ b: { [id]: { ...prev, sig: person.sig } } }, { merge: true });
    return [{ ok: true, brief: { ...prev, sig: person.sig }, cached: true }, 200];
  }

  // The day's cap: over it, the brief waits for tomorrow (the page stops asking for the rest).
  const day = istDay(now), runs = doc.day === day ? (doc.runs || 0) : 0;
  if (runs >= BRIEF_DAILY_CAP) return [{ ok: false, capped: true, error: `Today's ${BRIEF_DAILY_CAP} AI reads are used — the rest are read tomorrow`, brief: prev || null }, 200];

  let answer;
  try { answer = await deps.classify({ client: deps.claude ? deps.claude() : briefClaude(), model, caseFile, now }); }
  catch (e) { answer = { ok: false, error: String((e && e.message) || e).slice(0, 200), model }; }

  const entry = answer.ok
    ? { k: person.k, sig: person.sig, key, at: now, model: answer.model || model, v: answer.verdict, src, err: null }
    : { k: person.k, sig: person.sig, key: prev && prev.key || '', at: prev && prev.at || 0, model, v: prev && prev.v || null, src, err: String(answer.error || 'failed').slice(0, 200), errAt: now };
  await briefRef(db, T).set({ b: { [id]: entry }, day, runs: runs + 1 }, { merge: true });
  return [{ ok: answer.ok, brief: entry, ...(answer.ok ? {} : { error: entry.err }) }, 200];
}

export const defaultClassify = classifyLead;
