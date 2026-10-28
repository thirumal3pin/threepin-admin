// ═══════ EÅSY — the MVP, end to end on the in-memory Firestore ═══════
//
//   node tests/easy.test.mjs
//
// The real api/_easy.js handler over tests/fake-firestore.mjs seeded with tests/fixtures/easy-seed.mjs.
// The model is a scripted stand-in (no API call, no cost): each scenario says which tools "Claude"
// calls, and the test checks what the tools return and what lands in the database — which is the
// part Eåsy owns. Feature ids are the Requirements Document's (MVP-01 … MVP-16).

import { makeStore, adminDb } from './fake-firestore.mjs';
import { rebuildLeadViews } from '../api/_lead-views.js';
import { easySeed, T, AGENT, AGENT2 } from './fixtures/easy-seed.mjs';
import * as ED from '../api/_easy-data.js';
import { easyHandle, setEasyClient, waDigits, easyEnabled } from '../api/_easy.js';

let passed = 0, failed = 0;
const check = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); } };
const section = s => console.log('\n── ' + s);
console.log('3 PIN Realty — Eåsy');

const NOW = Date.UTC(2026, 9, 28, 6, 0);        // Wed 28 Oct 2026, 11:30 IST
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const { docs, props } = easySeed(NOW);
const store = makeStore();
for (const [p, d] of Object.entries(docs)) store.set(p, d);
const db = adminDb(store);
const leadsNow = () => [...store.docs].filter(([p]) => /^leads\/[^/]+$/.test(p)).map(([p, d]) => ({ ...d, id: p.split('/')[1] }));
await rebuildLeadViews(db, T, leadsNow(), NOW);
const stages = docs['pipelines/' + T].stages;
const ME = { email: AGENT, email_verified: true, tenantId: T };
const OTHER = { email: AGENT2, email_verified: true, tenantId: T };

// ── The stand-in model ──
let script = [], requests = [], n = 0;
const create = async req => { requests.push(JSON.parse(JSON.stringify(req))); const s = script.shift(); if (!s) throw new Error('script ran out'); return typeof s === 'function' ? s(req) : s; };
setEasyClient({ messages: { create } });
const use = (...calls) => ({ stop_reason: 'tool_use', content: calls.map(([name, input]) => ({ type: 'tool_use', id: 'tu' + (++n), name, input })) });
const say = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
// What the tools answered, from the request the handler sent after running them.
const results = () => { const last = requests[requests.length - 1].messages.at(-1); return last.content.map(c => ({ ok: !c.is_error, v: c.is_error ? c.content : JSON.parse(c.content) })); };
async function chat(user, text, steps) {
  script = steps; requests = [];
  const [o, status] = await easyHandle({ db, user, body: { history: [{ role: 'user', text }] }, now: NOW });
  return { o, status };
}
// One tool, then "Claude" answers: returns the tool's result and the response.
async function tool(name, input, user = ME) {
  let r;
  const res = await chat(user, 'x', [use([name, input]), () => { r = results()[0]; return say('done'); }]);
  return { r: r && r.v, ok: r && r.ok, ...res };
}

// ═══════ Pure parts ═══════
section('Completeness, codes, phone numbers');
check('A property with nothing is 0% and lists all seven mandatory fields', ED.completeness({}).pct === 0 && ED.completeness({}).missing.length === 7);
check('…a full one is 100%', ED.completeness({ contactName: 'a', contactNumber: '1', location: 'x', type: 'Flat', config: '2BHK', startingPrice: '1 Cr', photosLink: 'l' }).pct === 100);
check('The next code for an area follows the highest one there', ED.nextCode('Medavakkam, Chennai', [{ propertyCode: 'MED001' }, { propertyCode: 'MED004' }, { propertyCode: 'VEL009' }]) === 'MED005');
check('…and starts at 001 for a new area', ED.nextCode('Kodambakkam', [{ propertyCode: 'MED001' }]) === 'KOD001');
check('A 10-digit number gets +91 for wa.me', waDigits('98400 12345') === '919840012345');
check('…a leading 0 is dropped', waDigits('098400 12345') === '919840012345');
check('…junk is refused', waDigits('123') === null);
check('Eåsy is on unless EASY_DISABLED says otherwise', easyEnabled() === true);

section('MVP-10 — the day plan');
const plan = ED.buildDayPlan({ leads: leadsNow(), stages, tasks: [{ ...docs['tasks/task1'], id: 'task1' }], email: AGENT, now: NOW });
const kinds = plan.map(p => p.kind + ':' + (p.leadId || p.taskId || ''));
check('Both of today\'s visits are in the plan at their own times', plan.filter(p => p.kind === 'visit').length === 2 && plan.filter(p => p.kind === 'visit').every(p => p.slot === p.at), kinds);
check('The overdue team promise (Meena) is an escalation, first among the unfixed items', plan.filter(p => p.kind !== 'visit')[0].leadId === 'L_meena' && plan.find(p => p.leadId === 'L_meena').priority === 'escalation', kinds);
check('Shiva\'s due follow-up is in, as hot', plan.some(p => p.leadId === 'L_shiva' && p.kind === 'follow_up' && p.priority === 'hot'));
check('Lakshmi (no contact for 9 days) is going cold', plan.some(p => p.leadId === 'L_lakshmi' && /going cold/.test(p.title)));
check('The won lead is not in the plan', !plan.some(p => p.leadId === 'L_ravi'));
check('Today\'s task is in', plan.some(p => p.kind === 'task'));
const placed = plan.filter(p => p.kind !== 'visit' && p.slot);
const visitBlocks = plan.filter(p => p.kind === 'visit').map(v => [v.at - 30 * MIN, v.at + 90 * MIN]);
check('No slot overlaps a visit and its travel time', placed.every(p => !visitBlocks.some(([a, b]) => p.slot < b && p.slot + 30 * MIN > a)), placed.map(p => ED.istTime(p.slot)));
check('Slots never start before now', placed.every(p => p.slot >= NOW - 30 * MIN));
check('Every item has a time to show', plan.every(p => p.time));
const plan2 = ED.buildDayPlan({ leads: leadsNow(), stages, tasks: [], email: AGENT2, now: NOW });
check('Another agent\'s plan leaves out visits only this agent is on', !plan2.some(p => p.kind === 'visit'));

section('MVP-11 / 12 / 13 — reminders and the gist');
const due = ED.remindersDue({ leads: leadsNow(), stages, properties: Object.values(props), email: AGENT, now: NOW });
check('Priya\'s visit (in 95 min) gives the 2-hour reminder', due.some(r => r.kind === 'visit' && r.leadId === 'L_priya'), due.map(r => r.key));
check('…but not the gist yet', !due.some(r => r.kind === 'gist' && r.leadId === 'L_priya'));
const gist = due.find(r => r.kind === 'gist' && r.leadId === 'L_arun');
check('Arun\'s visit (in 9 min) gives the gist', !!gist);
check('…with the property and the owner', gist && gist.gist.property && gist.gist.property.code === props.mam.propertyCode && 'owner' in gist.gist);
check('Every reminder has a stable key', due.every(r => r.key && r.key.includes(r.leadId)));
const later = ED.remindersDue({ leads: leadsNow(), stages, properties: Object.values(props), email: AGENT, now: NOW + 3 * HOUR });
check('Hours later, nothing about visits that are over', !later.some(r => r.leadId === 'L_arun' || r.leadId === 'L_priya'));
const fuLead = { id: 'F', name: 'F', followUpAt: NOW - 5 * MIN, stageId: 'options' };
check('A follow-up due 5 minutes ago pops up', ED.remindersDue({ leads: [fuLead], stages, email: AGENT, now: NOW }).some(r => r.kind === 'follow_up'));
check('…one due an hour ago does not (it is in the plan instead)', !ED.remindersDue({ leads: [{ ...fuLead, followUpAt: NOW - HOUR }], stages, email: AGENT, now: NOW }).length);

// ═══════ Through the handler ═══════
section('Requests');
{
  const [o] = await easyHandle({ db, user: ME, body: { action: 'ping' }, now: NOW });
  check('ping says Eåsy is on', o.enabled === true);
  const [e, s] = await easyHandle({ db, user: ME, body: { history: [] }, now: NOW });
  check('An empty question is refused', s === 400 && e.error);
}

section('MVP-10 — "What is my day?"');
{
  const { r, o } = await tool('my_day', {});
  check('my_day returns the plan', r.plan && r.plan.length >= 5, r);
  check('…and the page gets it for the plan card', Array.isArray(o.plan) && o.plan.length === r.plan.length);
  check('The question carried the time and who is asking', /IST/.test(requests[0].system[1].text) && requests[0].system[1].text.includes(AGENT));
  check('The prompt is cached', requests[0].system[0].cache_control && requests[0].system[0].cache_control.type === 'ephemeral');
}

section('MVP-07 — lead summary');
{
  const { r: found } = await tool('search_leads', { query: 'shiva' });
  check('Two leads called Shiva are both found (so Eåsy can ask which)', found.total === 2, found.leads.map(l => l.name));
  const { r } = await tool('lead_summary', { id: 'L_shiva' });
  check('The summary has the requirement, stage and heat', r.propertyInterest === '3BHK in Poonamallee' && r.stage === 'Options sent' && r.heat === 'hot', r);
  check('…the latest chat', r.latestChat.length === 3 && r.latestChat[0].from === 'lead');
  check('…the team\'s notes', r.notes.length === 1 && /east facing/.test(r.notes[0].text));
  check('…and matching properties from the match engine', Array.isArray(r.matchedProperties));
  const { r: cold } = await tool('search_leads', { cold_days: 7 });
  check('Leads untouched for 7 days: Lakshmi, not the won one', cold.leads.some(l => l.id === 'L_lakshmi') && !cold.leads.some(l => l.id === 'L_ravi'));
  const { r: none } = await tool('lead_summary', { id: 'nope' });
  check('An unknown lead is "No such lead", not a guess', none.error === 'No such lead');
}

section('MVP-06 / 03 — property summary and what is missing');
{
  const { r } = await tool('property_summary', { code: props.med.propertyCode.toLowerCase() });
  check('Found by its code, any case', r.code === props.med.propertyCode, r);
  check('…with completeness and the missing list', /%$/.test(r.completeness) && Array.isArray(r.missing));
  check('…and its site visits (Priya and Karthik)', r.siteVisits.length === 2, r.siteVisits);
  check('…and the owner\'s name', r.ownerName === props.med.contactName);
  const { r: none } = await tool('property_summary', { code: 'ZZZ999' });
  check('An unknown code is reported, not guessed', /No property/.test(none.error));
}

section('MVP-05 — matching buyers');
{
  const { r } = await tool('match_buyers', { code: props.med.propertyCode });
  const all = [...r.matches, ...r.nearMatches];
  check('Medavakkam buyers are found', all.some(m => m.id === 'L_priya' || m.id === 'L_karthik'), all.map(m => m.name + ' ' + m.match));
  check('…each with reasons', all.every(m => Array.isArray(m.why)));
  check('…never the won lead', !all.some(m => m.id === 'L_ravi'));
}

section('MVP-08 — drafts and Send');
let draftId;
{
  const { r, o } = await tool('draft_message', { to: 'lead', lead_id: 'L_shiva', text: 'Hi Shiva, sharing the Poonamallee 3BHK details.' });
  draftId = r.draftId;
  check('A draft is saved', r.saved && store.get('easyDrafts/' + draftId).status === 'draft');
  check('…the phone comes from the lead record, ready for wa.me', o.drafts[0].phone === '919840011111');
  check('…and the page gets the card', o.drafts.length === 1 && o.drafts[0].toName === 'Shiva Kumar');
  const long = await tool('draft_message', { to: 'lead', lead_id: 'L_shiva', text: ('A sentence of the message. ').repeat(60) });
  check('A message over 1000 characters is cut at a sentence end', long.o.drafts[0].text.length <= 1000 && long.o.drafts[0].text.endsWith('.'));
  const noPhone = await tool('draft_message', { to: 'owner', code: Object.values(props).find(p => !p.contactNumber)?.propertyCode || 'ZZZ999', text: 'Hi' });
  check('No usable number → an error, no draft', !!noPhone.r.error && !noPhone.o.drafts.length);
  let [x] = await easyHandle({ db, user: ME, body: { action: 'draft', draftId, status: 'opened', text: 'Hi Shiva — edited.' }, now: NOW });
  check('Send marks it opened, with the edited text', x.status === 'opened' && store.get('easyDrafts/' + draftId).text === 'Hi Shiva — edited.');
  [x] = await easyHandle({ db, user: ME, body: { action: 'draft', draftId, status: 'sent' }, now: NOW });
  check('"Sent? Yes" marks it sent', store.get('easyDrafts/' + draftId).status === 'sent');
  const [, s] = await easyHandle({ db, user: { ...ME, tenantId: 't_other' }, body: { action: 'draft', draftId, status: 'sent' }, now: NOW });
  check('Another tenant cannot touch it', s === 404);
}

section('MVP-03 — asking the owner for missing details');
{
  const { r, o } = await tool('ask_owner_for_missing', { code: props.med.propertyCode, fields: ['photos', 'map pin'], text: 'Hello Rajan, could you share photos and the map pin?' });
  check('A draft to the owner, with the owner\'s number', r.saved && o.drafts[0].phone === waDigits(props.med.contactNumber), o.drafts[0]);
  const gaps = [...store.docs].filter(([p, d]) => p.startsWith('easyGaps/') && d.draftId === r.draftId);
  check('…and each detail tracked as asked', gaps.length === 2 && gaps.every(([, d]) => d.status === 'asked'));
  const { r: s } = await tool('property_summary', { code: props.med.propertyCode });
  check('The summary then says what was already asked', s.alreadyAskedOwner.length === 2);
  const old = gaps[0][0];
  store.set(old, { askedAt: NOW - 8 * DAY }, { merge: true });
  const gapsNow = [...store.docs].filter(([p]) => p.startsWith('easyGaps/')).map(([p, d]) => ({ ...d, id: p }));
  check('Asked over 7 days ago → back in the plan to chase', ED.buildDayPlan({ leads: [], stages, gaps: gapsNow, email: AGENT, now: NOW }).some(p => p.kind === 'property_gap'));
}

section('MVP-01 — adding a property');
let addId;
{
  const vel = ED.nextCode('Velachery', Object.values(props).concat(Object.values(docs).filter(d => d.propertyCode)));
  const vel2 = vel.slice(0, 3) + String(Number(vel.slice(3)) + 1).padStart(3, '0');
  const { r, o } = await tool('propose_property_add', { fields: { config: '2BHK', location: 'Velachery, Chennai', startingPrice: '72 L', contactName: 'Rajan', contactNumber: '98400 12345', bogus: 'x' } });
  addId = r.changeId;
  check('A card to confirm, nothing written to properties yet', o.changes.length === 1 && !store.get('properties/' + vel));
  check('…it reads back the code and what is still missing', o.changes[0].lines[0].startsWith('Code: ' + vel) && o.changes[0].lines.some(l => /Still missing/.test(l)), o.changes[0].lines);
  check('…unknown fields are dropped', !o.changes[0].lines.some(l => /bogus/.test(l)));
  const [, s403] = await easyHandle({ db, user: OTHER, body: { action: 'confirm', changeId: addId, yes: true }, now: NOW });
  check('Only the person who asked can confirm', s403 === 403);
  const [y] = await easyHandle({ db, user: ME, body: { action: 'confirm', changeId: addId, yes: true }, now: NOW });
  const p = store.get('properties/' + vel);
  check('Yes saves it as a draft listing with its code', y.status === 'applied' && p && p.listingStatus === 'draft' && p.propertyCode === vel && p.tenantId === T, y);
  check('…with who added it', p && p.addedBy === AGENT && p.addedVia === 'easy');
  check('…and an audit entry', [...store.docs].some(([k, d]) => k.startsWith('easyAudit/') && d.action === 'property_add'));
  const [again, s409] = await easyHandle({ db, user: ME, body: { action: 'confirm', changeId: addId, yes: true }, now: NOW });
  check('A change cannot be applied twice', s409 === 409 && /Already/.test(again.error));
  const { o: o2 } = await tool('propose_property_add', { fields: { location: 'Velachery' } });
  check('The next one in Velachery gets the following code', o2.changes[0].lines[0].startsWith('Code: ' + vel2), o2.changes[0].lines[0]);
  const { r: nol } = await tool('propose_property_add', { fields: { config: '2BHK' } });
  check('No locality → refused', /locality/.test(nol.error));
}

section('MVP-02 — updating a property');
{
  const code = props.med.propertyCode, id = props.med.id;
  const oldPrice = store.get('properties/' + id).startingPrice;
  const { o } = await tool('propose_property_update', { code, changes: { startingPrice: '1.3 Cr', availability: 'On hold', nonsense: 'x' } });
  check('The card reads back old → new', o.changes[0].lines.some(l => l.includes(`${oldPrice} → 1.3 Cr`)), o.changes[0].lines);
  check('…nothing changed yet', store.get('properties/' + id).startingPrice === oldPrice);
  const [no] = await easyHandle({ db, user: ME, body: { action: 'confirm', changeId: o.changes[0].id, yes: false }, now: NOW });
  check('No → nothing changes', no.status === 'declined' && store.get('properties/' + id).startingPrice === oldPrice);
  const { o: o2 } = await tool('propose_property_update', { code, changes: { startingPrice: '1.3 Cr' } });
  await easyHandle({ db, user: ME, body: { action: 'confirm', changeId: o2.changes[0].id, yes: true }, now: NOW });
  check('Yes → the price changes, with who and when', store.get('properties/' + id).startingPrice === '1.3 Cr' && store.get('properties/' + id).updatedBy === AGENT);
  const auditRow = [...store.docs].find(([k, d]) => k.startsWith('easyAudit/') && d.action === 'property_update');
  check('…and the audit keeps before and after', auditRow && auditRow[1].before.startingPrice === oldPrice && auditRow[1].after.startingPrice === '1.3 Cr');
  const { r: same } = await tool('propose_property_update', { code, changes: { startingPrice: '1.3 Cr' } });
  check('Setting what it already says is refused', /Nothing to change/.test(same.error));
}

section('MVP-15 / MVP-09 — notes by chat and after a call');
{
  const fu = new Date(NOW + DAY).toISOString();
  const { o } = await tool('propose_note', { lead_id: 'L_priya', code: props.med.propertyCode, text: 'Liked it but wants a covered car park.', follow_up_at: fu, call: true });
  check('The card says what goes where', o.changes[0].lines.length === 3 && /Note on Priya/.test(o.changes[0].lines[0]) && /Next follow-up/.test(o.changes[0].lines[2]), o.changes[0].lines);
  check('…titled as call notes', /call notes/i.test(o.changes[0].title));
  const before = store.get('leads/L_priya').updatedAt;
  const [y] = await easyHandle({ db, user: ME, body: { action: 'confirm', changeId: o.changes[0].id, yes: true }, now: NOW });
  check('Yes saves it', y.status === 'applied', y);
  const notes = [...store.docs].filter(([k]) => k.startsWith('leads/L_priya/notes/')).map(([, d]) => d);
  check('…a note on the lead, in the CRM\'s shape', notes.some(n => /Call notes/.test(n.text) && n.by === AGENT && n.id && n.createdAt));
  check('…feedback on the property', [...store.docs].some(([k, d]) => k.startsWith(`properties/${props.med.id}/notes/`) && /car park/.test(d.text)));
  check('…the follow-up set and the lead touched', store.get('leads/L_priya').followUpAt === Date.parse(fu) && store.get('leads/L_priya').updatedAt > before);
  const row = [...store.docs].find(([k]) => k.startsWith('leadViews/') ) || null;
  check('…through the lead views (the CRM\'s lists stay right)', row !== null);
  const { r: past } = await tool('propose_note', { lead_id: 'L_priya', text: 'x', follow_up_at: new Date(NOW - DAY).toISOString() });
  check('A follow-up in the past is refused', /in the past/.test(past.error));
  const { r: nobody } = await tool('propose_note', { text: 'x' });
  check('A note about nobody is refused', /which lead or property/.test(nobody.error));
}

section('MVP-04 — brochure');
{
  const withB = Object.values(docs).find(d => d.brochureLink && d.propertyCode);
  const { r, o } = await tool('brochure', { code: withB.propertyCode });
  check('A property with a brochure gives its link, shown as a link card', r.brochure === withB.brochureLink && o.links.length === 1);
  const without = Object.values(docs).find(d => d.propertyCode && !d.brochureLink);
  const { r: r2 } = await tool('brochure', { code: without.propertyCode });
  check('…one without says so, with what to fill first', r2.brochure === null && Array.isArray(r2.missing));
}

section('MVP-14 — seller weekly summary');
{
  const { r, o } = await tool('seller_summaries', {});
  check('The property with a visit this week gets a summary', r.properties.some(x => x.code === props.med.propertyCode && x.drafted), r);
  const d = o.drafts.find(x => x.about && x.about.code === props.med.propertyCode);
  check('…drafted to the owner, with the feedback', d && /site visit/.test(d.text) && /kitchen is small/.test(d.text), d && d.text);
  check('…and a visit still to come is not counted as done', d && /1 site visit/.test(d.text));
}

section('MVP-16 — team overview');
{
  const { r } = await tool('team_overview', {});
  check('The admin sees each agent', Array.isArray(r.agents) && r.agents.some(a => a.agent === AGENT), r);
  check('…with messages drafted and sent this week', r.agents.find(a => a.agent === AGENT).messagesThisWeek.sent >= 1);
  const { r: no } = await tool('team_overview', {}, OTHER);
  check('An agent who is not the admin is refused', /Only the admin/.test(no.error));
}

section('Reminders through the handler');
{
  const [o] = await easyHandle({ db, user: ME, body: { action: 'reminders' }, now: NOW });
  check('The page gets the 2-hour reminder and the gist', o.reminders.some(r => r.kind === 'visit') && o.reminders.some(r => r.kind === 'gist'));
  const g = o.reminders.find(r => r.kind === 'gist');
  check('…the gist carries the lead\'s last note', g.gist.lead.lastNotes.some(t => /father/.test(t)));
  const [o2] = await easyHandle({ db, user: OTHER, body: { action: 'reminders' }, now: NOW });
  check('Another agent does not get this agent\'s visits', !o2.reminders.some(r => r.kind === 'visit' || r.kind === 'gist'));
}

section('Safety');
{
  const { o } = await chat(ME, 'x', [{ stop_reason: 'refusal', content: [] }]);
  check('A refusal is a plain answer, not an error', /can't help/.test(o.reply));
  const r = await chat(ME, 'x', [use(['no_such_tool', {}]), () => { const x = results()[0]; return say(x.ok ? 'bad' : 'ok'); }]);
  check('An unknown tool is an error result, and the answer still comes back', r.o.reply === 'ok');
  const loops = await chat(ME, 'x', Array.from({ length: 9 }, () => use(['my_day', {}])));
  check('A model that never stops is cut off with a plain message', /too many steps/.test(loops.o.reply));
  const hist = await (async () => { script = [say('hi')]; requests = []; await easyHandle({ db, user: ME, body: { history: [{ role: 'assistant', text: 'old' }, { role: 'user', text: 'q' }] }, now: NOW }); return requests[0].messages; })();
  check('History is trimmed to start with the user', hist[0].role === 'user' && hist.length === 1);
  const tools = requests[0].tools.map(t => t.name);
  check('Every request is Haiku, with no fallback to another model', requests.every(r => r.model === 'claude-haiku-5-5' && !('fallbacks' in r) && !('betas' in r)), requests.map(r => r.model));
  check('No tool can send to a lead or a seller', !tools.some(t => /send|whatsapp/i.test(t)), tools);
  check('Owner phone numbers are not in any tool description sent to a lead (prompt rule present)', /Never put an owner's phone number/.test(requests[0].system[0].text));
}

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
