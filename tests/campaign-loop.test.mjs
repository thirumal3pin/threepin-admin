// ═══════ WHATSAPP CAMPAIGNS — replies close the loop ═══════
//
//   node tests/campaign-loop.test.mjs
//
// api/_campaign-loop.js end to end on the in-memory Firestore: a campaign is created and sent
// through the real api/_campaign.js against a scripted TailorTalk, the lead answers in its chat,
// and the answer arrives the ways it really does — a webhook (api/_tailortalk-sync.js), a retry
// of it, the nightly pull replaying the whole chat. Nothing is sent and nothing is spent.

import { readFileSync } from 'node:fs';
import {
  classifyReply, readReply, parseWhen, MEDIA_REPLY, replyCandidates, hasTemplateEntry, applyCampaignReplies, withCampaignLog, ACTIONS, LOG_MAX,
  templateStatusChanges, campaignDigest, campaignDigestText, campaignDigestHtml, openReply
} from '../api/_campaign-loop.js';
import { campaignAction, makeDeps } from '../api/_campaign.js';
import { applyTailorTalkEvent, pullTailorTalkPage, campaignRepliesAfter, _clearConfigCache } from '../api/_tailortalk-sync.js';
import { createFakeDb } from './_fake-firestore.mjs';
import { rebuildLeadViews } from '../api/_lead-views.js';
import { normaliseChat } from '../api/_tailortalk-shared.js';

let passed = 0, failed = 0;
const check = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); } };
const section = s => console.log('\n── ' + s);
console.log('3 PIN Realty — campaign replies close the loop');

const TENANT = 't_3pin';
const user = { tenantId: TENANT, email: 'admin@threepin.in' };
const MIN = 60000, DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const SAMPLE = JSON.parse(readFileSync(new URL('./fixtures/tailortalk-sample.json', import.meta.url), 'utf8'));

// ─── what a reply asks for ───────────────────────────────────────────────
section('classifyReply — every action');
const FB = ['Share Feedback', 'Request a Call'];
const SOLD = ['show similar properties'];
const cases = [
  // [text, buttons, ctx, expected]
  ['STOP', [], {}, 'optout'], ['Unsubscribe', [], {}, 'optout'], ['Please don’t message me again', [], {}, 'optout'],
  // "Not interested" / "vendam" alone is "not this one" — never a stop (it says nothing about messages).
  ['Not interested', [], {}, 'not_this'], ['Not interested sir 🙏', [], {}, 'not_this'], ['venda', [], {}, 'not_this'],
  ['Vendam', [], {}, 'not_this'], ['vendaam sir', [], {}, 'not_this'], ['வேண்டாம்', [], {}, 'not_this'], ['remove my number', [], {}, 'optout'],
  ['Not interested, don’t message me', [], {}, 'optout'], ['Stop offers', [], {}, 'marketing_optout'], ['no more offers please', [], {}, 'marketing_optout'],
  ['ok', [], {}, 'ack'], ['Thank you', ['Thank you', 'Reschedule'], { purpose: 'visit_confirmed' }, 'ack'], ['👍', [], {}, 'ack'],
  ['Confirm', ['Confirm', 'Reschedule'], { purpose: 'visit_reminder' }, 'ack'],
  ['Refer someone', ['Write a review', 'Refer someone'], { purpose: 'referral' }, 'referral'], ['I want to sell my flat', [], {}, 'seller'],
  ['Help with loan', [], {}, 'loan'], ['EMI details?', [], {}, 'loan'],
  ['Request a Call', FB, { template: 'post_visit_feedback' }, 'call'], ['Talk to the team', [], {}, 'call'],
  ['call pannunga', [], {}, 'call'], ['Call me after 6', [], {}, 'call'], ['Pls call back', [], {}, 'call'],
  ['Book a visit', [], {}, 'visit'], ['Confirmed', ['Confirmed', 'Reschedule'], {}, 'visit'], ['Can I visit on Sunday?', [], {}, 'visit'], ['paakanum', [], {}, 'visit'],
  ['show similar properties', SOLD, {}, 'options'], ['Share similar options', [], {}, 'options'], ['Show me more', [], {}, 'options'],
  ['Send details', [], {}, 'options'], ['Send brochure', [], {}, 'options'], ['Still looking', [], {}, 'options'], ['Yes, share options', [], {}, 'options'],
  ['What is the price?', [], {}, 'options'], ['anuppunga', [], {}, 'options'],
  ['Liked it', [], {}, 'feedback'], ['Share Feedback', FB, { template: 'post_visit_feedback' }, 'feedback'],
  ['Nice flat but the balcony is small', FB, { template: 'post_visit_feedback' }, 'feedback'],
  ['Price is a bit high for us', FB, { purpose: 'visit_feedback' }, 'feedback'],
  ['Not now', ['Not now'], {}, 'not_now'], ['maybe later', [], {}, 'not_now'], ['apram paakalam', [], {}, 'not_now'], ['next month', [], {}, 'not_now'],
  ['Found a property', [], {}, 'found'], ['Already bought a flat in Adyar', [], {}, 'found'], ['already purchased', [], {}, 'found'],
  ['Reschedule', ['Confirmed', 'Reschedule'], {}, 'reschedule'], ['Can we change the time?', [], {}, 'reschedule'], ['Can’t come tomorrow', [], {}, 'reschedule'],
  ['hello', [], {}, 'other'], ['Good morning', [], {}, 'other'], ['Sell or List Property', ['Buy Property', 'Rent Property', 'Sell or List Property'], {}, 'seller'],
  ['', [], {}, 'other']
];
for (const [text, buttons, ctx, want] of cases) {
  const got = classifyReply(text, buttons, ctx);
  check(`“${text}” → ${want}`, got === want, got);
}
check('every action key is covered', Object.keys(ACTIONS).every(k => cases.some(c => c[3] === k)));
check('“not interested” inside a longer ask is not a goodbye', classifyReply('not interested in the 2 BHK, send me 3 BHK options please', []) === 'options');
check('“Not for me” is not this one, tapped or typed', classifyReply('Not for me', ['Share Feedback', 'Not for me'], { template: 'post_visit_feedback' }) === 'not_this' && classifyReply('Not for me', [], { template: 'post_visit_feedback' }) === 'not_this');
check('another button of a feedback template is a choice, not written feedback', classifyReply('Maybe', ['Share Feedback', 'Maybe'], { template: 'post_visit_feedback' }) === 'other' && classifyReply('Maybe', [], { template: 'post_visit_feedback' }) === 'feedback');
check('button objects work too', classifyReply('request a call', [{ type: 'QUICK_REPLY', text: 'Request a Call' }]) === 'call');

// ─── which messages answer a template ───────────────────────────────────
section('reply candidates');
const T0 = Date.parse('2026-11-04T05:00:00Z');   // 10:30 AM IST
const tplMsg = (at, name = 'post_visit_feedback') => ({ role: 'assistant', content: '', message_id: null, time: iso(at), metadata: { type: 'template', template_name: name, template_params: { name: 'Ravi' } } });
const userMsg = (at, text, id) => ({ role: 'user', content: text, time: iso(at), message_id: id || 'wamid.u' + at, metadata: null });
const aiMsg = (at, text) => ({ role: 'assistant', content: text, time: iso(at), message_id: null, metadata: null });
{
  const chat = [userMsg(T0 - DAY, 'old question'), aiMsg(T0 - DAY + 1000, 'old answer'), tplMsg(T0), userMsg(T0 + 5 * MIN, 'Request a Call'),
    userMsg(T0 + 6 * MIN, 'after 6 pm please'), aiMsg(T0 + 7 * MIN, 'Sure, the team will call you'), userMsg(T0 + 9 * MIN, 'thanks')];
  const c = replyCandidates(chat);
  check('no template → no candidates', replyCandidates([userMsg(T0, 'hi')]).length === 0 && !hasTemplateEntry([userMsg(T0, 'hi')]));
  check('template detected', hasTemplateEntry(chat));
  check('the burst after the template, up to 3 PIN’s answer', c.length === 2 && c[0].text === 'Request a Call' && c[1].text === 'after 6 pm please', c);
  check('carries the template and its time', c[0].template === 'post_visit_feedback' && c[0].templateAt === T0 && c[0].key);
  const replyMeta = { role: 'user', content: 'Thank you for visiting…:\nLiked it', time: iso(T0 + MIN), message_id: 'wamid.r', metadata: { type: 'reply', replied_to_message_id: 'x', text: 'Thank you for visiting…', user_message: 'Liked it' } };
  check('a WhatsApp “reply to” uses the lead’s own words', replyCandidates([tplMsg(T0), replyMeta])[0].text === 'Liked it');
  check('nothing a week later', replyCandidates([tplMsg(T0), userMsg(T0 + 8 * DAY, 'hi')]).length === 0);
  check('a “no response” marker does not close the reply', replyCandidates([tplMsg(T0), { role: 'assistant', content: '<no response from agent>', time: iso(T0 + MIN) }, userMsg(T0 + 2 * MIN, 'call me')]).length === 1);
}

section('lead.campaignLog');
{
  let log = [];
  for (let i = 0; i < 25; i++) log = withCampaignLog(log, { id: 'c' + i, name: 'C' + i, template: 't', at: i, status: 'sent' });
  check('newest first, at most ' + LOG_MAX, log.length === LOG_MAX && log[0].id === 'c24' && log[LOG_MAX - 1].id === 'c5');
  log = withCampaignLog(log, { id: 'c10', status: 'replied', reply: 'yes' });
  check('an update merges in place', log.length === LOG_MAX && log.find(e => e.id === 'c10').status === 'replied' && log.find(e => e.id === 'c10').name === 'C10' && log[0].id === 'c24');
}

// ─── the server, end to end ─────────────────────────────────────────────
const TEMPLATES = {
  post_visit_feedback: { template_name: 'post_visit_feedback', template_status: 'APPROVED', template_type: 'UTILITY', language: 'en' },
  site_visit_unavailable_update: { template_name: 'site_visit_unavailable_update', template_status: 'APPROVED', template_type: 'UTILITY', language: 'en' }
};
function fakeTailorTalk() {
  const calls = [];
  let n = 0;
  const reply = (status, body) => {
    const wire = { data: body, success: status < 300 };
    return { ok: status < 300, status, text: async () => JSON.stringify(wire), json: async () => wire };
  };
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api/v1/', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, body });
    if (path === 'get_whatsapp_templates') {
      const name = u.searchParams.get('template_name');
      if (name) return TEMPLATES[name] ? reply(200, { templates: [TEMPLATES[name]] }) : reply(404, { detail: 'not found' });
      return reply(200, { templates: Object.values(TEMPLATES) });
    }
    if (path === 'send_whatsapp_template_message') return reply(200, { message_id: 'wamid.' + (++n) });
    return reply(404, { detail: 'no route' });
  };
  return { fetch, calls };
}

// A clock the test moves; quiet hours are respected (every send here is in the daytime, IST).
function world() {
  const db = createFakeDb();
  const tt = fakeTailorTalk();
  const clock = { t: T0 };
  const deps = makeDeps({ fetch: tt.fetch, sleep: async () => {}, now: () => clock.t });
  const run = b => campaignAction(db, user, 'tok', b, deps, {});
  return { db, tt, clock, deps, run };
}
const VARS = ['name', 'property_name', 'property_code'];
const vals = n => ({ name: n, property_name: 'Sunrise', property_code: 'ANR003' });
async function addLead(db, id, phone, extra = {}) {
  await db.collection('leads').doc(id).set({ id, tenantId: TENANT, name: id === 'L1' ? 'Ravi' : 'Lead ' + id, phone, phoneKey: '91' + phone, updatedAt: T0 - 5 * DAY, updatedBy: 'agent@threepin.in', ...extra });
}
async function sendCampaign(w, name, template, recipients, vars = VARS) {
  const r = await w.run({ op: 'create', name, template, vars, recipients });
  if (!r.ok) throw new Error('create failed: ' + r.error);
  const s = await w.run({ op: 'send', id: r.id });
  if (!s.ok) throw new Error('send failed: ' + s.error);
  return r.id;
}
const historyOf = (db, leadId) => db._list('leads/' + leadId + '/history').map(p => db._get(p));

section('a reply is recorded once, on the campaign and on the lead');
{
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  await addLead(w.db, 'L2', '9000000002');
  // The lead views the CRM page reads, so the rows can be checked too.
  await rebuildLeadViews(w.db, TENANT, ['L1', 'L2'].map(k => ({ ...w.db._get('leads/' + k), id: k })));
  const id = await sendCampaign(w, 'Feedback — this week', 'post_visit_feedback',
    [{ leadId: 'L1', contact: '9000000001', name: 'Ravi', values: vals('Ravi') }, { leadId: 'L2', contact: '9000000002', name: 'Anu', values: vals('Anu') }]);
  let lead = w.db._get('leads/L1');
  check('the send is in the lead’s campaign history', lead.campaignLog && lead.campaignLog[0].id === id && lead.campaignLog[0].status === 'sent' && lead.campaignLog[0].template === 'post_visit_feedback', lead.campaignLog);
  check('sending does not touch updatedAt', lead.updatedAt === T0 - 5 * DAY && lead.updatedBy === 'agent@threepin.in');

  const chat = [tplMsg(T0 + 1000), userMsg(T0 + 10 * MIN, 'Request a Call')];
  w.clock.t = T0 + 11 * MIN;
  const before = JSON.stringify(w.db._get('leads/L1'));
  let r = await applyCampaignReplies(w.db, TENANT, 'L1', null, chat, { now: w.clock.t, contact: '919000000001' });
  check('applied', r.ok && r.applied.length === 1 && r.applied[0].action === 'call' && r.applied[0].campaignId === id, r);
  const c = w.db._get('campaigns/' + id);
  check('recipient replied, with the reply', c.recipients.L1.status === 'replied' && c.recipients.L1.reply.text === 'Request a Call' && c.recipients.L1.reply.action === 'call' && c.recipients.L1.reply.at === T0 + 10 * MIN);
  check('counts re-tallied', c.counts.replied === 1 && c.counts.sent === 2, c.counts);
  check('the other recipient untouched', c.recipients.L2.status === 'sent' && !c.recipients.L2.reply);
  lead = w.db._get('leads/L1');
  check('lead.campaignReply', lead.campaignReply && lead.campaignReply.campaignId === id && lead.campaignReply.campaignName === 'Feedback — this week'
    && lead.campaignReply.template === 'post_visit_feedback' && lead.campaignReply.text === 'Request a Call' && lead.campaignReply.action === 'call' && lead.campaignReply.at === T0 + 10 * MIN, lead.campaignReply);
  check('campaignLog entry now replied', lead.campaignLog.length === 1 && lead.campaignLog[0].status === 'replied' && lead.campaignLog[0].reply === 'Request a Call' && lead.campaignLog[0].replyAt === T0 + 10 * MIN && lead.campaignLog[0].action === 'call' && lead.campaignLog[0].at === T0, lead.campaignLog);
  check('follow-up now, by the campaign', lead.followUpAt === T0 + 10 * MIN && lead.followUpBy === 'campaign' && lead.followUpNote === 'Asked for a call — Feedback — this week' && lead.followUpSetAt === w.clock.t, lead);
  check('updatedAt / updatedBy NOT moved — the reply stays open', lead.updatedAt === T0 - 5 * DAY && lead.updatedBy === 'agent@threepin.in');
  check('open by the CRM’s rule', !!openReply(lead));
  const h = historyOf(w.db, 'L1');
  check('one history entry by Campaign', h.length === 1 && h[0].type === 'campaign' && h[0].by === 'Campaign' && h[0].at === T0 + 10 * MIN && /Request a Call/.test(h[0].text) && /Asked for a call/.test(h[0].text), h);
  const row = [...w.db._store.entries()].find(([p, d]) => !p.startsWith('leads/') && !p.startsWith('campaign') && d && d.rows && d.rows.L1);
  check('the lead’s row (what the page reads) carries it', row && row[1].rows.L1.campaignReply && row[1].rows.L1.campaignReply.action === 'call' && row[1].rows.L1.campaignLog[0].status === 'replied' && row[1].rows.L1.followUpBy === 'campaign', row && row[1].rows.L1);
  check('nothing else of the lead changed', Object.keys(JSON.parse(before)).every(k => ['campaignLog'].includes(k) || JSON.stringify(JSON.parse(before)[k]) === JSON.stringify(lead[k])));

  // The same chat again — a webhook retry, then the nightly replay.
  r = await applyCampaignReplies(w.db, TENANT, 'L1', null, chat, { now: w.clock.t + MIN });
  check('the same webhook twice records nothing more', r.applied.length === 0 && historyOf(w.db, 'L1').length === 1, r);
  // Even with the lead's shortcut gone (the replay checks the campaign itself).
  r = await applyCampaignReplies(w.db, TENANT, 'L1', { ...w.db._get('leads/L1'), campaignReply: null }, chat, { now: w.clock.t + 2 * MIN });
  check('the nightly replay records nothing more', r.applied.length === 0 && historyOf(w.db, 'L1').length === 1 && w.db._get('campaigns/' + id).counts.replied === 1, r);
  // Concurrent: two at once never both record.
  const chat2 = [...chat, userMsg(T0 + 12 * MIN, 'after 6 pm please')];
  const [a, b] = await Promise.all([
    applyCampaignReplies(w.db, TENANT, 'L1', null, chat2, { now: w.clock.t }),
    applyCampaignReplies(w.db, TENANT, 'L1', null, chat2, { now: w.clock.t })
  ]);
  check('two at once record the new message once', a.applied.length + b.applied.length === 1 && historyOf(w.db, 'L1').length === 2, [a, b]);
  check('the newest answer is shown', w.db._get('leads/L1').campaignReply.text === 'after 6 pm please' && w.db._get('campaigns/' + id).recipients.L1.reply.text === 'after 6 pm please');
  check('…and the earlier follow-up was not pushed out', w.db._get('leads/L1').followUpAt === T0 + 10 * MIN);

  // A person acts on the lead: the reply is no longer open.
  await w.db.collection('leads').doc('L1').update({ updatedAt: T0 + 30 * MIN, updatedBy: 'agent@threepin.in' });
  check('a person acting closes it', !openReply(w.db._get('leads/L1')));
}

section('webhook and pull: the hook in api/_tailortalk-sync.js');
{
  _clearConfigCache();
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  const id = await sendCampaign(w, 'Sold — similar homes', 'site_visit_unavailable_update', [{ leadId: 'L1', contact: '9000000001', name: 'Ravi', values: { name: 'Ravi' } }], ['name']);
  const chat = [userMsg(T0 - DAY, 'hi'), aiMsg(T0 - DAY + 1000, 'Hello!'), tplMsg(T0 + 2000, 'site_visit_unavailable_update'), userMsg(T0 + 20 * MIN, 'Book a visit when it opens')];
  const env = () => { const e = JSON.parse(JSON.stringify(SAMPLE)); e.webhook_trigger = 'every_message'; e.occurred_at = iso(T0 + 20 * MIN); Object.assign(e.data, { id: 'agent1_whatsapp_919000000001', lead_contact: '919000000001', lead_name: 'Ravi', chat_history: chat }); return e; };

  // No template in the chat: the hook does nothing and reads nothing.
  const plain = env(); plain.data.chat_history = [userMsg(T0, 'hi')];
  const r0 = await applyTailorTalkEvent(w.db, TENANT, plain, { now: T0 + 21 * MIN });
  const reads0 = w.db._stats.reads;
  check('a chat without a template costs nothing', campaignRepliesAfter(w.db, TENANT, plain, r0) === null && w.db._stats.reads === reads0);

  const e1 = env();
  const r1 = await applyTailorTalkEvent(w.db, TENANT, e1, { now: T0 + 21 * MIN });
  check('the webhook found the lead by its number', r1.ok && r1.leadId === 'L1', r1);
  const p1 = campaignRepliesAfter(w.db, TENANT, e1, r1, { now: T0 + 21 * MIN });
  const out1 = await p1;
  check('webhook → reply recorded', out1 && out1.applied.length === 1 && out1.applied[0].action === 'visit', out1);
  let lead = w.db._get('leads/L1');
  check('visit → follow-up now', lead.followUpAt === T0 + 20 * MIN && /Wants a site visit — Sold — similar homes/.test(lead.followUpNote), lead.followUpNote);
  check('the sync’s write kept the campaign fields', lead.campaignReply && lead.campaignLog && lead.campaignLog[0].status === 'replied');

  const e2 = env();
  const r2 = await applyTailorTalkEvent(w.db, TENANT, e2, { now: T0 + 22 * MIN });
  const out2 = await campaignRepliesAfter(w.db, TENANT, e2, r2, { now: T0 + 22 * MIN });
  check('webhook retry → nothing more', out2 && out2.applied.length === 0 && historyOf(w.db, 'L1').filter(h => h.type === 'campaign').length === 1, out2);

  // The nightly pull replays the whole chat (get_leads), and a later reply the webhook missed.
  const missed = [...chat, aiMsg(T0 + 21 * MIN, 'Will let you know'), tplMsg(T0 + DAY, 'site_visit_unavailable_update')];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: { leads: [{ ...env().data, chat_history: missed, last_message_time: iso(T0 + DAY) }] } }) });
  let page = await pullTailorTalkPage(w.db, TENANT, 'tok', { now: T0 + DAY + MIN, fetchImpl, pageSize: 25 });
  check('the pull itself is unharmed', page.processed === 1 && page.failed === 0, page);
  check('the nightly replay records nothing twice', historyOf(w.db, 'L1').filter(h => h.type === 'campaign').length === 1 && w.db._get('campaigns/' + id).counts.replied === 1);

  // A pull whose reply no webhook brought; no campaign sent that second template entry → ignored.
  const later = [...missed, userMsg(T0 + DAY + 5 * MIN, 'hello?')];
  const fetch2 = async () => ({ ok: true, json: async () => ({ data: { leads: [{ ...env().data, chat_history: later, last_message_time: iso(T0 + DAY + 5 * MIN) }] } }) });
  const beforeLead = JSON.stringify(w.db._get('leads/L1').campaignReply);
  page = await pullTailorTalkPage(w.db, TENANT, 'tok', { now: T0 + DAY + 6 * MIN, fetchImpl: fetch2, pageSize: 25 });
  check('a reply to a template no CRM campaign sent at that time is ignored', page.failed === 0 && JSON.stringify(w.db._get('leads/L1').campaignReply) === beforeLead && historyOf(w.db, 'L1').filter(h => h.type === 'campaign').length === 1);

  // A template the CRM never sent in a campaign at all.
  const stray = await applyCampaignReplies(w.db, TENANT, 'L1', null, [tplMsg(T0 + 2 * DAY, 'property_requirement_followup'), userMsg(T0 + 2 * DAY + MIN, 'Buy Property')], { now: T0 + 2 * DAY + 2 * MIN });
  check('a reply to a template no campaign used is ignored', stray.applied.length === 0 && historyOf(w.db, 'L1').filter(h => h.type === 'campaign').length === 1, stray);

  // A failure inside never fails the webhook path.
  const broken = { ...w.db, collection: n => { if (n === 'campaigns') throw new Error('boom'); return w.db.collection(n); } };
  const e3 = env(); e3.data.chat_history = [...chat, userMsg(T0 + 25 * MIN, 'also send brochure')];
  const out3 = await campaignRepliesAfter(broken, TENANT, e3, { ok: true, leadId: 'L1' }, { now: T0 + 26 * MIN });
  check('an error is caught and reported, never thrown', out3 && out3.ok === false && /boom/.test(out3.error), out3);
}

section('two campaigns on the same template');
{
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  const first = await sendCampaign(w, 'Feedback — Monday', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('Ravi') }]);
  w.clock.t = T0 + 2 * DAY;
  const second = await sendCampaign(w, 'Feedback — Wednesday', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('Ravi') }]);
  // Replied to the first one only on the Tuesday, then to the second.
  const chat = [tplMsg(T0 + 3000), userMsg(T0 + DAY, 'Liked it'), aiMsg(T0 + DAY + 1000, 'Thanks!'), tplMsg(T0 + 2 * DAY + 2000), userMsg(T0 + 2 * DAY + 5 * MIN, 'Request a Call')];
  w.clock.t = T0 + 2 * DAY + 6 * MIN;
  const r = await applyCampaignReplies(w.db, TENANT, 'L1', null, chat, { now: w.clock.t });
  check('both replies recorded', r.applied.length === 2, r);
  check('Tuesday’s reply on the first campaign', w.db._get('campaigns/' + first).recipients.L1.reply.text === 'Liked it' && w.db._get('campaigns/' + first).recipients.L1.reply.action === 'feedback');
  check('Wednesday’s reply on the second', w.db._get('campaigns/' + second).recipients.L1.reply.text === 'Request a Call');
  const lead = w.db._get('leads/L1');
  check('the lead shows the newest', lead.campaignReply.campaignId === second && lead.campaignReply.action === 'call');
  check('each campaign’s log entry carries its own reply', lead.campaignLog.find(e => e.id === first).reply === 'Liked it' && lead.campaignLog.find(e => e.id === second).reply === 'Request a Call' && lead.campaignLog[0].id === second);
  check('follow-up: the earlier (Tuesday’s) stays', lead.followUpAt === T0 + DAY && /Feedback on Feedback — Monday/.test(lead.followUpNote), lead.followUpNote);

  // A template entry far from both sends: the nearest within a week.
  const w2 = world();
  await addLead(w2.db, 'L1', '9000000001');
  const a = await sendCampaign(w2, 'A', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('R') }]);
  w2.clock.t = T0 + 3 * DAY;
  await sendCampaign(w2, 'B', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('R') }]);
  const r2 = await applyCampaignReplies(w2.db, TENANT, 'L1', null, [tplMsg(T0 + 40 * MIN), userMsg(T0 + 50 * MIN, 'ok')], { now: w2.clock.t });
  check('clock skew past 15 min → the nearest campaign, not the newest', r2.applied.length === 1 && r2.applied[0].campaignId === a, r2);

  // A typed-in number (no lead id) is matched by its number.
  const w3 = world();
  await addLead(w3.db, 'L7', '9000000007');
  const m = await sendCampaign(w3, 'Typed list', 'post_visit_feedback', [{ contact: '9000000007', values: vals('X') }]);
  const r3 = await applyCampaignReplies(w3.db, TENANT, 'L7', null, [tplMsg(T0 + 1000), userMsg(T0 + MIN, 'Send brochure')], { now: T0 + 2 * MIN, contact: '919000000007' });
  check('a hand-typed contact is matched by number', r3.applied.length === 1 && r3.applied[0].recipient === 'm_919000000007' && w3.db._get('campaigns/' + m).recipients.m_919000000007.status === 'replied', r3);
  check('…and its lead is told', w3.db._get('leads/L7').campaignReply.action === 'options' && w3.db._get('leads/L7').campaignLog[0].id === m);

  // Another tenant's lead is never written.
  const r4 = await applyCampaignReplies(w3.db, 'other', 'L7', null, [tplMsg(T0 + 1000), userMsg(T0 + 2 * MIN, 'hi')], { now: T0 + 3 * MIN });
  check('another tenant: nothing', r4.applied.length === 0 && r4.skipped === 'other tenant');
}

section('follow-up rules');
{
  const w = world();
  await addLead(w.db, 'E', '9000000011', { followUpAt: T0 + 5 * MIN, followUpBy: 'agent@threepin.in', followUpNote: 'Call about loan' });
  await addLead(w.db, 'F', '9000000012', { followUpAt: T0 + 10 * DAY, followUpBy: 'agent@threepin.in', followUpNote: 'Later' });
  await addLead(w.db, 'N', '9000000013');
  await addLead(w.db, 'S', '9000000014', { followUpAt: T0 + 3 * DAY, followUpBy: 'agent@threepin.in', followUpNote: 'Mine' });
  await addLead(w.db, 'G', '9000000015', { stageId: 'visit_done' });
  await sendCampaign(w, 'Check-in', 'post_visit_feedback', ['E', 'F', 'N', 'S', 'G'].map((k, i) => ({ leadId: k, contact: '90000000' + (11 + i), values: vals(k) })));
  const at = T0 + 30 * MIN;
  const chat = text => [tplMsg(T0 + 1000), userMsg(at, text)];
  await applyCampaignReplies(w.db, TENANT, 'E', null, chat('Request a Call'), { now: at + MIN });
  await applyCampaignReplies(w.db, TENANT, 'F', null, chat('Request a Call'), { now: at + MIN });
  await applyCampaignReplies(w.db, TENANT, 'N', null, chat('Not now'), { now: at + MIN });
  await applyCampaignReplies(w.db, TENANT, 'S', null, chat('Not now'), { now: at + MIN });
  await applyCampaignReplies(w.db, TENANT, 'G', null, chat('Already bought a flat'), { now: at + MIN });
  const E = w.db._get('leads/E'), F = w.db._get('leads/F'), Nn = w.db._get('leads/N'), S = w.db._get('leads/S');
  check('a sooner follow-up a person set is never pushed out', E.followUpAt === T0 + 5 * MIN && E.followUpNote === 'Call about loan' && E.followUpBy === 'agent@threepin.in', E);
  check('a later one is brought forward to now', F.followUpAt === at && F.followUpBy === 'campaign' && /Asked for a call/.test(F.followUpNote), F);
  check('not now → a month out', Nn.followUpAt === at + 30 * DAY && Nn.followUpNote === 'Said not now — check back' && Nn.campaignReply.action === 'not_now', Nn);
  check('not now never pushes a sooner follow-up', S.followUpAt === T0 + 3 * DAY && S.followUpNote === 'Mine');
  const G = w.db._get('leads/G');
  check('“found” never moves the stage — it asks a person', G.stageId === 'visit_done' && G.campaignReply.action === 'found' && G.followUpNote === 'Says they found a property — mark Lost?' && G.followUpAt === at, G);
}

section('opt-out, end to end');
{
  const w = world();
  await addLead(w.db, 'L1', '9000000001', { stageId: 'options' });
  await addLead(w.db, 'L2', '9000000002');
  await sendCampaign(w, 'New launch', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('Ravi') }, { leadId: 'L2', contact: '9000000002', values: vals('Anu') }]);
  const r = await applyCampaignReplies(w.db, TENANT, 'L1', null, [tplMsg(T0 + 1000), userMsg(T0 + 3 * MIN, 'STOP')], { now: T0 + 4 * MIN });
  check('STOP → optout', r.applied[0] && r.applied[0].action === 'optout', r);
  const lead = w.db._get('leads/L1');
  check('lead.waOptOut set, with when and why', lead.waOptOut === true && lead.waOptOutAt === T0 + 3 * MIN && lead.waOptOutReason === 'replied stop', lead);
  check('no follow-up for an opt-out', !lead.followUpAt);
  check('stage untouched', lead.stageId === 'options');
  check('the number is on the do-not-message list', (w.db._get('campaignSettings/' + TENANT).optOut || []).includes('919000000001'));
  const s = await w.run({ op: 'settings' });
  check('settings shows it', s.settings.optOut.includes('919000000001'));
  w.clock.t = T0 + DAY;
  const c = await w.run({ op: 'create', name: 'Next one', template: 'post_visit_feedback', vars: VARS, recipients: [{ leadId: 'L1', contact: '9000000001', values: vals('Ravi') }, { leadId: 'L2', contact: '9000000002', values: vals('Anu') }] });
  check('the next campaign leaves them out', c.ok && c.counts.total === 1 && c.skipped.length === 1 && c.skipped[0].key === 'L1' && c.skipped[0].why === 'opted out', c);
  // Even off the number list (a person cleared the list by hand), the lead's own flag holds.
  await w.run({ op: 'settings', save: true, optOut: [] });
  const c2 = await w.run({ op: 'create', name: 'Again', template: 'post_visit_feedback', vars: VARS, recipients: [{ leadId: 'L1', contact: '9000000001', values: vals('Ravi') }] });
  check('lead.waOptOut alone holds them back', !c2.ok && c2.skipped[0].why === 'opted out', c2);
}

// ─── the morning digest ─────────────────────────────────────────────────
section('template status changes');
{
  const db = createFakeDb();
  let live = [
    { template_name: 'visit_feedback_v1', template_status: 'APPROVED' },
    { template_name: 'sold_update_v1', template_status: 'REJECTED' },
    { template_name: 'old_one', template_status: 'APPROVED' },
    { template_name: 'promo_v2', template_status: 'PAUSED' }
  ];
  const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { templates: live }, success: true }) });
  await db.collection('campaignTemplates').doc(TENANT + '__visit_feedback_v1').set({ tenantId: TENANT, name: 'visit_feedback_v1', lastStatus: 'PENDING' });
  await db.collection('campaignTemplates').doc(TENANT + '__sold_update_v1').set({ tenantId: TENANT, name: 'sold_update_v1', submittedAt: T0, body: 'Hi {{name}}' });
  await db.collection('campaignTemplates').doc(TENANT + '__promo_v2').set({ tenantId: TENANT, name: 'promo_v2', lastStatus: 'APPROVED' });
  let read = await templateStatusChanges(db, TENANT, 'tok', { fetch, now: T0 });
  let ch = read.changes;
  const by = Object.fromEntries(ch.map(c => [c.name, c]));
  check('reading records nothing until commit()', db._get('campaignTemplates/' + TENANT + '__visit_feedback_v1').lastStatus === 'PENDING' && !db._get('campaignTemplates/' + TENANT + '__old_one'));
  check('…so a second read (the digest retried) still has the news', (await templateStatusChanges(db, TENANT, 'tok', { fetch, now: T0 })).changes.length === ch.length);
  await read.commit();
  check('pending → approved', by.visit_feedback_v1 && by.visit_feedback_v1.from === 'PENDING' && by.visit_feedback_v1.to === 'APPROVED');
  check('submitted from the CRM → rejected', by.sold_update_v1 && by.sold_update_v1.from === 'SUBMITTED' && by.sold_update_v1.to === 'REJECTED');
  check('approved → paused', by.promo_v2 && by.promo_v2.to === 'PAUSED');
  check('first sight is only recorded', !by.old_one && db._get('campaignTemplates/' + TENANT + '__old_one').lastStatus === 'APPROVED');
  check('last status stored with when', db._get('campaignTemplates/' + TENANT + '__visit_feedback_v1').lastStatus === 'APPROVED' && db._get('campaignTemplates/' + TENANT + '__visit_feedback_v1').lastStatusAt === T0);
  ch = (await templateStatusChanges(db, TENANT, 'tok', { fetch, now: T0 + DAY })).changes;
  check('the next morning: nothing new', ch.length === 0, ch);
  check('no token → nothing, quietly', (await templateStatusChanges(db, TENANT, '', { fetch })).changes.length === 0);
  live = [...live, { template_name: 'Bad Name!', template_status: 'APPROVED' }];
  const bad = await templateStatusChanges(db, TENANT, 'tok', { fetch, now: T0 + 2 * DAY });
  await bad.commit();
  check('a name WhatsApp would not accept is skipped', !bad.changes.some(c => c.name === 'Bad Name!') && !db._list('campaignTemplates').some(p => /Bad/.test(p)));
  // The template list does not show a status-only record as a draft.
  const deps = makeDeps({ fetch: fakeTailorTalk().fetch, sleep: async () => {}, now: () => T0 });
  const list = await campaignAction(db, user, 'tok', { op: 'templates' }, deps, {});
  check('a status-only record is not a draft', list.ok && !list.templates.some(t => t.name === 'old_one' || t.name === 'promo_v2'), list.templates.map(t => t.name));
}

section('digest section');
{
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  await addLead(w.db, 'L2', '9000000002');
  await addLead(w.db, 'L3', '9000000003');
  const id = await sendCampaign(w, 'Feedback <this week>', 'post_visit_feedback', ['L1', 'L2', 'L3'].map((k, i) => ({ leadId: k, contact: '900000000' + (i + 1), values: vals(k) })));
  await applyCampaignReplies(w.db, TENANT, 'L1', null, [tplMsg(T0 + 1000), userMsg(T0 + 5 * MIN, 'Request a Call')], { now: T0 + 6 * MIN });
  await applyCampaignReplies(w.db, TENANT, 'L2', null, [tplMsg(T0 + 1000), userMsg(T0 + 7 * MIN, 'STOP')], { now: T0 + 8 * MIN });
  await applyCampaignReplies(w.db, TENANT, 'L3', null, [tplMsg(T0 + 1000), userMsg(T0 + 9 * MIN, 'Liked <b>it</b>')], { now: T0 + 10 * MIN });
  // L3 was then handled by a person.
  await w.db.collection('leads').doc('L3').update({ updatedAt: T0 + HOUR(1) });
  const NEXT_MORNING = Date.parse('2026-11-05T03:30:00Z');   // 9 AM IST the day after
  const leads = ['L1', 'L2', 'L3'].map(k => w.db._get('leads/' + k));
  const live = [{ template_name: 'post_visit_feedback', template_status: 'APPROVED' }];
  await w.db.collection('campaignTemplates').doc(TENANT + '__post_visit_feedback').set({ tenantId: TENANT, name: 'post_visit_feedback', lastStatus: 'PENDING' }, { merge: true });
  const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { templates: live } }) });
  const sec = await campaignDigest(w.db, TENANT, { leads, now: NEXT_MORNING, token: 'tok', fetch });
  check('yesterday’s campaign with its numbers', sec.campaigns.length === 1 && sec.campaigns[0].id === id && sec.campaigns[0].sent === 3 && sec.campaigns[0].replied === 3, sec.campaigns);
  check('waiting: the call, not the opt-out, not the handled one', sec.waiting.length === 1 && sec.waiting[0].lead.name === 'Ravi', sec.waiting.map(x => x.lead.name));
  check('template change', sec.templates.length === 1 && sec.templates[0].to === 'APPROVED');
  const text = campaignDigestText(sec).join('\n');
  check('text: sent yesterday', text.includes('Sent yesterday:\n- Feedback <this week>: 3 sent · 3 read · 3 replied'), text);
  check('text: who is waiting, what they said, which campaign', text.includes('Replies waiting for a person (1):\n- Ravi — “Request a Call” — Feedback <this week> (asked for a call)'), text);
  check('text: template change', text.includes('Template changes:\n- post_visit_feedback: approved (was pending)'), text);
  check('WhatsApp bullets', campaignDigestText(sec, '•').every(l => !l.startsWith('-')) && campaignDigestText(sec, '•').some(l => l.startsWith('• ')));
  const html = campaignDigestHtml(sec);
  check('html: a section, everything escaped', html.includes('WhatsApp campaigns') && html.includes('Feedback &lt;this week&gt;') && !html.includes('<this week>'), html.slice(0, 300));
  const two = await campaignDigest(w.db, TENANT, { leads, now: NEXT_MORNING + 2 * DAY, token: null });
  check('two days on, no token: only what still waits', two.campaigns.length === 0 && two.templates.length === 0 && two.waiting.length === 1 && !two.empty);
  const none = await campaignDigest(createFakeDb(), TENANT, { leads: [], now: NEXT_MORNING });
  check('nothing to say → no section', none.empty && campaignDigestText(none).length === 0 && campaignDigestHtml(none) === '');
}
// ═══════ fix round ═══════
section('fix: 80 real replies, read against the template’s purpose (regression table)');
{
  // From the marketing review (scratchpad mkt/cls.mjs): what 3 PIN's leads actually write.
  const P = p => ({ purpose: p });
  const table = [
    ['No', [], P('sold_out'), 'not_this'], ['no', ['Share similar options', 'Not now'], P('sold_out'), 'not_this'], ['No thanks', [], P('new_listing'), 'not_this'],
    ['Not interested in this one, any 3bhk in Velachery?', [], P('new_listing'), 'options'], ['Not interested', [], P('visit_feedback'), 'not_this'],
    ['not interested in this property', [], P('visit_feedback'), 'not_this'], ['didnt like it, too small', [], P('visit_feedback'), 'feedback'],
    ['Liked it but price is high', [], P('visit_feedback'), 'feedback'], ['price?', [], P('new_listing'), 'options'], ['What is the final price', [], P('new_listing'), 'options'],
    ['Call after 6', [], P('new_listing'), 'call'], ['call me tomorrow evening', [], P('followup'), 'call'], ['Will call you later', [], P('followup'), 'not_now'],
    ["don't call me, whatsapp only", [], P('followup'), 'other'], ['later', [], P('followup'), 'not_now'], ['Busy now, will check later', [], P('followup'), 'not_now'],
    ['Ok', [], P('visit_reminder'), 'ack'], ['Ok 👍', [], P('visit_reminder'), 'ack'], ['Yes', [], P('visit_reminder'), 'ack'], ['Yes', [], P('sold_out'), 'options'],
    ['Yes', [], P('new_listing'), 'options'], ['Sure', [], P('reengage'), 'options'], ['Will be 30 min late', [], P('visit_reminder'), 'other'],
    ['Coming', [], P('visit_reminder'), 'ack'], ['varen', [], P('visit_reminder'), 'ack'], ['Cannot come tomorrow, can we do Sunday', [], P('visit_reminder'), 'reschedule'],
    ['Send location', [], P('visit_reminder'), 'options'], ['Location pls', [], P('visit_reminder'), 'options'], ['Who is this?', [], P('reengage'), 'other'],
    ['How did you get my number', [], P('reengage'), 'optout'], ['Wrong number', [], P('reengage'), 'optout'], ['Stop', [], P('reengage'), 'optout'],
    ['STOP', [], P('visit_reminder'), 'optout'], ['Please stop', [], P('reengage'), 'optout'], ['dont disturb', [], P('reengage'), 'optout'], ['spam', [], P('reengage'), 'optout'],
    ['Already bought', [], P('reengage'), 'found'], ['We bought a flat in OMR last month', [], P('reengage'), 'found'], ['booked a flat already', [], P('reengage'), 'found'],
    ['We have booked the site visit', [], P('reengage'), 'visit'], ['venda', [], P('reengage'), 'not_this'], ['ippo venda', [], P('reengage'), 'not_now'],
    ['ippo vendam, next month paakalam', [], P('reengage'), 'not_now'], ['இப்போ வேண்டாம்', [], P('reengage'), 'not_now'], ['வேண்டாம்', [], P('visit_feedback'), 'not_this'],
    ['parking vendam', [], P('visit_feedback'), 'feedback'], ['budget kammi venum', [], P('reengage'), 'options'], ['Is it RERA approved', [], P('new_listing'), 'other'],
    ['Loan available?', [], P('new_listing'), 'loan'], ['Can I bring my parents on Sunday', [], P('visit_reminder'), 'other'], ['Postponed my plan to next year', [], P('followup'), 'not_now'],
    ['Thank you', ['Thank you', 'Reschedule'], P('visit_confirmed'), 'ack'], ['Thanks', [], P('visit_confirmed'), 'ack'], ['Not now', [], P('referral'), 'not_now'],
    ['Refer a friend', ['Share feedback', 'Refer a friend'], P('referral'), 'referral'], ['Show me more options', [], P('visit_feedback'), 'options'],
    ['Still looking', [], P('followup'), 'options'], ['Found a property', [], P('followup'), 'found'], ['Hi', [], P('reengage'), 'other'],
    ['interested', [], P('new_listing'), 'options'], ['Interested', [], P('visit_feedback'), 'feedback'], ['not interested now maybe after 6 months', [], P('reengage'), 'not_now'],
    ['No need', [], P('reengage'), 'not_this'], ['no need thanks', [], P('reengage'), 'not_this'], ['Remove', [], P('reengage'), 'optout'], ['Block', [], P('reengage'), 'optout'],
    ['Seller here, want to sell my flat', [], P('followup'), 'seller'],
    ['Sell or List Property', ['Buy Property', 'Rent Property', 'Sell or List Property'], { template: 'property_requirement_followup' }, 'seller'],
    ['Share Feedback', ['Share Feedback', 'Request a Call'], { template: 'post_visit_feedback' }, 'feedback'], ['NRI, call after 9pm IST', [], P('followup'), 'call'],
    ['Looking for rent only', [], P('new_listing'), 'options'], ['Liked it', [], P('visit_feedback'), 'feedback'], ['Too far from office', [], P('new_listing'), 'other'],
    ['Send brochure', [], P('new_listing'), 'options'], ['Can you reduce the price?', [], P('visit_feedback'), 'feedback'],
    ['I will come with family next Saturday', [], P('options_followup'), 'visit'], ['next week visit pannalam', [], P('options_followup'), 'visit'],
    ['contact later', [], P('followup'), 'not_now'], ['call later', [], P('followup'), 'not_now'],
    // The backend review's list.
    ['Stop please', [], {}, 'optout'], ['STOP!!', [], {}, 'optout'], ['pls stop', [], {}, 'optout'], ['no more messages', [], {}, 'optout'], ['dont want', [], {}, 'not_this'],
    ['not required', [], {}, 'not_this'], ['No thanks', [], {}, 'not_this'], ['Not interested, stop', [], {}, 'optout'], ['I am not interested anymore thank you sir', [], {}, 'not_this'],
    ['Please do not call or message', [], {}, 'optout'], ['stop calling me', [], {}, 'optout'], ['Do not disturb', [], {}, 'optout'], ['Not interested in buying now, maybe next year', [], {}, 'not_now'],
    ["don't call me, just whatsapp the details", [], {}, 'options'], ['Stop sending 2BHK, send 3BHK options', [], {}, 'options'], ['I have not bought any property yet', [], {}, 'other'],
    ['have you found a property for me?', [], {}, 'other'], ['Call me later', [], {}, 'not_now'], ['not now, call me next week', [], {}, 'call'],
    // Tanglish from the marketing notes.
    ['seri', [], {}, 'ack'], ['sari sir', [], {}, 'ack'], ['evlo?', [], P('new_listing'), 'options'], ['rate enna', [], {}, 'options'], ['naalaiku call pannunga', [], {}, 'call'],
    ['saayangalam call pannunga', [], {}, 'call'], ['late aagum', [], P('visit_reminder'), 'other'], ['varala', [], P('visit_reminder'), 'reschedule'],
    ['vara mudiyadhu', [], P('visit_reminder'), 'reschedule'], ['thollai pannadheenga', [], {}, 'optout'], ['message anuppadheenga', [], {}, 'optout'],
    ['neenga yaaru', [], {}, 'other'], ['pidikala', [], P('visit_feedback'), 'not_this'], ['pudikala', [], P('new_listing'), 'not_this'],
    ['Stop offers', ['Send details', 'Book a visit', 'Stop offers'], P('new_listing'), 'marketing_optout'], ['please stop sending offers', [], {}, 'marketing_optout'],
    ['Yes, send them', ['Yes, send them', 'Not now', 'Stop offers'], P('sold_out'), 'options'], ['உறுதி', ['உறுதி', 'நேரம் மாற்ற'], P('visit_reminder'), 'ack'],
    [MEDIA_REPLY, [], P('visit_feedback'), 'other']
  ];
  const wrong = table.filter(([t, b, c, want]) => classifyReply(t, b, c) !== want).map(([t, b, c, want]) => `${t} [${c.purpose || c.template || '-'}] → ${classifyReply(t, b, c)} (want ${want})`);
  check(`${table.length} replies read as a person would`, !wrong.length, wrong);
  check('“who are you” is flagged to answer personally', readReply('Who is this?', [], {}).note === 'Asked who we are — reply personally');
  check('a location ask says so', readReply('Send location', [], { purpose: 'visit_reminder' }).note === 'Asked for the location — share the map pin');
  check('a photo says so', readReply(MEDIA_REPLY, [], {}).note === 'Sent a photo or file — open the chat');
}

section('fix: when — the follow-up time a reply names (IST)');
{
  const ist = (d, h, m = 0) => Date.parse(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
  const at = ist('2026-11-04', 10, 30);   // a Wednesday
  const cases = [
    ['call after 6', ist('2026-11-04', 18)], ['after 6pm', ist('2026-11-04', 18)], ['evening', ist('2026-11-04', 18)], ['morning', ist('2026-11-05', 10)],
    ['tomorrow', ist('2026-11-05', 10)], ['naalaiku saayangalam', ist('2026-11-05', 18)], ['call me tomorrow evening', ist('2026-11-05', 18)],
    ['Sunday', ist('2026-11-08', 10)], ['next week', ist('2026-11-11', 10)], ['next month', ist('2026-12-04', 10)], ['6 months', ist('2027-05-03', 10)],
    ['next year', ist('2027-08-31', 10)], ['after Pongal', ist('2027-01-17', 10)], ['after diwali', ist('2026-11-11', 10)], ['at 9:30 am', ist('2026-11-05', 9, 30)],
    ['after 9pm IST', ist('2026-11-04', 21)], ['hello', null]
  ];
  const bad = cases.filter(([t, want]) => parseWhen(t, at) !== want).map(([t, want]) => `${t}: ${parseWhen(t, at) && new Date(parseWhen(t, at)).toISOString()} (want ${want && new Date(want).toISOString()})`);
  check('times, days, months and festivals', !bad.length, bad);
  check('“call later” is a few days out', readReply('call later', [], { at }).when === at + 3 * DAY && readReply('call later', [], { at }).action === 'not_now');
  check('“not now” with no time is a month (the default)', !readReply('Not now', [], { at }).when);
}

section('fix: what each new action writes on the lead');
{
  const w = world();
  await w.db.collection('pipelines').doc(TENANT).set({ stages: [{ id: 's_neg', key: 'negotiation', name: 'Negotiating' }] });
  const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  for (const [i, k] of ids.entries()) await addLead(w.db, k, '90000000' + (21 + i), k === 'F' ? { stageId: 's_neg' } : k === 'G' ? { marketingUnanswered: 2 } : {});
  const id = await sendCampaign(w, 'Visit reminder', 'post_visit_feedback', ids.map((k, i) => ({ leadId: k, contact: '90000000' + (21 + i), values: vals(k) })));
  const at = T0 + 20 * MIN;
  const say = (k, text) => applyCampaignReplies(w.db, TENANT, k, null, [tplMsg(T0 + 1000), userMsg(at, text)], { now: at + MIN });
  await say('A', 'ok thanks');
  await say('B', 'Not interested');
  await say('C', 'Stop offers');
  await say('D', 'Call after 6');
  await say('E', 'I want to sell my flat');
  await say('F', 'Already bought a flat');
  await say('G', 'Liked it');
  const L = k => w.db._get('leads/' + k);
  const c = w.db._get('campaigns/' + id);
  check('ack: on the campaign and in the log only — no open reply, no follow-up, no history', c.recipients.A.reply.action === 'ack' && !L('A').campaignReply && !L('A').followUpAt && L('A').campaignLog[0].action === 'ack' && historyOf(w.db, 'A').length === 0, L('A'));
  check('not this: no follow-up, the property named, never an opt-out', L('B').campaignReply.action === 'not_this' && L('B').campaignReply.note === 'Not interested in ANR003' && L('B').campaignReply.code === 'ANR003' && L('B').campaignReply.property === 'Sunrise' && !L('B').followUpAt && !L('B').waOptOut, L('B').campaignReply);
  check('stop offers: no offers, not a full opt-out, on the no-offers list', L('C').waMarketingOptOut === true && L('C').waMarketingOptOutReason === 'replied stop offers' && !L('C').waOptOut && !L('C').followUpAt
    && w.db._get('campaignSettings/' + TENANT).marketingOptOut.includes('919000000023') && !(w.db._get('campaignSettings/' + TENANT).optOut || []).includes('919000000023'));
  const six = Date.parse('2026-11-04T18:00:00+05:30');
  check('call after 6: the follow-up is 6 PM, kept on the reply too', L('D').followUpAt === six && L('D').campaignReply.followUpAt === six && c.recipients.D.reply.followUpAt === six && /Asked for a call — Visit reminder \(/.test(L('D').followUpNote), [L('D').followUpAt, L('D').followUpNote]);
  check('seller: follow-up now', L('E').campaignReply.action === 'seller' && L('E').followUpNote === 'Wants to sell/list' && L('E').followUpAt === at);
  check('found while Negotiating: “check if it was with us”, never “mark Lost?”', L('F').followUpNote === 'Says they booked — check if it was with us', L('F').followUpNote);
  check('a real answer resets marketingUnanswered', L('G').marketingUnanswered === 0);
  // An "ok" after a real answer does not hide it.
  await applyCampaignReplies(w.db, TENANT, 'D', null, [tplMsg(T0 + 1000), userMsg(at, 'Call after 6'), userMsg(at + MIN, 'ok')], { now: at + 2 * MIN });
  check('an ok after “call after 6” keeps the call shown', w.db._get('campaigns/' + id).recipients.D.reply.action === 'call' && L('D').campaignReply.action === 'call' && L('D').campaignLog[0].action === 'call');
  check('…but marks the message seen', w.db._get('campaigns/' + id).recipients.D.replyKeys.length === 2);
}
{
  // A visit template: "Confirm" is an ack that records the confirmation.
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  const r = await w.run({ op: 'create', name: 'Reminder', template: 'site_visit_unavailable_update', vars: ['name'], purpose: 'visit_reminder', recipients: [{ leadId: 'L1', contact: '9000000001', values: { name: 'R' } }] });
  await w.run({ op: 'send', id: r.id });
  await applyCampaignReplies(w.db, TENANT, 'L1', null, [tplMsg(T0 + 1000, 'site_visit_unavailable_update'), userMsg(T0 + 5 * MIN, 'Confirm')], { now: T0 + 6 * MIN });
  const l = w.db._get('leads/L1');
  check('visit confirmed: siteVisitConfirmedAt, nothing open', l.siteVisitConfirmedAt === T0 + 5 * MIN && !l.campaignReply && !l.followUpAt, l);
}

section('fix: real chat shapes');
{
  const human = (at, text) => ({ role: 'assistant', content: '', message_id: null, time: iso(at), metadata: { type: 'human_agent', message: text, email: 'agent@x' } });
  check('a person on the team answering ends the reply', JSON.stringify(replyCandidates([tplMsg(T0), userMsg(T0 + MIN, 'Request a Call'), human(T0 + 5 * MIN, 'Calling you at 6'), userMsg(T0 + 6 * MIN, 'ok thanks')]).map(c => c.text)) === '["Request a Call"]');
  const img = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/u.jpg' } }], time: iso(T0 + MIN), message_id: 'wamid.d', metadata: { type: 'document', url: 'https://x/u.jpg' } };
  check('a photo (content list) is “sent a photo/file”', replyCandidates([tplMsg(T0), img])[0].text === MEDIA_REPLY);
  check('…and an empty one with a document', replyCandidates([tplMsg(T0), { ...img, content: '' }])[0].text === MEDIA_REPLY);
  const quoted = 'Hi Ravi! Thank you for visiting Sunrise';
  const swipe = { role: 'user', content: quoted + ':\n', time: iso(T0 + MIN), message_id: 'wamid.r', metadata: { type: 'reply', replied_to_message_id: 'wamid.T', text: quoted, user_message: '' } };
  const sc = replyCandidates([tplMsg(T0), swipe])[0];
  check('a swipe-reply with nothing typed is not the quoted text', sc.text === MEDIA_REPLY && sc.repliedTo === 'wamid.T', sc);
  const params = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['v' + i, 'x'.repeat(200)]));
  const big = { role: 'assistant', content: '', message_id: null, time: iso(T0), metadata: { type: 'template', template_name: 'promo_x', template_params: params } };
  check('a template with long values is still a template', replyCandidates([big, userMsg(T0 + MIN, 'STOP')]).length === 1);
  const n = normaliseChat([big])[0];
  check('…normaliseChat keeps what it was, not the values', n.meta && n.meta.type === 'template' && n.meta.template_name === 'promo_x' && !n.meta.template_params);
}

section('fix: the reply goes where it belongs');
{
  // Two CRM leads on one number: the reply is filed on the lead the campaign messaged.
  const w = world();
  await addLead(w.db, 'A', '9000000001');
  await addLead(w.db, 'B', '9000000001');
  const id = await sendCampaign(w, 'Feedback', 'post_visit_feedback', [{ leadId: 'A', contact: '9000000001', values: vals('A') }]);
  const r = await applyCampaignReplies(w.db, TENANT, 'B', null, [tplMsg(T0 + 1000), userMsg(T0 + 2 * MIN, 'Request a Call')], { now: T0 + 3 * MIN, contact: '919000000001' });
  check('filed on A (messaged), not B (whose chat it came in)', r.applied[0].lead === 'A' && w.db._get('leads/A').campaignReply.action === 'call' && !w.db._get('leads/B').campaignReply && historyOf(w.db, 'A').length === 1 && historyOf(w.db, 'B').length === 0, r);
  check('the campaign counts it', w.db._get('campaigns/' + id).recipients.A.status === 'replied');
}
{
  // The lead swiped "reply" on one of two sends of the same template minutes apart.
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  const first = await sendCampaign(w, 'One', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('R') }]);
  w.clock.t = T0 + 5 * MIN;
  const second = await sendCampaign(w, 'Two', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('R') }]);
  const firstMsg = w.db._get('campaigns/' + first).recipients.L1.messageId;
  const swipe = { role: 'user', content: 'Hi:\nRequest a Call', time: iso(T0 + 6 * MIN), message_id: 'wamid.s', metadata: { type: 'reply', replied_to_message_id: firstMsg, text: 'Hi', user_message: 'Request a Call' } };
  const r = await applyCampaignReplies(w.db, TENANT, 'L1', null, [tplMsg(T0 + 1000), tplMsg(T0 + 5 * MIN + 1000), swipe], { now: T0 + 7 * MIN });
  check('the message they replied to decides the campaign', r.applied[0] && r.applied[0].campaignId === first && w.db._get('campaigns/' + second).recipients.L1.status === 'sent', r);
}
{
  // A send recorded as failed (TailorTalk errored after it went out) — the chat proves it arrived.
  const w = world();
  w.deps.fetch = (orig => async (url, o) => (url.includes('send_whatsapp') ? { ok: false, status: 400, text: async () => JSON.stringify({ detail: 'Something went wrong', success: false }) } : orig(url, o)))(w.deps.fetch);
  await addLead(w.db, 'L1', '9000000001');
  const id = await sendCampaign(w, 'C', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('R') }]);
  check('(recorded as failed)', w.db._get('campaigns/' + id).recipients.L1.status === 'failed');
  const r = await applyCampaignReplies(w.db, TENANT, 'L1', null, [tplMsg(T0 + 1000), userMsg(T0 + 5 * MIN, 'Request a Call')], { now: T0 + 6 * MIN });
  const x = w.db._get('campaigns/' + id).recipients.L1;
  check('a “failed” send that the chat shows arrived takes the reply', r.applied.length === 1 && x.status === 'replied' && x.arrived === true && !x.error && w.db._get('campaigns/' + id).counts.failed === 0, x);
}
{
  // A CSV campaign (sent by hand through TailorTalk's broadcast) is matched by number.
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  const c = await w.run({ op: 'create', mode: 'csv', name: 'CSV', template: 'post_visit_feedback', vars: VARS, recipients: [{ leadId: 'L1', contact: '9000000001', values: vals('R') }] });
  const r = await applyCampaignReplies(w.db, TENANT, 'L1', null, [tplMsg(T0 + 2 * DAY), userMsg(T0 + 2 * DAY + MIN, 'Send brochure')], { now: T0 + 2 * DAY + 2 * MIN });
  check('a reply to an exported campaign is filed', r.applied.length === 1 && r.applied[0].campaignId === c.id && w.db._get('campaigns/' + c.id).recipients.L1.status === 'replied', r);
}

section('fix: partial failures and races are retried, never lost');
{
  // F5: the opt-out list write fails once — the replay records it (the lead is written last).
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  const id = await sendCampaign(w, 'A', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('R') }]);
  const chat = [tplMsg(T0 + 1000), userMsg(T0 + 5 * MIN, 'STOP')];
  const realTx = w.db.runTransaction.bind(w.db);
  let failOnce = true;
  w.db.runTransaction = async fn => { if (failOnce && /addOptOut/.test(new Error().stack)) { failOnce = false; throw new Error('ABORTED: contention'); } return realTx(fn); };
  let threw = false;
  try { await applyCampaignReplies(w.db, TENANT, 'L1', null, chat, { now: T0 + 6 * MIN }); } catch { threw = true; }
  check('(the first pass failed)', threw && !w.db._get('leads/L1').waOptOut);
  const r = await applyCampaignReplies(w.db, TENANT, 'L1', null, chat, { now: T0 + 7 * MIN });
  check('the replay records it: list, lead, campaign', r.applied.length === 1 && w.db._get('campaignSettings/' + TENANT).optOut.includes('919000000001') && w.db._get('leads/L1').waOptOut === true && w.db._get('campaigns/' + id).recipients.L1.replyKeys.length === 1, r);
}
{
  // F10: a send landing while a reply is recorded keeps its entry in the lead's campaign history.
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  await sendCampaign(w, 'A', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('R') }]);
  w.clock.t = T0 + 3 * DAY;
  const b = await w.run({ op: 'create', name: 'B', template: 'site_visit_unavailable_update', vars: ['name'], recipients: [{ leadId: 'L1', contact: '9000000001', values: { name: 'R' } }] });
  const realTx = w.db.runTransaction.bind(w.db);
  let once = true;
  w.db.runTransaction = async fn => { if (once && /applyCampaignReplies/.test(new Error().stack)) { once = false; await w.run({ op: 'send', id: b.id }); } return realTx(fn); };
  await applyCampaignReplies(w.db, TENANT, 'L1', null, [tplMsg(T0 + 1000), userMsg(T0 + 5 * MIN, 'Request a Call')], { now: T0 + 3 * DAY });
  const log = w.db._get('leads/L1').campaignLog.map(e => e.name + ':' + e.status);
  check('both entries survive', log.includes('B:sent') && log.includes('A:replied'), log);
}
{
  // P2-7: the webhook for reply 1 was missed; reply 2 (same template, two days on) was recorded.
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  const c1 = await sendCampaign(w, 'One', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('R') }]);
  w.clock.t = T0 + 2 * DAY;
  await sendCampaign(w, 'Two', 'post_visit_feedback', [{ leadId: 'L1', contact: '9000000001', values: vals('R') }]);
  const chat = [tplMsg(T0 + 1000), userMsg(T0 + 5 * MIN, 'Request a Call'), aiMsg(T0 + 6 * MIN, 'Sure'), tplMsg(T0 + 2 * DAY + 1000), userMsg(T0 + 2 * DAY + 5 * MIN, 'Not now')];
  await applyCampaignReplies(w.db, TENANT, 'L1', null, chat.slice(3), { now: T0 + 2 * DAY + 6 * MIN });
  const p = await applyCampaignReplies(w.db, TENANT, 'L1', null, chat, { now: T0 + 3 * DAY });
  check('the pull recovers the missed one', p.applied.length === 1 && p.applied[0].campaignId === c1 && w.db._get('campaigns/' + c1).recipients.L1.status === 'replied', p);
  const again = await applyCampaignReplies(w.db, TENANT, 'L1', null, chat, { now: T0 + 3 * DAY + MIN });
  check('…and then the chat costs no campaign reads', again.skipped === 'already recorded', again);
}
{
  // F13: replies to a template no campaign sent, or one long gone, cost nothing after the first look.
  const w = world();
  await addLead(w.db, 'L1', '9000000001');
  await addLead(w.db, 'X', '9000000002');
  await sendCampaign(w, 'Other', 'post_visit_feedback', [{ leadId: 'X', contact: '9000000002', values: vals('X') }]);
  const old = [tplMsg(T0 - 60 * DAY), userMsg(T0 - 60 * DAY + MIN, 'ok')];
  const r0 = w.db._stats.reads, q0 = w.db._stats.queries.length;
  for (let k = 0; k < 5; k++) await applyCampaignReplies(w.db, TENANT, 'L1', null, [...old, aiMsg(T0 + k * DAY, 'hi'), userMsg(T0 + k * DAY + MIN, 'msg ' + k)], { now: T0 + k * DAY + 2 * MIN });
  check('a 60-day-old template: no reads at all', w.db._stats.reads === r0 && w.db._stats.queries.length === q0, w.db._stats.reads - r0);
  const stray = [tplMsg(T0 + 1000), userMsg(T0 + 2 * MIN, 'hi')];   // TailorTalk's own broadcast this morning
  await applyCampaignReplies(w.db, TENANT, 'L1', null, stray, { now: T0 + 3 * MIN });
  const q1 = w.db._stats.queries.filter(q => q.collPath === 'campaigns').length;
  for (let k = 1; k <= 3; k++) await applyCampaignReplies(w.db, TENANT, 'L1', null, [...stray, userMsg(T0 + (2 + k) * MIN, 'more ' + k)], { now: T0 + (3 + k) * MIN });
  check('a template no campaign sent is looked up once, then remembered on the lead', w.db._stats.queries.filter(q => q.collPath === 'campaigns').length === q1 && Object.keys(w.db._get('leads/L1').campaignReplySeen || {}).length === 1, w.db._get('leads/L1').campaignReplySeen);
}

section('fix: the digest’s news is used up only once it is sent');
{
  const db = createFakeDb();
  await db.collection('campaignTemplates').doc(TENANT + '__promo_x').set({ tenantId: TENANT, name: 'promo_x', submittedAt: T0 });
  const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { templates: [{ template_name: 'promo_x', template_status: 'APPROVED' }] }, success: true }) });
  const a = await campaignDigest(db, TENANT, { now: T0, token: 'tok', fetch });
  const b = await campaignDigest(db, TENANT, { now: T0 + MIN, token: 'tok', fetch });
  check('built twice (a manual send, a failed run): still news', a.templates.length === 1 && b.templates.length === 1);
  await b.commit();
  const c = await campaignDigest(db, TENANT, { now: T0 + 2 * MIN, token: 'tok', fetch });
  check('after commit: recorded', c.templates.length === 0 && db._get('campaignTemplates/' + TENANT + '__promo_x').lastStatus === 'APPROVED');
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  const d = await campaignDigest(db, TENANT, { now: T0, token: 'tok', fetch: hang }).catch(e => e);
  check('a hung TailorTalk never stops the digest (10 s)', d && d.templates && d.templates.length === 0 && Date.now() - t0 < 12000);
}

function HOUR(n) { return n * 3600000; }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
