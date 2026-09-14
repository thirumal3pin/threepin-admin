// ═══════ TAILORTALK → CRM SYNC ═══════
//
// Runs the real webhook mapping (api/_tailortalk-shared.js) and the real Firestore half
// (api/_tailortalk-sync.js, against tests/_fake-firestore.mjs) on TailorTalk's own sample
// payload. The owner's rule under test: a lead always carries TailorTalk's LATEST details.
//
//   node tests/tailortalk.test.mjs

import { readFileSync } from 'node:fs';
import {
  planUpdate, shortValue, clean, contactParts, enquiryTypeFor, channelFor, isTestEnvelope,
  mergeChat, normaliseChat, ttLeadDocId, CHAT_BYTES_CAP, normaliseSignal
} from '../api/_tailortalk-shared.js';
import { applyTailorTalkEvent, pullTailorTalkPage, _clearConfigCache } from '../api/_tailortalk-sync.js';
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

const SAMPLE = JSON.parse(readFileSync(new URL('./fixtures/tailortalk-sample.json', import.meta.url), 'utf8'));
const TENANT = 't_3pinrealty';
const STAGES = [{ id: 'new', name: 'New' }, { id: 'contacted', name: 'Contacted' }, { id: 'closed_won', name: 'Closed Won' }];
const TYPES = ['Property Enquiry', 'Seller Listing', 'General'];
const NOW = Date.parse('2026-09-13T13:00:00Z');

// A real (non-sample) event built from the sample, with overrides on data.
function real(overrides = {}, envelopeOverrides = {}) {
  const e = JSON.parse(JSON.stringify(SAMPLE));
  e.webhook_trigger = 'every_message';
  e.data.id = 'agent1_whatsapp_919876543210';
  e.data.lead_contact = '919876543210';
  Object.assign(e.data, overrides);
  return Object.assign(e, envelopeOverrides);
}

function hasUndefined(v) {
  if (v === undefined) return true;
  if (v && typeof v === 'object') return Object.values(v).some(hasUndefined);
  return false;
}

console.log('3 PIN Realty — TailorTalk sync');

// ───────────────────────────────────────────────────────────────────────────
section('Reading the AI profile fields');
eq('Location headline', shortValue(SAMPLE.data.preferred_location), 'Velachery');
eq('Budget headline keeps the decimal', shortValue(SAMPLE.data.budget_and_finance, 40), '3.3 Cr');
eq('Stage headline', shortValue(SAMPLE.data.stage_and_next_action, 40), 'Negotiating');
eq('An initial is not a sentence break', shortValue('T. Nagar (earlier: Adyar). Close to school.'), 'T. Nagar');
eq('Double initials survive', shortValue('K.K. Nagar. Wants a park-facing flat.'), 'K.K. Nagar');
eq('Rs. is not a sentence break', shortValue('Rs. 80 L (negotiable)'), 'Rs. 80 L');
eq('Placeholder text reads as empty', clean('Not mentioned'), null);
eq('Blank reads as empty', shortValue('   '), null);
check('Long headline is cut at a word with an ellipsis', /…$/.test(shortValue('a'.repeat(10) + ' ' + 'b'.repeat(70))));

eq('Phone contact', contactParts('+91 98765 43210'), { phone: '+91 98765 43210', phoneKey: '919876543210', email: '', handle: '' });
eq('10-digit phone gets +91', contactParts('9876543210').phoneKey, '919876543210');
eq('Instagram username', contactParts('@chennai_buyer').handle, 'chennai_buyer');
eq('Masked number is not a phone', contactParts('91********').phone, '');
eq('Web chat email', contactParts('a.b@example.com').email, 'a.b@example.com');

eq('Buyer intent', enquiryTypeFor(SAMPLE.data.intent_and_who, TYPES), 'Property Enquiry');
eq('Seller intent', enquiryTypeFor('Sell, owner of a 2 BHK in Anna Nagar, wants a quick sale.', TYPES), 'Seller Listing');
eq('Rent-out is a seller', enquiryTypeFor('Rent out, landlord with 3 flats', TYPES), 'Seller Listing');
eq('Unknown intent gives nothing', enquiryTypeFor('Just asking about the office timings', TYPES), null);
eq('A type the tenant does not have is not invented', enquiryTypeFor('Buy, residential', ['General']), null);

eq('WhatsApp channel', channelFor('whatsapp', 'whatsapp_ad'), 'whatsapp');
eq('Instagram channel', channelFor('instagram', 'instagram_dm'), 'instagram');
eq('Web chat maps to the dashboard\'s website channel', channelFor('web', 'web_chat'), 'website');

check('TailorTalk\'s sample payload is recognised as a test', isTestEnvelope(SAMPLE));
check('A real event is not a test', !isTestEnvelope(real()));
eq('Lead doc id is Firestore-safe', ttLeadDocId(TENANT, 'a/b c+d'), 'tt_t_3pinrealty_a_b_c_d');

// ───────────────────────────────────────────────────────────────────────────
section('First message: a new lead');
const first = planUpdate({ envelope: real(), lead: null, state: null, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW });
const lw = first.leadWrite;
check('Creates a lead', first.isNew);
check('Nothing undefined in the lead write', !hasUndefined(lw));
check('Nothing undefined in the state write', !hasUndefined(first.stateWrite));
eq('Name', lw.name, 'John Doe');
eq('Phone', lw.phone, '919876543210');
eq('phoneKey stored for duplicate checks', lw.phoneKey, '919876543210');
eq('Channel', lw.channel, 'whatsapp');
eq('Source', lw.source, 'tailortalk');
eq('Lands in the first stage', lw.stageId, 'new');
eq('Enquiry type', lw.enquiryType, 'Property Enquiry');
eq('Property / Locality', lw.propertyInterest, 'Velachery');
eq('Budget', lw.budget, '3.3 Cr');
eq('Created at TailorTalk\'s own created_at', lw.createdAt, Date.parse('2026-09-13T18:22:50+05:30'));
eq('Status', lw.tt.status, 'cold');
eq('Ad title', lw.tt.adTitle, 'Summer Sale Campaign 2026');
eq('Lead source', lw.tt.leadSource, 'whatsapp_ad');
eq('Tenant', lw.tenantId, TENANT);
eq('Nothing held yet', lw.ttHold, {});
eq('Last lead message time', lw.tt.lastMessageAt, Date.parse('2026-09-13T12:52:50+00:00'));
check('History says where it came from', first.history[0].type === 'created' && /WhatsApp ad · Summer Sale Campaign 2026/.test(first.history[0].text), first.history[0] && first.history[0].text);
eq('Booking + payment are recorded once, in history — not duplicated as notes', first.notes.length, 0);
check('Booking is in history', first.history.some(h => /Booked through TailorTalk: <b>Product demo call<\/b>/.test(h.text)));
check('Booking keeps its meeting link in the stored bookings', first.stateWrite.bookings[0].link === 'https://meet.google.com/sample-link');
check('Razorpay paise read as rupees (50000 → ₹500)', first.history.some(h => /₹500\b/.test(h.text)), first.history.map(h => h.text).join(' | '));
check('No raw payload copy stored (every field already lives in one place)', !('lastRaw' in first.stateWrite) && !('ad' in first.stateWrite));
check('Location / budget not stored twice on tt', !('location' in lw.tt) && !('budget' in lw.tt) && lw.tt.values.budget === '3.3 Cr');
eq('Booked visit becomes the follow-up', lw.followUpAt, Date.parse('2026-09-14T18:22:50+05:30'));
eq('Shopify orders are ignored', first.stateWrite.payments.length, 1);
eq('Conversation stored', first.stateWrite.chat.length, 3);
eq('Same-second messages keep their order', first.stateWrite.chat.map(m => m.role), ['user', 'assistant', 'human_agent']);
eq('Team member email kept on their message', first.stateWrite.chat[2].email, 'agent@example.com');
eq('Profile keeps the full text', first.stateWrite.profile.budget_and_finance, SAMPLE.data.budget_and_finance);
check('The chat is stored once (only in state.chat)', !JSON.stringify({ ...first.stateWrite, chat: [] }).includes('I am interested in your services'));

// ───────────────────────────────────────────────────────────────────────────
section('Every later message refreshes the lead (the latest-details rule)');
// What Firestore would hold after the first event.
const lead1 = { ...lw, notes: undefined };
delete lead1.notes;
const state1 = first.stateWrite;
const warm = real({
  lead_status: 'warm',
  budget_and_finance: '3.6 Cr (earlier: 3.3 Cr). Stretching for a corner unit.',
  stage_and_next_action: 'Site visit booked. Next action: confirm cab pickup.',
  lead_lock_status: true,
  total_followups: 2,
  chat_history: [...SAMPLE.data.chat_history, { role: 'user', content: 'Can we see VLCA002 on Sunday?', time: '2026-09-13T13:10:00+00:00', message_id: 'wamid.X', metadata: null }]
}, { occurred_at: '2026-09-13T18:40:50+05:30' });
const second = planUpdate({ envelope: warm, lead: lead1, state: state1, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 600000 });
check('Not a new lead', !second.isNew);
eq('Status updated', second.leadWrite.tt.status, 'warm');
eq('Budget followed TailorTalk', second.leadWrite.budget, '3.6 Cr');
eq('AI follow-up count updated', second.leadWrite.tt.followups, 2);
check('AI-paused flag updated', second.leadWrite.tt.locked === true);
const texts = second.history.map(h => h.text).join(' | ');
check('History: status change', /status changed from <b>Cold<\/b> to <b>Warm<\/b>/.test(texts), texts);
check('History: budget change', /Budget changed from <b>3\.3 Cr<\/b> to <b>3\.6 Cr<\/b>/.test(texts), texts);
check('History: AI paused', /AI paused/.test(texts), texts);
check('History: TailorTalk stage', /TailorTalk stage: <b>Negotiating<\/b> → <b>Site visit booked<\/b>/.test(texts), texts);
check('Same booking and payment are not repeated', !second.history.some(h => /Booked through|Payment authorised/.test(h.text)));
eq('New message appended once', second.stateWrite.chat.length, 4);
eq('Last message time moves forward', second.leadWrite.tt.lastMessageAt, Date.parse('2026-09-13T13:10:00+00:00'));
check('Team fields untouched (no stage / follow-up change)', !('stageId' in second.leadWrite) && !('followUpAt' in second.leadWrite));

const again = planUpdate({ envelope: warm, lead: { ...lead1, ...second.leadWrite }, state: second.stateWrite, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 700000 });
eq('The same payload twice changes nothing in history', again.history.length, 0);
eq('…and adds no chat duplicates', again.stateWrite.chat.length, 4);

// ───────────────────────────────────────────────────────────────────────────
section('A late retry cannot roll the lead back');
const lead2 = { ...lead1, ...second.leadWrite };
const late = real({
  lead_status: 'cold',
  chat_history: [...SAMPLE.data.chat_history, { role: 'user', content: 'Late but real message', time: '2026-09-13T13:05:00+00:00' }]
}, { occurred_at: '2026-09-13T18:30:00+05:30' });
const stale = planUpdate({ envelope: late, lead: lead2, state: second.stateWrite, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 800000 });
check('Marked stale', stale.stale);
eq('Status stays warm', stale.leadWrite.tt.status, 'warm');
check('No budget rollback', !('budget' in stale.leadWrite));
eq('No history for going backwards', stale.history.length, 0);
eq('Its message is still kept', stale.stateWrite.chat.length, 5);
eq('Profile keeps the newer text', stale.stateWrite.profile.budget_and_finance, second.stateWrite.profile.budget_and_finance);

// ───────────────────────────────────────────────────────────────────────────
section('A field the team edited is theirs');
const held = { ...lead2, budget: '3.5 Cr (owner said)', ttHold: { budget: true } };
const newer = real({ lead_status: 'hot', budget_and_finance: '4 Cr. Final.' }, { occurred_at: '2026-09-13T19:00:00+05:30' });
const h1 = planUpdate({ envelope: newer, lead: held, state: second.stateWrite, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 900000 });
check('Budget not overwritten', !('budget' in h1.leadWrite));
eq('TailorTalk\'s value still recorded on tt', h1.leadWrite.tt.values.budget, '4 Cr');
check('History notes what TailorTalk now says', h1.history.some(h => /TailorTalk now says budget is <b>4 Cr<\/b> — kept <b>3\.5 Cr \(owner said\)<\/b>/.test(h.text)), h1.history.map(h => h.text).join(' | '));
const h2 = planUpdate({ envelope: newer, lead: { ...held, ...h1.leadWrite }, state: h1.stateWrite, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 950000 });
check('…and says it only once', !h2.history.some(h => /now says/.test(h.text)));
check('Unheld fields still follow (status → hot)', h1.leadWrite.tt.status === 'hot');

// ───────────────────────────────────────────────────────────────────────────
section('Linking to a lead the team already typed in');
const manual = { id: 'lead_1', tenantId: TENANT, name: 'Karthik S', phone: '98765 43210', email: '', budget: '1.8 Cr', propertyInterest: '', enquiryType: 'Property Enquiry', stageId: 'contacted', source: 'manual', followUpAt: NOW + 86400000 * 3 };
const link = planUpdate({ envelope: real(), lead: manual, state: null, leadId: 'lead_1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW });
check('Not new', !link.isNew);
check('Typed name kept', !('name' in link.leadWrite));
check('Typed budget kept', !('budget' in link.leadWrite));
eq('Blank locality filled', link.leadWrite.propertyInterest, 'Velachery');
eq('Filled fields are held', link.leadWrite.ttHold, { name: true, budget: true, enquiryType: true });
eq('phoneKey stamped', link.leadWrite.phoneKey, '919876543210');
check('History says it was linked, with a snapshot', link.history.some(h => /📥 Linked to a conversation from <b>TailorTalk<\/b> — Cold · 3 messages \(1 from the lead\)/.test(h.text)), link.history.map(h => h.text).join(' | '));
check('…and dates the conversation\'s first message', link.history.some(h => /First message on WhatsApp/.test(h.text) && h.at === Date.parse('2026-09-13T12:52:50+00:00')));
check('A follow-up the team set that is still ahead is kept', !('followUpAt' in link.leadWrite));
check('Source stays manual', !('source' in link.leadWrite));

// ───────────────────────────────────────────────────────────────────────────
section('Other channels and odd payloads');
const ig = planUpdate({ envelope: real({ id: 'agent1_instagram_chennai_buyer', lead_contact: 'chennai_buyer', integration: 'instagram', lead_source: 'instagram_dm', metadata: [], lead_name: null }), lead: null, state: null, leadId: 'L2', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW });
eq('Instagram lead has no phone', ig.leadWrite.phone, '');
eq('Instagram handle kept', ig.leadWrite.tt.handle, 'chennai_buyer');
eq('Named by handle when there is no name', ig.leadWrite.name, '@chennai_buyer');
eq('Instagram channel', ig.leadWrite.channel, 'instagram');

const xss = planUpdate({ envelope: real({ lead_name: '<img src=x onerror=alert(1)>', ad_data: { title: '<b>Ad</b>' } }), lead: null, state: null, leadId: 'L3', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW });
check('Payload text is escaped in history HTML', !/<img|<b>Ad/.test(xss.history.map(h => h.text).join('')));

const pastBooking = real({ metadata: [{ type: 'booking', booking_id: 'b_old', start_time: '2026-09-01T10:00:00+05:30', summary: 'Old visit' }] });
const pb = planUpdate({ envelope: pastBooking, lead: null, state: null, leadId: 'L4', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW });
eq('A booking in the past does not set a follow-up', pb.leadWrite.followUpAt, null);

const custom = real({ site_visit_date: '2026-09-20', loan_needed: 'Yes', some_object: { a: 1 } });
const cu = planUpdate({ envelope: custom, lead: null, state: null, leadId: 'L5', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW });
eq('Unknown custom attributes kept in extra', cu.stateWrite.extra, { site_visit_date: '2026-09-20', loan_needed: 'Yes' });

const precise = normaliseChat([{ role: 'assistant', content: 'Hello', time: '2026-09-13T12:05:28.710093+00:00' }]);
const coarse = normaliseChat([{ role: 'assistant', content: 'Hello', time: '2026-09-13T12:05:28+00:00' }]);
eq('The same message with a different time precision (webhook vs get_leads) is stored once', mergeChat(precise, coarse).chat.length, 1);

const big = normaliseChat(Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: 'x'.repeat(20000) + i, time: new Date(NOW + i * 1000).toISOString() })));
const capped = mergeChat([], big);
check('Chat past the size cap drops the oldest', capped.truncated && capped.chat.length < 40 && JSON.stringify(capped.chat).length <= CHAT_BYTES_CAP);
check('…keeping the newest', capped.chat[capped.chat.length - 1].content.endsWith('39'));

// ───────────────────────────────────────────────────────────────────────────
section('Custom-trigger signals');
eq('Signal names are normalised', normaliseSignal(' Wants_Contact '), 'wants_contact');
eq('Junk signal names are ignored', normaliseSignal('drop table; --'), null);
{
  const askCall = real({ chat_history: [...SAMPLE.data.chat_history, { role: 'user', content: 'Please call me at 6 pm today', time: '2026-09-13T13:20:00+00:00' }] }, { webhook_trigger: 'custom', occurred_at: '2026-09-13T18:51:00+05:30' });
  const leadNow = { ...lead1, updatedAt: Date.parse('2026-09-13T12:00:00Z') };
  const s1 = planUpdate({ envelope: askCall, lead: leadNow, state: state1, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW, signal: 'wants_contact' });
  const sig = s1.leadWrite.tt.signals.wants_contact;
  check('Signal recorded on tt', !!sig);
  eq('…at when it happened', sig.at, Date.parse('2026-09-13T18:51:00+05:30'));
  eq('…with the lead\'s own words', sig.quote, 'Please call me at 6 pm today');
  check('History says what they want, with the quote', s1.history.some(h => /🙋 <b>Wants a call or visit<\/b> — “Please call me at 6 pm today”/.test(h.text)), s1.history.map(h => h.text).join(' | '));

  const lead3 = { ...leadNow, tt: s1.leadWrite.tt };
  const retry = planUpdate({ envelope: askCall, lead: lead3, state: s1.stateWrite, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 5000, signal: 'wants_contact' });
  check('A retry of the same event adds no history', !retry.history.some(h => /Wants a call/.test(h.text)));

  const again = real({ chat_history: [...SAMPLE.data.chat_history, { role: 'user', content: 'Hello? Still waiting for the call', time: '2026-09-13T13:40:00+00:00' }] }, { webhook_trigger: 'custom', occurred_at: '2026-09-13T19:11:00+05:30' });
  const s2 = planUpdate({ envelope: again, lead: lead3, state: s1.stateWrite, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 60000, signal: 'wants_contact' });
  check('Asking again while still open adds no new history line', !s2.history.some(h => /Wants a call/.test(h.text)));
  eq('…but keeps when it started', s2.leadWrite.tt.signals.wants_contact.at, sig.at);
  eq('…refreshes the words', s2.leadWrite.tt.signals.wants_contact.quote, 'Hello? Still waiting for the call');
  eq('…and counts it', s2.leadWrite.tt.signals.wants_contact.count, 2);

  // The team calls (any CRM action moves updatedAt past the signal), then the lead asks again.
  const handled = { ...lead3, tt: s2.leadWrite.tt, updatedAt: Date.parse('2026-09-13T13:45:00Z') };
  const later = real({ chat_history: [...SAMPLE.data.chat_history, { role: 'user', content: 'Can we talk again tomorrow?', time: '2026-09-13T15:00:00+00:00' }] }, { webhook_trigger: 'custom', occurred_at: '2026-09-13T20:30:00+05:30' });
  const s3 = planUpdate({ envelope: later, lead: handled, state: s2.stateWrite, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 7200000, signal: 'wants_contact' });
  check('After the team handled it, a new ask is a new signal', s3.history.some(h => /Wants a call/.test(h.text)));
  eq('…starting now', s3.leadWrite.tt.signals.wants_contact.at, Date.parse('2026-09-13T20:30:00+05:30'));

  const ordinary = planUpdate({ envelope: real({}, { occurred_at: '2026-09-13T20:40:00+05:30' }), lead: { ...handled, tt: s3.leadWrite.tt }, state: s3.stateWrite, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 7300000 });
  check('An ordinary message keeps earlier signals', !!ordinary.leadWrite.tt.signals.wants_contact);

  const promise = planUpdate({
    envelope: real({ chat_history: [...SAMPLE.data.chat_history,
      { role: 'user', content: 'Can I see photos of ANRA002?', time: '2026-09-13T13:30:00+00:00' },
      { role: 'assistant', content: 'We do not have visuals in the system — our team will share photos and a video with you directly today.', time: '2026-09-13T13:30:20+00:00' },
      { role: 'assistant', content: '<No response from agent>', time: '2026-09-13T13:30:40+00:00', metadata: { type: 'no_response' } }] }, { webhook_trigger: 'custom', occurred_at: '2026-09-13T19:01:00+05:30' }),
    lead: null, state: null, leadId: 'LP', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW, signal: 'team_promise'
  });
  const ps = promise.leadWrite.tt.signals.team_promise;
  check('team_promise keeps what 3 PIN promised', /our team will share photos/.test(ps.reply || ''), JSON.stringify(ps));
  check('…ignoring the "no response" marker', !/No response/.test(ps.reply || ''));
  check('…and the history shows the promise, not the lead\'s question', promise.history.some(h => /🤝 <b>Team promised the lead something<\/b> — “We do not have visuals/.test(h.text)), promise.history.map(h => h.text).join(' | '));
  check('A firing produces an event for the log', promise.signalEvent && promise.signalEvent.signal === 'team_promise' && promise.signalEvent.repeat === false && promise.signalEvent.status === 'cold' && promise.signalEvent.stageId === 'new', JSON.stringify(promise.signalEvent));
  const moment = planUpdate({
    envelope: real({ chat_history: [...SAMPLE.data.chat_history,
      { role: 'user', content: 'Can someone call me at 5 today?', time: '2026-09-13T13:40:00+00:00' },
      { role: 'assistant', content: 'Sure, our team will call you at 5 PM.', time: '2026-09-13T13:40:15+00:00' }] }, { webhook_trigger: 'custom', occurred_at: '2026-09-13T19:11:00+05:30' }),
    lead: null, state: null, leadId: 'LM', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW, signal: 'moment'
  });
  check('A key moment shows both sides of the exchange', moment.history.some(h => /⚡ <b>Key moment — needs a look<\/b> — “Can someone call me at 5 today\? — 3 PIN: Sure, our team will call you at 5 PM\.”/.test(h.text)), moment.history.map(h => h.text).join(' | '));
  check('…and is logged for automations', moment.signalEvent && moment.signalEvent.signal === 'moment');
  const owner = planUpdate({ envelope: real({ intent_and_who: 'Enquiring for a relative' }), lead: null, state: null, leadId: 'LO', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW, signal: 'owner_listing' });
  eq('owner_listing sets the enquiry type to Seller Listing', owner.leadWrite.enquiryType, 'Seller Listing');
  const seller = planUpdate({ envelope: real({ intent_and_who: 'Enquiring for a relative' }), lead: null, state: null, leadId: 'L9', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW, signal: 'seller_lead' });
  eq('Seller signal sets the enquiry type', seller.leadWrite.enquiryType, 'Seller Listing');
  const staleSig = planUpdate({ envelope: real({}, { occurred_at: '2026-09-13T18:00:00+05:30', webhook_trigger: 'custom' }), lead: { ...handled, tt: { ...s3.leadWrite.tt, lastEventAt: Date.parse('2026-09-13T21:00:00+05:30') } }, state: s3.stateWrite, leadId: 'L1', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW, signal: 'lost_signal' });
  check('A signal arriving late is still recorded', staleSig.stale && !!staleSig.leadWrite.tt.signals.lost_signal);
  const custom = planUpdate({ envelope: real(), lead: null, state: null, leadId: 'L10', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW, signal: 'loan_needed' });
  check('An unknown signal is still recorded with a generic label', !!custom.leadWrite.tt.signals.loan_needed && custom.history.some(h => /Custom trigger “loan_needed”/.test(h.text)));
  check('No undefined in a signal write', !hasUndefined(s2.leadWrite) && !hasUndefined(custom.leadWrite));
}

// ───────────────────────────────────────────────────────────────────────────
section('Timeline entries, category, and what needs a person');
{
  const created = first.history.find(h => h.type === 'created');
  check('First message entry quotes the lead', /💬 First message on WhatsApp \(WhatsApp ad · Summer Sale Campaign 2026\) — “Hi, I am interested in your services\.”/.test(created.text), created.text);
  eq('…dated to the message itself', created.at, Date.parse('2026-09-13T12:52:50+00:00'));
  const snap = first.history.find(h => /Added to the CRM/.test(h.text));
  check('Snapshot entry: status, messages, next action', snap && /Cold · 3 messages \(1 from the lead\)/.test(snap.text) && /<br>Next: Negotiating\. Next action/.test(snap.text), snap && snap.text);
  check('Snapshot is recorded now, not backdated', snap && !snap.at);

  const marker = { role: 'assistant', content: '<No response from agent>', time: '2026-09-13T13:05:00+00:00', metadata: { type: 'no_response' } };
  const pulledEnv = (data, at = '2026-09-13T13:30:00+00:00') => ({ webhook_trigger: 'sync', event_type: 'lead', occurred_at: at, data: { ...real().data, created_at: undefined, joined: '2026-09-01T10:00:00+00:00', ...data } });
  const imp = planUpdate({
    envelope: pulledEnv({ escalated: true, chat_history: [...SAMPLE.data.chat_history, { role: 'user', content: 'Price please?', time: '2026-09-13T13:04:00+00:00' }, marker] }),
    lead: null, state: null, leadId: 'LI', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: Date.parse('2026-09-13T13:30:00Z')
  });
  eq('get_leads "joined" becomes createdAt', imp.leadWrite.createdAt, Date.parse('2026-09-01T10:00:00+00:00'));
  eq('An escalation already on at import has no known start', imp.leadWrite.tt.escalatedAt, null);
  eq('Import looks back 48 h for things still waiting', imp.leadWrite.tt.attentionFrom, Date.parse('2026-09-13T13:30:00Z') - 48 * 3600000);
  eq('Conversation ending on "no response" is waiting for the team', imp.leadWrite.tt.awaitingTeamAt, Date.parse('2026-09-13T13:05:00+00:00'));
  eq('"No response" is not counted as a reply', imp.leadWrite.tt.lastReplyAt, Date.parse('2026-09-13T12:52:50+00:00'));
  check('"No response" is not counted as a message in the snapshot', imp.history.some(h => /4 messages \(2 from the lead\)/.test(h.text)), imp.history.map(h => h.text).join(' | '));

  const liveLead = { ...imp.leadWrite };
  const replied = planUpdate({
    envelope: real({ escalated: true, chat_history: [...SAMPLE.data.chat_history, { role: 'user', content: 'Price please?', time: '2026-09-13T13:04:00+00:00' }, marker, { role: 'assistant', content: 'Our team will call you.', time: '2026-09-13T13:40:00+00:00' }] }, { occurred_at: '2026-09-13T13:40:00+00:00' }),
    lead: liveLead, state: imp.stateWrite, leadId: 'LI', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: Date.parse('2026-09-13T13:41:00Z')
  });
  eq('A later reply ends the wait', replied.leadWrite.tt.awaitingTeamAt, null);
  eq('Still-on escalation keeps its unknown start', replied.leadWrite.tt.escalatedAt, null);
  eq('attentionFrom is carried forward', replied.leadWrite.tt.attentionFrom, imp.leadWrite.tt.attentionFrom);

  const calm = planUpdate({ envelope: real({ escalated: false }), lead: null, state: null, leadId: 'LC', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW });
  const flip = planUpdate({ envelope: real({ escalated: true }, { occurred_at: '2026-09-13T19:00:00+05:30' }), lead: calm.leadWrite, state: calm.stateWrite, leadId: 'LC', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 1000 });
  eq('An escalation that switches on is dated', flip.leadWrite.tt.escalatedAt, Date.parse('2026-09-13T19:00:00+05:30'));
  eq('A live lead has no look-back window', flip.leadWrite.tt.attentionFrom, null);

  const TYPES_B = [...TYPES, 'Vendor / Collaboration'];
  const vendor = planUpdate({ envelope: real({ category: 'others', lead_status: 'vendor pitch', intent_and_who: 'Buy ads on our portal' }), lead: null, state: null, leadId: 'LV', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES_B, now: NOW });
  eq('A vendor gets the Vendor / Collaboration type', vendor.leadWrite.enquiryType, 'Vendor / Collaboration');
  eq('…and keeps TailorTalk\'s category', vendor.leadWrite.tt.category, 'others');
  eq('…and its own status', vendor.leadWrite.tt.status, 'vendor pitch');
}

section('Pull (import / daily sync / Sync button)');
{
  _clearConfigCache();
  const db = createFakeDb();
  db._store.set(`pipelines/${TENANT}`, { stages: STAGES });
  db._store.set(`settings/${TENANT}`, { enquiryTypes: TYPES });
  db._store.set('leads/lead_x', { id: 'lead_x', tenantId: TENANT, name: 'Typed in', phone: '9000000002', stageId: 'contacted', updatedAt: 5 });
  const mk = (i, status = 'warm', extra = {}) => ({
    ...real().data, id: `p${i}`, lead_contact: `919000000${String(i).padStart(3, '0')}`, lead_name: `Lead ${i}`, lead_status: status,
    created_at: undefined, joined: new Date(NOW - (i + 2) * 86400000).toISOString(),
    last_message_time: new Date(NOW - i * 3600000).toISOString(), metadata: [], ...extra
  });
  delete mk(0).created_at;
  const all = [mk(1), mk(2, 'hot'), mk(3, 'vendor pitch', { category: 'others' }), mk(4), mk(5, 'cold')];
  all.forEach(l => { delete l.created_at; });
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const before = body.start_after ? Date.parse(body.start_after) : Infinity;
    const page = all.filter(l => Date.parse(l.last_message_time) < before).slice(0, body.limit);
    return { ok: true, json: async () => ({ success: true, data: { leads: page, count: page.length } }) };
  };
  let startAfter = null, pages = 0, created = 0, updated = 0, guard = 0;
  while (guard++ < 20) {
    const r = await pullTailorTalkPage(db, TENANT, 'tok', { startAfter, pageSize: 2, now: NOW, fetchImpl: fakeFetch });
    pages++; created += r.created; updated += r.updated;
    if (r.failed) console.log('   pull errors:', JSON.stringify(r.errors));
    if (r.done) break;
    startAfter = r.next;
  }
  check('Sends the agent token', calls.length > 0);
  check('Walks every page to the end', pages >= 3 && guard < 20, `pages ${pages}`);
  eq('Every TailorTalk lead is in the CRM once', db._list('leads').length, 5 + 1 - 1);
  check('The typed-in lead with the same number was linked, not duplicated', db._get('leads/lead_x').tt && db._get('leads/lead_x').tt.id === 'p2');
  eq('Vendor / Collaboration was added to the tenant\'s enquiry types', db._get(`settings/${TENANT}`).enquiryTypes, [...TYPES, 'Vendor / Collaboration']);
  const vendorLead = db._get(`leads/${ttLeadDocId(TENANT, 'p3')}`);
  eq('The vendor lead carries that type', vendorLead.enquiryType, 'Vendor / Collaboration');
  check('Pulled leads have a dated first-message entry', db._list(`leads/${ttLeadDocId(TENANT, 'p1')}/history`).some(p => /First message/.test(db._get(p).text)));
  check('A pull does not overwrite the webhook bookkeeping', !db._get(`ttState/${TENANT}`) || !db._get(`ttState/${TENANT}`).lastTrigger);

  const before = db._list(`leads/${ttLeadDocId(TENANT, 'p1')}/history`).length;
  let s2 = null, g2 = 0;
  while (g2++ < 20) { const r = await pullTailorTalkPage(db, TENANT, 'tok', { startAfter: s2, pageSize: 2, now: NOW + 3600000, fetchImpl: fakeFetch }); if (r.done) break; s2 = r.next; }
  eq('Pulling again changes nothing that did not change', db._list(`leads/${ttLeadDocId(TENANT, 'p1')}/history`).length, before);
  eq('…and creates no duplicates', db._list('leads').length, 5);

  const stop = await pullTailorTalkPage(db, TENANT, 'tok', { pageSize: 10, stopBefore: NOW - 2.5 * 3600000, now: NOW + 7200000, fetchImpl: fakeFetch });
  eq('Daily sync stops at leads older than the watermark', stop.processed, 2);
  check('…and reports done', stop.done);

  const failing = async () => ({ ok: false, status: 401, text: async () => 'bad token' });
  let threw = null;
  try { await pullTailorTalkPage(db, TENANT, 'bad', { fetchImpl: failing }); } catch (e) { threw = e.message; }
  check('A TailorTalk API error is reported, not swallowed', /401/.test(threw || ''), threw);
}

// ───────────────────────────────────────────────────────────────────────────
section('Firestore: webhook end to end');
{
  _clearConfigCache();
  const db = createFakeDb();
  db._store.set(`pipelines/${TENANT}`, { stages: STAGES });
  db._store.set(`settings/${TENANT}`, { enquiryTypes: TYPES });

  const test = await applyTailorTalkEvent(db, TENANT, SAMPLE, { now: NOW });
  check('Test webhook answers ok', test.ok && test.test);
  eq('Test webhook creates no lead', db._list('leads').length, 0);
  eq('Test webhook is recorded', db._get(`ttState/${TENANT}`).lastTestAt, NOW);

  const r1 = await applyTailorTalkEvent(db, TENANT, real(), { now: NOW });
  const id = ttLeadDocId(TENANT, 'agent1_whatsapp_919876543210');
  eq('Lead created under its stable id', r1.leadId, id);
  const saved = db._get(`leads/${id}`);
  eq('Saved name', saved.name, 'John Doe');
  eq('Saved tenant', saved.tenantId, TENANT);
  eq('No notes written for TailorTalk facts (history holds them)', db._list(`leads/${id}/notes`).length, 0);
  check('State document written', !!db._get(`leads/${id}/tailortalk/state`));
  eq('History entries written (first message, added snapshot, booking, follow-up, payment)', db._list(`leads/${id}/history`).length, 5);
  check('History entries are by TailorTalk', db._list(`leads/${id}/history`).every(p => db._get(p).by === 'TailorTalk'));

  // The same payload again (a retry, or the daily sync reading an unchanged lead): no writes.
  const snapshotOf = () => JSON.stringify([db._get(`leads/${id}`), db._get(`leads/${id}/tailortalk/state`), db._list(`leads/${id}/history`).length]);
  const before = snapshotOf();
  const writesBefore = db._stats.writes;
  const same = await applyTailorTalkEvent(db, TENANT, real(), { now: NOW + 30000 });
  check('An unchanged repeat is recognised', same.unchanged === true, JSON.stringify(same));
  eq('…and leaves the lead, its state and its history untouched', snapshotOf(), before);
  eq('…only the webhook\'s "last event received" bookkeeping is written', db._stats.writes - writesBefore, 1);

  const r2 = await applyTailorTalkEvent(db, TENANT, warm, { now: NOW + 60000 });
  eq('Next message updates the same lead', r2.leadId, id);
  eq('Still one lead', db._list('leads').length, 1);
  eq('Status now warm', db._get(`leads/${id}`).tt.status, 'warm');
  eq('Budget now 3.6 Cr', db._get(`leads/${id}`).budget, '3.6 Cr');
  eq('Still no notes', db._list(`leads/${id}/notes`).length, 0);
  eq('Chat messages are not duplicated across updates', db._get(`leads/${id}/tailortalk/state`).chat.length, 4);
  eq('Stage untouched', db._get(`leads/${id}`).stageId, 'new');

  // The team edits the budget in the CRM (what firebase-sync.js saveLead would write).
  db._store.set(`leads/${id}`, { ...db._get(`leads/${id}`), budget: '3.5 Cr', ttHold: { budget: true }, stageId: 'contacted' });
  await applyTailorTalkEvent(db, TENANT, newer, { now: NOW + 120000 });
  eq('Edited budget survives the next message', db._get(`leads/${id}`).budget, '3.5 Cr');
  eq('Stage the team set survives', db._get(`leads/${id}`).stageId, 'contacted');
  eq('Status still follows', db._get(`leads/${id}`).tt.status, 'hot');

  const sigEnv = real({}, { webhook_trigger: 'custom', occurred_at: '2026-09-13T19:30:00+05:30' });
  const sigRes = await applyTailorTalkEvent(db, TENANT, sigEnv, { now: NOW + 180000, signal: 'ready_to_close' });
  eq('A signal webhook updates the same lead', sigRes.leadId, id);
  check('…and the signal is saved', !!db._get(`leads/${id}`).tt.signals.ready_to_close);
  const events = db._list('ttSignalEvents');
  eq('The firing is written to the event log', events.length, 1);
  const ev = db._get(events[0]);
  check('…with the lead, signal, moment and context', ev.leadId === id && ev.signal === 'ready_to_close' && ev.at === Date.parse('2026-09-13T19:30:00+05:30') && ev.tenantId === TENANT && ev.status === 'cold' && ev.stageId === 'contacted' && ev.handledAt === null, JSON.stringify(ev));
  await applyTailorTalkEvent(db, TENANT, sigEnv, { now: NOW + 185000, signal: 'ready_to_close' });
  eq('A retry of the same firing does not add a second log entry', db._list('ttSignalEvents').length, 1);
  const testSig = await applyTailorTalkEvent(db, TENANT, SAMPLE, { now: NOW + 190000, signal: 'wants_contact' });
  check('Test Webhook on a signal webhook still creates nothing', testSig.test && db._list('leads').length === 1);
  eq('…and records which signal was tested', db._get(`ttState/${TENANT}`).lastTestSignal, 'wants_contact');
}

section('Firestore: matching a number the team already has');
{
  _clearConfigCache();
  const db = createFakeDb();
  db._store.set(`pipelines/${TENANT}`, { stages: STAGES });
  db._store.set(`leads/lead_a`, { id: 'lead_a', tenantId: TENANT, name: 'Karthik S', phone: '98765 43210', stageId: 'contacted', updatedAt: 5 });
  db._store.set(`leads/lead_b`, { id: 'lead_b', tenantId: TENANT, name: 'Priya', phone: '98765 00000', updatedAt: 4 });
  db._store.set(`leads/other_tenant`, { id: 'other_tenant', tenantId: 't_other', name: 'Not ours', phone: '9876543210', updatedAt: 9 });

  const r = await applyTailorTalkEvent(db, TENANT, real(), { now: NOW });
  eq('Linked to the typed-in lead', r.leadId, 'lead_a');
  check('No duplicate lead created', !db._get(`leads/${ttLeadDocId(TENANT, 'agent1_whatsapp_919876543210')}`));
  eq('Typed name kept', db._get('leads/lead_a').name, 'Karthik S');
  eq('Linked lead now carries the TailorTalk id', db._get('leads/lead_a').tt.id, 'agent1_whatsapp_919876543210');
  eq('phoneKey backfilled on the tenant\'s other leads', db._get('leads/lead_b').phoneKey, '919876500000');
  check('Another tenant\'s lead is never touched', !db._get('leads/other_tenant').phoneKey && !db._get('leads/other_tenant').tt);
  check('Backfill is remembered', !!db._get(`ttState/${TENANT}`).phoneKeysBackfilledAt);

  const scansBefore = db._stats.queries.filter(q => q.filters.length === 1).length;
  await applyTailorTalkEvent(db, TENANT, real({ id: 'agent1_whatsapp_919111111111', lead_contact: '919111111111', metadata: [] }), { now: NOW + 1000 });
  const scansAfter = db._stats.queries.filter(q => q.filters.length === 1).length;
  eq('A new number after the backfill does not rescan every lead', scansAfter, scansBefore);

  const again = await applyTailorTalkEvent(db, TENANT, real({ lead_status: 'hot' }, { occurred_at: '2026-09-13T20:00:00+05:30' }), { now: NOW + 2000 });
  eq('The linked lead is found by its TailorTalk id next time', again.leadId, 'lead_a');

  // The same person on the website chat: one number, one lead.
  const second = await applyTailorTalkEvent(db, TENANT, real({ id: 'agent1_web_karthik', lead_contact: '919876543210', integration: 'web', lead_source: 'web_chat', metadata: [],
    chat_history: [{ role: 'user', content: 'Asking from your website too', time: '2026-09-13T15:30:00+00:00' }] }, { occurred_at: '2026-09-13T21:00:00+05:30' }), { now: NOW + 3000 });
  eq('A second conversation on the same number joins the same lead', second.leadId, 'lead_a');
  const merged = db._get('leads/lead_a');
  check('…the lead keeps both conversation ids', merged.tt.ids.includes('agent1_whatsapp_919876543210') && merged.tt.ids.includes('agent1_web_karthik'), JSON.stringify(merged.tt.ids));
  check('…their messages are merged into one conversation', db._get('leads/lead_a/tailortalk/state').chat.some(m => /website too/.test(m.content)));
  check('…and the history says so once', db._list('leads/lead_a/history').filter(p => /Also chatting on/.test(db._get(p).text)).length === 1);
  eq('Still no duplicate lead for that number', db._list('leads').filter(p => (db._get(p).phoneKey || '') === '919876543210').length, 1);
  const byWebId = await applyTailorTalkEvent(db, TENANT, real({ id: 'agent1_web_karthik', lead_contact: '919876543210', integration: 'web', lead_source: 'web_chat', metadata: [] }, { occurred_at: '2026-09-13T21:05:00+05:30' }), { now: NOW + 4000 });
  eq('Either conversation id finds the lead afterwards', byWebId.leadId, 'lead_a');
}

section('Firestore: live webhooks carry no lead id');
{
  _clearConfigCache();
  const db = createFakeDb();
  db._store.set(`pipelines/${TENANT}`, { stages: STAGES });
  const noId = (extra = {}, env = {}) => { const e = real(extra, env); delete e.data.id; return e; };

  // 1. A webhook arrives before any import: the lead is named after its number.
  const w1 = await applyTailorTalkEvent(db, TENANT, noId({ metadata: [] }), { now: NOW });
  eq('An id-less webhook creates a lead named after the number', w1.leadId, ttLeadDocId(TENANT, 'contact_919876543210'));
  // 2. The import then brings the same person with their real id: same lead, real id adopted.
  const p1 = await applyTailorTalkEvent(db, TENANT, { webhook_trigger: 'sync', occurred_at: new Date(NOW + 60000).toISOString(), data: { ...real({ metadata: [] }).data, id: 'realid123' } }, { now: NOW + 60000 });
  eq('The pulled lead with a real id is the same lead', p1.leadId, w1.leadId);
  eq('…which now carries the real id', db._get(`leads/${w1.leadId}`).tt.id, 'realid123');
  eq('Still one lead', db._list('leads').length, 1);
  // 3. Later id-less webhooks keep the real id rather than going back to the placeholder.
  await applyTailorTalkEvent(db, TENANT, noId({ metadata: [], lead_status: 'hot' }, { occurred_at: '2026-09-13T22:00:00+05:30' }), { now: NOW + 120000 });
  eq('An id-less webhook keeps the real id', db._get(`leads/${w1.leadId}`).tt.id, 'realid123');
  eq('…and still updates the lead', db._get(`leads/${w1.leadId}`).tt.status, 'hot');
  eq('Still one lead after all three', db._list('leads').length, 1);
  check('A reworded locality is not logged as a change', !db._list(`leads/${w1.leadId}/history`).some(p => /Property \/ Locality changed/.test(db._get(p).text)));
}

section('Rewordings are not changes');
{
  const base = planUpdate({ envelope: real({ preferred_location: 'T Nagar' }), lead: null, state: null, leadId: 'LR', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW });
  const reworded = planUpdate({ envelope: real({ preferred_location: 'T.Nagar', stage_and_next_action: 'negotiating. Next action: share the quote' }, { occurred_at: '2026-09-13T19:00:00+05:30' }), lead: base.leadWrite, state: base.stateWrite, leadId: 'LR', tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW + 1000 });
  check('"T Nagar" → "T.Nagar" is not written', !('propertyInterest' in reworded.leadWrite));
  check('…nor logged', !reworded.history.some(h => /Locality/.test(h.text)));
  check('A stage that differs only in case is not logged', !reworded.history.some(h => /TailorTalk stage/.test(h.text)));
}

section('Firestore: payloads that cannot be used');
{
  _clearConfigCache();
  const db = createFakeDb();
  const r = await applyTailorTalkEvent(db, TENANT, { webhook_trigger: 'every_message', data: { lead_name: 'No id' } }, { now: NOW });
  check('No id or contact is dead-lettered, not thrown', r.deadLettered);
  eq('Dead letter stored', db._list('ttDeadLetters').length, 1);
  eq('No lead created', db._list('leads').length, 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
