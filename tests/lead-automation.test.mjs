// ═══════ LEAD AUTOMATION — pipeline, attention, AI verdict, policy, runs ═══════
//
// The human rules under test: move forward only on evidence, never declare Won, respect a
// person's choice until the lead says something new, never repeat what a person undid, turn the
// team's due step into a follow-up, and surface everything that needs a person.
//
//   node tests/lead-automation.test.mjs

import {
  planPipelineMigration, stageKeyOf, stageKindOf, hasKeyedPipeline, stageForKey, STAGE_DEFS
} from '../crm-assets/pipeline.js';
import { computeAttention, needsAction, teamOwes } from '../crm-assets/leadAttention.js';
import { buildCaseFile, normaliseVerdict, classifyLead, LEAD_AI_SCHEMA } from '../api/_lead-ai.js';
import { decideLeadChanges, withinWorkingHours } from '../api/_lead-policy.js';
import { runLeadAutomation, queueLeadAutomation, claimQueued, finishQueued, drainQueue } from '../api/_lead-automation.js';
import { createFakeDb } from './_fake-firestore.mjs';

let passed = 0, failed = 0;
function check(label, condition, detail) {
  if (condition) { passed++; return true; }
  failed++;
  console.log(`  FAIL  ${label}${detail !== undefined ? ' — ' + detail : ''}`);
  return false;
}
const eq = (label, actual, expected) => check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
const section = name => console.log(`\n── ${name}`);

const HOUR = 3600000, DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T07:00:00Z'); // 12:30 PM IST, Monday
const T = 't_3pinrealty';

// The live pipeline as it was before the rework.
const LEGACY = [
  { id: 'new', name: 'New', color: '#1D4ED8' },
  { id: 'contacted', name: 'Contacted', color: '#B45309' },
  { id: 'site_visit', name: 'Site Visit', color: '#6D28D9' },
  { id: 'stage_1785076967037rpfq', name: 'Site Visit Done', color: '#6D28D9' },
  { id: 'negotiation', name: 'in Negotiation', color: '#B45309' },
  { id: 'closed_won', name: 'Closed', color: '#15803D' },
  { id: 'closed_lost', name: 'Not interested ', color: '#B91C1C' },
  { id: 'stage_1784965862574gi7k', name: 'Spam', color: '#DB2777' },
  { id: 'stage_17850144150550e6w', name: 'General', color: '#1D4ED8' },
  { id: 'stage_17850176740280xc3', name: 'Missed Calls', color: '#B45309' }
];

console.log('3 PIN Realty — lead automation');

// ───────────────────────────────────────────────────────────────────────────
section('Pipeline: migrating the live 10 columns');
const legacyLeads = [
  { id: 'a', stageId: 'contacted', detailsSent: true },
  { id: 'b', stageId: 'contacted', lastNote: { text: 'Coming for Site visit tomorrow. Timings yet to confirm.' } },
  { id: 'c', stageId: 'contacted', lastNote: { text: 'Tried calling her, Switched off' } },
  { id: 'd', stageId: 'site_visit', lastNote: { text: 'Visited the site wants to get feed back' } },
  { id: 'e', stageId: 'site_visit', lastNote: { text: 'Wants to view Kilpauk Orchids by 4pm on Sunday' } },
  { id: 'f', stageId: 'stage_1784965862574gi7k' },
  { id: 'g', stageId: 'stage_17850144150550e6w' },
  { id: 'h', stageId: 'stage_17850176740280xc3' },
  { id: 'i', stageId: 'closed_lost' },
  { id: 'j', stageId: 'closed_won' },
  { id: 'k', stageId: 'new' },
  { id: 'l', stageId: 'contacted', lastNote: { text: 'Location sent. Need to call her' } },
  { id: 'm', stageId: 'gone_stage' }
];
const plan = planPipelineMigration(LEGACY, legacyLeads);
eq('Eight columns in the reworked board', plan.stages.map(s => s.name), STAGE_DEFS.map(d => d.name));
check('Every stage carries its key and kind', plan.stages.every(s => s.key && s.kind));
check('Stage ids that already meant something are kept', ['new', 'site_visit', 'stage_1785076967037rpfq', 'negotiation', 'closed_won', 'closed_lost'].every(id => plan.stages.some(s => s.id === id)));
eq('Missing columns get new ids', [stageForKey(plan.stages, 'options').id, stageForKey(plan.stages, 'on_hold').id], ['options_shared', 'on_hold']);
eq('Non-stage columns are removed', plan.removed.map(r => r.name), ['Contacted', 'Spam', 'General', 'Missed Calls']);
check('The migrated pipeline is fully keyed', hasKeyedPipeline(plan.stages));
const moveOf = id => plan.moves.find(m => m.id === id);
eq('Contacted + details sent → Options shared', moveOf('a').toKey, 'options');
eq('Contacted + "site visit tomorrow" → Site visit pending', moveOf('b').toKey, 'visit_pending');
eq('Contacted + no evidence → New enquiry', moveOf('c').toKey, 'new');
eq('Site Visit + "Visited the site" → Site visit done', moveOf('d').toKey, 'visit_done');
check('Site Visit with a future visit stays (no move)', !moveOf('e'));
eq('Spam → Lost with reason spam', [moveOf('f').toKey, moveOf('f').lostReason], ['lost', 'spam']);
eq('General → New enquiry', moveOf('g').toKey, 'new');
eq('Missed Calls → New enquiry', moveOf('h').toKey, 'new');
eq('Not interested keeps its column and gains a reason', [moveOf('i').toStageId, moveOf('i').lostReason], ['closed_lost', 'not_interested']);
check('Won and New leads are not touched', !moveOf('j') && !moveOf('k'));
eq('Contacted + "Location sent" → Options shared', moveOf('l').toKey, 'options');
eq('A lead in a column that no longer exists → New enquiry', moveOf('m').toKey, 'new');
check('Every move says why', plan.moves.filter(m => m.fromStageId !== m.toStageId).every(m => m.reason));
const again = planPipelineMigration(plan.stages, legacyLeads.map(l => { const m = moveOf(l.id); return m ? { ...l, stageId: m.toStageId, lostReason: m.lostReason } : l; }));
eq('Migrating twice changes nothing', again.moves.length, 0);
eq('Legacy names resolve to keys', [stageKeyOf({ name: 'Closed' }), stageKeyOf({ name: 'Site Visit' }), stageKeyOf({ name: 'in Negotiation' }), stageKeyOf({ name: 'Custom' })], ['won', 'visit_pending', 'negotiation', null]);
eq('Spam reads as a lost kind even unkeyed', stageKindOf({ name: 'Spam' }), 'lost');
const STAGES = plan.stages;
const sid = key => stageForKey(STAGES, key).id;

// ───────────────────────────────────────────────────────────────────────────
section('AI verdict validation');
const good = {
  intent: 'buy', stage: 'visit_pending', confidence: 'high', evidence: '13 Sep: "Can we see TNAG0001 on Saturday?"',
  next_owner: 'team', next_action: 'Call to confirm Saturday visit to TNAG0001', next_kind: 'confirm_visit', next_due: '2026-09-14T17:00:00+05:30',
  visit_status: 'requested', visit_at: '2026-09-19T11:00:00+05:30', visit_property: 'TNAG0001',
  hold_reason: null, hold_until: null, lost_reason: null, urgency: 'high', status_line: 'Wants to see TNAG0001 Sat; confirm time'
};
const v = normaliseVerdict(good, NOW);
eq('Stage and confidence read', [v.stage, v.confidence], ['visit_pending', 'high']);
eq('Due time parsed from IST', v.next.dueAt, Date.parse('2026-09-14T17:00:00+05:30'));
eq('Visit time parsed', v.visit.at, Date.parse('2026-09-19T11:00:00+05:30'));
check('An unknown stage is rejected', normaliseVerdict({ ...good, stage: 'contacted' }, NOW) === null);
eq('A date years away is dropped', normaliseVerdict({ ...good, next_due: '2031-01-01T10:00:00+05:30' }, NOW).next.dueAt, null);
eq('No action means no owner', normaliseVerdict({ ...good, next_action: '' }, NOW).next.owner, 'none');
eq('A hold reason only survives on hold', normaliseVerdict({ ...good, hold_reason: 'postponed' }, NOW).holdReason, null);
check('Schema lists every stage key', JSON.stringify(LEAD_AI_SCHEMA.properties.stage.enum) === JSON.stringify(STAGE_DEFS.map(d => d.key)));
check('Schema is strict', LEAD_AI_SCHEMA.additionalProperties === false && LEAD_AI_SCHEMA.required.length === Object.keys(LEAD_AI_SCHEMA.properties).length);

const caseLead = { name: 'Rajesh Kumar', stageId: 'new', channel: 'whatsapp', enquiryType: 'Property Enquiry', propertyInterest: 'T Nagar', budget: '3 Cr', tt: { status: 'hot', integration: 'whatsapp' } };
const caseState = {
  profile: { stage_and_next_action: 'Actively looking. Next action: team to confirm visit.', activity_so_far: 'Brochure sent for TNAG0001.' },
  chat: [
    { role: 'user', content: 'Hi, is TNAG0001 available?', at: NOW - 2 * DAY },
    { role: 'assistant', content: 'Yes! Sharing the brochure.', at: NOW - 2 * DAY + 60000 },
    { role: 'user', content: 'Can we see it on Saturday?', at: NOW - DAY },
    { role: 'assistant', content: '<No response from agent>', at: NOW - DAY + 60000, meta: { type: 'no_response' } }
  ]
};
const cf = buildCaseFile({ lead: caseLead, state: caseState, notes: [{ text: 'Called, busy. Try evening.', createdAt: NOW - 3 * HOUR, by: 'thirumal@threepin.in' }], stages: STAGES, now: NOW });
check('Case file states the time in IST', /Now: .*IST/.test(cf));
check('Case file names the CRM stage', /CRM stage now: New/.test(cf));
check('Case file includes team notes with author', /\[.*thirumal\] Called, busy\. Try evening\./.test(cf));
check('Case file includes TailorTalk\'s own stage text', /Stage and next action \(TailorTalk's own AI\): Actively looking/.test(cf));
check('Case file marks a message the AI left for the team', /\(AI did not reply — left for the team\)/.test(cf));
check('Case file speaks the lead by first name', /Lead \(Rajesh\): Can we see it on Saturday\?/.test(cf));

// A fake Claude client that records the request.
function fakeClient(answer, { failBeta = false, stop = 'end_turn' } = {}) {
  const calls = [];
  const respond = params => {
    calls.push(params);
    return { model: params.model, stop_reason: stop, usage: { input_tokens: 1800, output_tokens: 240 }, content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }] };
  };
  return {
    calls,
    beta: { messages: { create: async p => { if (failBeta) { const e = new Error('fallbacks not allowed'); e.status = 400; throw e; } return respond(p); } } },
    messages: { create: async p => respond(p) }
  };
}

{
  const c = fakeClient(good);
  const r = await classifyLead({ client: c, model: 'claude-opus-5', caseFile: cf, now: NOW });
  check('Classification succeeds', r.ok, JSON.stringify(r));
  const p = c.calls[0];
  eq('Asks for low effort and a strict JSON schema', [p.output_config.effort, p.output_config.format.type], ['low', 'json_schema']);
  check('Uses server-side fallbacks for refusals', p.fallbacks === 'default' && p.betas.includes('server-side-fallback-2026-07-01'));
  {
    const sent = [];
    const fakeFetch = async (url, init) => {
      sent.push({ url, init: { ...init, body: JSON.parse(init.body) } });
      return { ok: true, status: 200, json: async () => ({ modelVersion: 'gemini-3.5-flash-lite', usageMetadata: { promptTokenCount: 1381, candidatesTokenCount: 250 }, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(good) }] } }] }) };
    };
    const g = await classifyLead({ model: 'gemini-3.5-flash-lite', caseFile: cf, now: NOW, gemini: { apiKey: 'test-key', fetchImpl: fakeFetch } });
    check('Gemini classification succeeds', g.ok && g.verdict.stage === 'visit_pending', JSON.stringify(g));
    check('Gemini gets the key in a header, never the URL', sent[0].init.headers['x-goog-api-key'] === 'test-key' && !/test-key/.test(sent[0].url));
    check('Gemini is asked for JSON in our schema with the same instructions', sent[0].init.body.generationConfig.responseMimeType === 'application/json' && JSON.stringify(sent[0].init.body.generationConfig.responseJsonSchema) === JSON.stringify(LEAD_AI_SCHEMA) && /sales coordinator at 3 PIN Realty/.test(sent[0].init.body.systemInstruction.parts[0].text));
    eq('Gemini usage is recorded', g.usage.input_tokens, 1381);
    const blocked = await classifyLead({ model: 'gemini-3.5-flash-lite', caseFile: cf, now: NOW, gemini: { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'SAFETY' }] }) }) } });
    eq('A Gemini safety block is reported, not applied', blocked.error, 'refused');
    eq('No Gemini key is reported clearly', (await classifyLead({ model: 'gemini-3.5-flash-lite', caseFile: cf, now: NOW, gemini: { apiKey: '' } })).error, 'GEMINI_API_KEY is not set');
  }
  const h = fakeClient(good);
  await classifyLead({ client: h, model: 'claude-haiku-4-5', caseFile: cf, now: NOW });
  check('Haiku is asked without effort or fallbacks (it rejects them)', !('effort' in h.calls[0].output_config) && !('fallbacks' in h.calls[0]) && h.calls[0].output_config.format.type === 'json_schema');
  const c2 = fakeClient(good, { failBeta: true });
  const r2 = await classifyLead({ client: c2, model: 'claude-opus-5', caseFile: cf, now: NOW });
  check('Falls back to a plain request if fallbacks are rejected', r2.ok && !('fallbacks' in c2.calls[0]));
  eq('A refusal is reported, not applied', (await classifyLead({ client: fakeClient(good, { stop: 'refusal' }), model: 'claude-haiku-4-5', caseFile: cf, now: NOW })).error, 'refused');
  eq('Garbage is reported, not applied', (await classifyLead({ client: fakeClient('not json'), model: 'claude-haiku-4-5', caseFile: cf, now: NOW })).error, 'unreadable answer');
}

// ───────────────────────────────────────────────────────────────────────────
section('Policy: the guardrails');
const verdict = (over = {}) => ({ ...normaliseVerdict(good, NOW), ...over, next: { ...normaliseVerdict(good, NOW).next, ...(over.next || {}) }, visit: { ...normaliseVerdict(good, NOW).visit, ...(over.visit || {}) } });
const ttLead = (over = {}) => ({
  id: 'L1', tenantId: T, name: 'Rajesh', stageId: sid('new'), source: 'tailortalk', createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY, createdBy: 'TailorTalk',
  tt: { id: 'x1', category: 'sales', integration: 'whatsapp', lastMessageAt: NOW - HOUR, lastReplyAt: NOW - HOUR + 60000 }, ...over
});
const decide = (lead, vd, now = NOW) => decideLeadChanges({ lead, verdict: vd, stages: STAGES, now, run: { model: 'claude-opus-5', chatLen: 10 } });

{
  const d = decide(ttLead(), verdict());
  eq('Forward on high confidence: New → Site visit pending', d.moved, { from: 'new', to: 'visit_pending' });
  eq('Stage written', d.patch.stageId, sid('visit_pending'));
  eq('Moved by the AI, not a person', d.patch.stageChangedBy, 'ai');
  check('updatedAt is never touched', !('updatedAt' in d.patch) && !('updatedBy' in d.patch));
  check('History explains the move with its evidence', /🤖 Moved from <b>New<\/b> to <b>Visit planned<\/b> — 13 Sep: &quot;Can we see TNAG0001 on Saturday\?&quot;/.test(d.history[0].text), d.history[0] && d.history[0].text);
  eq('Details sent is kept in step', d.patch.detailsSent, true);
  eq('The due step becomes the follow-up', d.patch.followUpAt, Date.parse('2026-09-14T17:00:00+05:30'));
  eq('…marked as set by the AI with the action', [d.patch.followUpBy, d.patch.followUpNote], ['ai', 'Call to confirm Saturday visit to TNAG0001']);
  eq('Last move is remembered for Undo', [d.patch.ai.lastMove.from, d.patch.ai.lastMove.to], ['new', 'visit_pending']);
}
{
  const d = decide(ttLead(), verdict({ stage: 'negotiation', confidence: 'medium' }));
  check('Medium confidence may not skip three stages', !d.moved && d.suggested === 'negotiation');
  const d2 = decide(ttLead(), verdict({ stage: 'options', confidence: 'medium' }));
  eq('Medium confidence may take one step', d2.moved, { from: 'new', to: 'options' });
  const d3 = decide(ttLead(), verdict({ stage: 'options', confidence: 'low' }));
  check('Low confidence does nothing, not even a suggestion', !d3.moved && !d3.suggested);
}
{
  const d = decide(ttLead({ stageId: sid('visit_done') }), verdict({ stage: 'options', confidence: 'high' }));
  check('Never moves backwards on its own', !d.moved);
  eq('…a confident backward read becomes a suggestion', d.suggested, 'options');
}
{
  const d = decide(ttLead({ stageId: sid('negotiation') }), verdict({ stage: 'won', confidence: 'high' }));
  check('Never declares Won', !d.moved && d.suggested === 'won');
}
{
  const personMoved = ttLead({ stageId: sid('options'), stageChangedAt: NOW - 30 * 60000, stageChangedBy: 'thirumal@threepin.in' });
  const d = decide(personMoved, verdict());
  check('A person\'s choice after the last message stands', !d.moved && d.suggested === 'visit_pending');
  const newsSince = ttLead({ stageId: sid('options'), stageChangedAt: NOW - 3 * HOUR, stageChangedBy: 'thirumal@threepin.in' });
  eq('…until the lead says something new', decide(newsSince, verdict()).moved, { from: 'options', to: 'visit_pending' });
}
{
  const undone = ttLead({ stageId: sid('new'), ai: { dismissed: { visit_pending: NOW - 30 * 60000 } } });
  const d = decide(undone, verdict());
  check('What a person undid is not repeated without news', !d.moved && !d.suggested);
  const withNews = ttLead({ stageId: sid('new'), ai: { dismissed: { visit_pending: NOW - 2 * HOUR } } });
  eq('…but is when the lead writes again', decide(withNews, verdict()).moved, { from: 'new', to: 'visit_pending' });
}
{
  const lostV = verdict({ stage: 'lost', confidence: 'high', lostReason: 'bought_elsewhere', next: { owner: 'none', action: null, dueAt: null } });
  const d = decide(ttLead({ stageId: sid('options') }), lostV);
  eq('Clear loss moves to Lost', [d.moved && d.moved.to, d.patch.lostReason], ['lost', 'bought_elsewhere']);
  check('No follow-up on a lost lead', !('followUpAt' in d.patch));
  const unsure = decide(ttLead({ stageId: sid('options') }), verdict({ stage: 'lost', confidence: 'high', lostReason: 'unreachable' }));
  check('Unreachable is only a suggestion', !unsure.moved && unsure.suggested === 'lost');
}
{
  const holdV = verdict({ stage: 'on_hold', confidence: 'high', holdReason: 'postponed', holdUntil: Date.parse('2026-09-30T10:00:00+05:30'), next: { owner: 'none', action: null, dueAt: null }, visit: { status: 'none', at: null } });
  const d = decide(ttLead({ stageId: sid('options') }), holdV);
  eq('Postponed → On hold with the date', [d.moved && d.moved.to, d.patch.holdUntil], ['on_hold', Date.parse('2026-09-30T10:00:00+05:30')]);
  eq('…and the revisit date becomes the follow-up', d.patch.followUpAt, Date.parse('2026-09-30T10:00:00+05:30'));
  const parked = ttLead({ stageId: sid('on_hold'), stageChangedAt: NOW - 5 * DAY, stageChangedBy: 'ai', holdUntil: Date.parse('2026-09-30T10:00:00+05:30'), tt: { id: 'x1', category: 'sales', lastMessageAt: NOW - HOUR } });
  const back = decide(parked, verdict({ stage: 'visit_pending', confidence: 'medium' }));
  eq('A parked lead who writes again is re-opened', back.moved, { from: 'on_hold', to: 'visit_pending' });
  check('…and the hold date is cleared', back.patch.holdUntil === null);
  const quiet = decide({ ...parked, tt: { id: 'x1', category: 'sales', lastMessageAt: NOW - 6 * DAY } }, verdict({ stage: 'visit_pending', confidence: 'high' }));
  check('…but not without a new message', !quiet.moved);
}
{
  const manual = { id: 'M1', tenantId: T, stageId: sid('visit_pending'), stageChangedAt: NOW - 10 * DAY, updatedBy: 'thirumal@threepin.in', createdAt: NOW - 20 * DAY, updatedAt: NOW - 2 * DAY, lastNote: { text: 'Visited the site, wants to think', createdAt: NOW - 2 * DAY } };
  const visitedV = verdict({ stage: 'visit_done', confidence: 'high', next: { owner: 'team', action: 'Call for feedback', kind: 'collect_feedback', dueAt: null }, visit: { status: 'done', at: null } });
  eq('A manual lead moves on a team note written after the stage was set', decide(manual, visitedV).moved, { from: 'visit_pending', to: 'visit_done' });
  const oldNote = { ...manual, lastNote: { text: 'Visited', createdAt: NOW - 12 * DAY } };
  check('…but not on a note older than the person\'s stage choice', !decide(oldNote, visitedV).moved);
}
{
  const d = decide(ttLead({ stageId: sid('won') }), verdict({ stage: 'lost', confidence: 'high', lostReason: 'not_interested' }));
  check('A won deal is never moved automatically', !d.moved);
  const vendor = decide(ttLead({ tt: { id: 'v', category: 'others', lastMessageAt: NOW - HOUR } }), verdict());
  check('Vendors and collaborations are never moved', !vendor.moved && vendor.skipped === 'vendor or collaboration');
  const legacy = decideLeadChanges({ lead: ttLead({ stageId: 'contacted' }), verdict: verdict(), stages: LEGACY, now: NOW });
  check('Nothing moves before the pipeline is reworked', !legacy.moved && legacy.skipped === 'pipeline not reworked yet');
}
{
  const personFu = ttLead({ followUpAt: NOW + 30 * 60000, followUpBy: 'thirumal@threepin.in', followUpSetAt: NOW - 2 * HOUR });
  const d = decide(personFu, verdict());
  check('An earlier follow-up a person set is kept', !('followUpAt' in d.patch));
  const laterPerson = ttLead({ followUpAt: NOW + 3 * DAY, followUpBy: 'thirumal@threepin.in', followUpSetAt: NOW - 30 * 60000 });
  check('A person\'s later follow-up set after the last message is kept', !('followUpAt' in decide(laterPerson, verdict()).patch));
  const laterStale = ttLead({ followUpAt: NOW + 3 * DAY, followUpBy: 'thirumal@threepin.in', followUpSetAt: NOW - 2 * DAY });
  eq('…but an earlier due step from newer messages replaces it', decide(laterStale, verdict()).patch.followUpAt, Date.parse('2026-09-14T17:00:00+05:30'));
  const noDue = decide(ttLead(), verdict({ next: { owner: 'team', action: 'Send TNAG0001 photos', kind: 'send_details', dueAt: null }, visit: { status: 'none', at: null } }));
  eq('No stated time → two working hours from now', noDue.patch.followUpAt, NOW + 2 * HOUR);
  const night = Date.parse('2026-09-14T17:00:00Z'); // 10:30 PM IST
  eq('Default due times respect working hours', new Date(withinWorkingHours(night + 2 * HOUR)).toISOString(), '2026-09-15T04:00:00.000Z');
  const visitSoon = decide(ttLead(), verdict({ next: { owner: 'lead', action: 'Confirm the time', kind: 'other', dueAt: null }, visit: { status: 'scheduled', at: NOW + 6 * HOUR } }));
  eq('A scheduled visit sets a confirmation two hours before', visitSoon.patch.followUpAt, NOW + 4 * HOUR);
}
{
  const first = decide(ttLead(), verdict());
  const acted = { ...ttLead(), ...first.patch, updatedAt: NOW + 10 * 60000 };
  const reread = decide(acted, verdict(), NOW + 20 * 60000);
  eq('The same step keeps its original time', reread.patch.ai.next.setAt, first.patch.ai.next.setAt);
  check('…so a person who already acted is not asked again', teamOwes({ ...acted, ai: reread.patch.ai }) === null);
  const changed = decide(acted, verdict({ next: { owner: 'team', action: 'Send the sale agreement draft', kind: 'paperwork', dueAt: null } }), NOW + 20 * 60000);
  check('A different step asks again', teamOwes({ ...acted, ai: changed.patch.ai }) !== null);
}

// ───────────────────────────────────────────────────────────────────────────
section('Attention: what needs a person');
const att = (lead, now = NOW) => computeAttention(lead, { stages: STAGES, now });
const keys = list => list.map(a => a.key);
{
  const owed = { ...ttLead({ stageId: sid('visit_pending') }), ai: { next: { owner: 'team', action: 'Call to confirm visit', dueAt: NOW - 2 * HOUR, setAt: NOW - 5 * HOUR } } };
  const list = att(owed);
  eq('An overdue promise is critical and first', [list[0].key, list[0].severity], ['promise_overdue', 'critical']);
  check('…and cleared once a person touches the lead', !keys(att({ ...owed, updatedAt: NOW - HOUR })).includes('promise_overdue'));
  const windowLead = { ...owed, ai: { next: { owner: 'team', action: 'Reply', dueAt: null, setAt: NOW - HOUR } }, tt: { ...owed.tt, lastMessageAt: NOW - 22 * HOUR } };
  check('Reply window closing is flagged', keys(att(windowLead)).includes('window_closing'));
  const visitPast = { ...ttLead({ stageId: sid('visit_pending'), updatedAt: NOW - 2 * DAY }), ai: { visit: { status: 'scheduled', at: NOW - 5 * HOUR } } };
  check('A visit time that passed asks for the outcome', keys(att(visitPast)).includes('visit_outcome'));
  const noTime = ttLead({ stageId: sid('visit_pending'), stageChangedAt: NOW - 2 * DAY });
  check('A pending visit with no time asks to fix one', keys(att(noTime)).includes('visit_unscheduled'));
  const doneQuiet = ttLead({ stageId: sid('visit_done'), stageChangedAt: NOW - 4 * DAY, updatedAt: NOW - 4 * DAY, tt: { id: 'x', category: 'sales', lastMessageAt: NOW - 4 * DAY, lastReplyAt: NOW - 4 * DAY } });
  check('A quiet visit-done lead asks for feedback', keys(att(doneQuiet)).includes('feedback_due'));
  const negQuiet = ttLead({ stageId: sid('negotiation'), stageChangedAt: NOW - 6 * DAY, updatedAt: NOW - 6 * DAY, tt: { id: 'x', category: 'sales', lastMessageAt: NOW - 5 * DAY, lastReplyAt: NOW - 5 * DAY } });
  check('A stalled negotiation is flagged', keys(att(negQuiet)).includes('negotiation_stalled'));
  const holdDue = ttLead({ stageId: sid('on_hold'), holdUntil: NOW - HOUR, updatedAt: NOW - 10 * DAY });
  check('A hold that has come due is flagged', keys(att(holdDue)).includes('hold_due'));
  const silent = { ...ttLead({ stageId: sid('options'), updatedAt: NOW - 5 * DAY, tt: { id: 'x', category: 'sales', lastMessageAt: NOW - 4 * DAY, lastReplyAt: NOW - 4 * DAY + HOUR } }), ai: { next: { owner: 'lead', action: 'Reply on brochure' } } };
  eq('A lead gone silent is a low-priority nudge', att(silent).find(a => a.key === 'lead_silent').severity, 'low');
  const manualStale = { id: 'm', stageId: sid('options'), createdAt: NOW - 60 * DAY, updatedAt: NOW - 50 * DAY };
  check('A manual lead untouched for weeks is flagged stale', keys(att(manualStale)).includes('stale'));
  check('…which alone is not "needs action"', !needsAction(manualStale, { stages: STAGES, now: NOW }));
  const lost = { ...owed, stageId: sid('lost') };
  check('Closed leads raise nothing', att(lost).length === 0);
  const waiting = ttLead({ tt: { id: 'x', category: 'sales', awaitingTeamAt: NOW - HOUR, lastMessageAt: NOW - HOUR } });
  check('A message the AI left for the team is flagged', keys(att(waiting)).includes('waiting_for_team'));
  const signal = ttLead({ tt: { id: 'x', category: 'sales', signals: { moment: { at: NOW - HOUR, quote: 'Call me at 5' } } } });
  check('An open key-moment signal is flagged with its words', att(signal).some(a => a.key === 'signal:moment' && a.detail === 'Call me at 5'));
  const suggestion = { ...ttLead(), ai: { suggestion: { stage: 'won', evidence: 'Token paid' } } };
  check('An AI suggestion is surfaced', att(suggestion).some(a => a.key === 'ai_suggestion' && /Won/.test(a.label)));
  const vendor = { ...ttLead({ followUpAt: NOW - HOUR }), tt: { id: 'v', category: 'others', awaitingTeamAt: NOW - HOUR } };
  eq('Vendors only raise their own follow-ups', keys(att(vendor)), ['followup_overdue']);
}

// ───────────────────────────────────────────────────────────────────────────
section('Runs on Firestore: apply, audit, debounce');
{
  const db = createFakeDb();
  db._store.set(`pipelines/${T}`, { stages: STAGES });
  db._store.set('leads/L1', ttLead());
  db._store.set('leads/L1/tailortalk/state', caseState);
  const client = fakeClient(good);

  const preview = await runLeadAutomation(db, T, 'L1', { client, model: 'claude-haiku-4-5', now: NOW, apply: false });
  check('Preview returns the decision', preview.preview && preview.moved && preview.moved.to === 'visit_pending');
  eq('…and writes nothing', db._get('leads/L1').stageId, sid('new'));

  const r = await runLeadAutomation(db, T, 'L1', { client, model: 'claude-haiku-4-5', now: NOW, trigger: 'test' });
  check('Apply moves the lead', r.ok && db._get('leads/L1').stageId === sid('visit_pending'));
  check('The AI verdict is stored on the lead', db._get('leads/L1').ai.line === 'Wants to see TNAG0001 Sat; confirm time');
  eq('History entries by the AI', db._list('leads/L1/history').map(p => db._get(p).by), ['AI', 'AI']);
  const runs = db._list('leads/L1/aiRuns');
  eq('One run logged', runs.length, 1);
  const run = db._get(runs[0]);
  check('The run log records input size, verdict, change and cost', run.input.messages === 4 && run.verdict.stage === 'visit_pending' && run.moved.to === 'visit_pending' && run.usage.input === 1800 && run.trigger === 'test', JSON.stringify(run));

  db._store.set('leads/V1', { ...ttLead({ id: 'V1' }), tt: { id: 'v', category: 'others' } });
  eq('Vendors are skipped before any AI call', (await runLeadAutomation(db, T, 'V1', { client, model: 'claude-haiku-4-5', now: NOW })).skipped, 'vendor or collaboration');
  db._store.set('leads/M0', { id: 'M0', tenantId: T, stageId: sid('new') });
  eq('A lead with nothing to read is skipped', (await runLeadAutomation(db, T, 'M0', { client, model: 'claude-haiku-4-5', now: NOW })).skipped, 'nothing to read');

  const bad = await runLeadAutomation(db, T, 'L1', { client: fakeClient('nope'), model: 'claude-haiku-4-5', now: NOW + HOUR });
  check('A failed read records the error without changing the stage', !bad.ok && db._get('leads/L1').ai.error === 'unreadable answer' && db._get('leads/L1').stageId === sid('visit_pending'));

  // A person moves the lead while the AI is reading — the write-time decision respects it.
  db._store.set('leads/L2', ttLead({ id: 'L2' }));
  db._store.set('leads/L2/tailortalk/state', caseState);
  const personMovesDuringRead = async p => { db._store.set('leads/L2', { ...db._get('leads/L2'), stageId: sid('options'), stageChangedAt: NOW + 1000, stageChangedBy: 'thirumal@threepin.in' }); return fakeClient(good).messages.create(p); };
  const racing = { beta: { messages: { create: personMovesDuringRead } }, messages: { create: personMovesDuringRead } };
  await runLeadAutomation(db, T, 'L2', { client: racing, model: 'claude-haiku-4-5', now: NOW + 2000 });
  eq('A person\'s move during the AI read is kept', db._get('leads/L2').stageId, sid('options'));

  // Debounce.
  await queueLeadAutomation(db, T, 'L1', { now: NOW, delayMs: 30000 });
  check('Not claimable before the quiet period ends', (await claimQueued(db, 'L1', NOW + 10000)) === null);
  await queueLeadAutomation(db, T, 'L1', { now: NOW + 20000, delayMs: 30000 });
  check('A newer message pushes the run back', (await claimQueued(db, 'L1', NOW + 35000)) === null);
  const claimed = await claimQueued(db, 'L1', NOW + 51000);
  eq('Claimable once quiet', claimed, NOW + 50000);
  check('Only one worker can claim it', (await claimQueued(db, 'L1', NOW + 52000)) === null);
  await queueLeadAutomation(db, T, 'L1', { now: NOW + 53000, delayMs: 30000 });
  await finishQueued(db, 'L1', claimed);
  check('A message during the run keeps the lead queued', !!db._get('aiQueue/L1'));
  const drained = await drainQueue(db, T, { client, model: 'claude-haiku-4-5', now: NOW + 90000 });
  check('The queue drains what is due', drained.ran === 1 && !db._get('aiQueue/L1'), JSON.stringify(drained));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
