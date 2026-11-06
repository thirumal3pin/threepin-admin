// ═══════ CAMPAIGN MODEL — numbers, values, the template library and the scorecard ═══════
//
//   node tests/campaign-model.test.mjs
//
// crm-assets/campaignModel.js after the marketing review: which numbers WhatsApp can reach, what a
// variable may hold, where each value comes from (the lead's requirement, never the property's),
// the starter templates in the review's words, who is held back and why (the server's own words),
// what a reply means and whether it needs a person, and what a campaign earned.

import * as C from '../crm-assets/campaignModel.js';

let passed = 0, failed = 0;
const check = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); } };
const section = s => console.log('\n── ' + s);
console.log('3 PIN Realty — campaign model');

const DAY = 86400000, H = 3600000;
const NOW = Date.UTC(2026, 10, 5, 5, 30); // Wed 5 Nov 2026, 11:00 IST

section('waNumber — who WhatsApp can reach');
{
  const table = [
    ['99418 80088', '919941880088'],
    ['+91-99418-80088', '919941880088'],
    ['09941880088', '919941880088'],
    ['0091 99418 80088', '919941880088'],          // international prefix from a landline
    ['+91 0 99418 80088', '919941880088'],         // trunk 0 after the country code
    ['910 9941880088', '919941880088'],
    ['6000000001', '916000000001'],                // 6–9 start a mobile
    ['5941880088', ''],                            // …nothing else does
    ['+91 44 2345 6789', ''],                      // a Chennai landline
    ['044 2345 6789', ''],
    ['91994188008', ''],                           // 91 + nine digits
    ['9199418800881', ''],                         // 91 + eleven digits
    ['+1 415 555 0100', '14155550100'],
    ['00 1 415 555 0100', '14155550100'],
    ['+971 50 123 4567', '971501234567'],
    ['+44 7911 123456', '447911123456'],
    ['1234567890123456', ''],                      // 16 digits
    ['12345', ''], ['ravi_insta', ''], ['', ''], [null, '']
  ];
  for (const [raw, want] of table) check(`waNumber(${JSON.stringify(raw)}) = ${want || '“”'}`, C.waNumber(raw) === want, C.waNumber(raw));
  check('prettyNumber still reads well', C.prettyNumber('0091 99418 80088') === '+91 99418 80088' && C.prettyNumber('+1 415 555 0100') === '+14155550100');
}

section('values WhatsApp accepts — no new lines, tabs or long runs of spaces');
{
  check('cleanParam: new line → space', C.cleanParam('Ravi\nKumar') === 'Ravi Kumar');
  check('cleanParam: CRLF and tabs → one space', C.cleanParam('a\r\n\tb') === 'a b');
  check('cleanParam: 4+ spaces → 3, 3 kept', C.cleanParam('a    b') === 'a   b' && C.cleanParam('a      b') === 'a   b' && C.cleanParam('a   b') === 'a   b');
  check('cleanParam: trimmed, null → ""', C.cleanParam('  x  ') === 'x' && C.cleanParam(null) === '');
  check('paramsFor sanitises named values', JSON.stringify(C.paramsFor(['name', 'note'], { name: ' Ravi ', note: 'line one\nline two\t\tend' })) === '{"name":"Ravi","note":"line one line two end"}');
  check('paramsFor sanitises numbered values', JSON.stringify(C.paramsFor(['2', '1'], { 1: 'a\nb', 2: 'c     d' })) === '["a b","c   d"]');
  check('the preview reads the same as what is sent', C.fillText('Hi {{name}}, {{note}}.', { name: 'Ravi', note: 'one\ntwo' }) === 'Hi Ravi, one two.');
}

section('lintTemplate — numbered variables and Utility words');
{
  const base = { name: 'x_v1', category: 'MARKETING', body: '' };
  const lint = body => C.lintTemplate({ ...base, body });
  const posErr = r => r.errors.some(e => /run \{\{1\}\}, \{\{2\}\}/.test(e));
  check('{{1}} then {{2}} is fine', lint('Hi {{1}}, your visit to {{2}} is fixed for tomorrow morning.').ok);
  check('{{2}} before {{1}} is an error', posErr(lint('Hi {{2}}, your visit to {{1}} is fixed for tomorrow morning.')));
  check('{{1}} then {{3}} (skipped 2) is an error', posErr(lint('Hi {{1}}, your visit to {{3}} is fixed for tomorrow morning.')));
  check('starting at {{2}} is an error', posErr(lint('Hi {{2}}, your visit is fixed for tomorrow morning.')));
  check('a repeated {{1}} is fine', lint('Hi {{1}}, your visit to {{2}} is fixed, {{1}}, for tomorrow morning.').ok);
  check('header and body are numbered each on their own', C.lintTemplate({ ...base, header: 'For {{1}}', body: 'Hi {{1}}, your visit to {{2}} is fixed for tomorrow morning.' }).ok);
  check('named variables are not numbered', lint('Hi {{name}}, your visit to {{property}} is fixed for tomorrow morning.').ok);
  const words = ['similar', 'more options', 'other properties', 'new', 'available', 'refer', 'friend', 'review', 'visit this week', 'still looking', 'offer', 'discount'];
  const util = w => C.lintTemplate({ name: 'u_v1', category: 'UTILITY', body: `Hi {{name}}, about your enquiry with us: ${w} — reply here any time you like.` });
  for (const w of words) check(`Utility + “${w}” warns`, util(w).warnings.some(x => /Promotional/.test(x)));
  check('…a word inside another does not (“renewed”, “reviewed” are not “new”, “review”)', !util('renewed papers reviewed').warnings.some(x => /Promotional/.test(x)));
  check('…and Marketing may say them', !C.lintTemplate({ name: 'm_v1', category: 'MARKETING', body: 'Hi {{name}}, similar new homes are available — refer a friend this week.' }).warnings.some(x => /Promotional/.test(x)));
}

section('greetingName — a word boundary, at most 30 characters');
{
  check('short names untouched', C.greetingName('Ravi Kumar') === 'Ravi Kumar');
  check('long names cut at the last whole word', C.greetingName('Venkatasubramanian Ramachandran Iyer') === 'Venkatasubramanian', C.greetingName('Venkatasubramanian Ramachandran Iyer'));
  check('exactly 30 kept whole', C.greetingName('Abcdefghij Klmnopqrst Uvwxyzab') === 'Abcdefghij Klmnopqrst Uvwxyzab');
  check('one very long word is cut at 30', C.greetingName('A'.repeat(35)) === 'A'.repeat(30));
  check('emoji and ~ still go', C.greetingName('~ Ravi 🙂') === 'Ravi' && C.greetingName('+91 98765 43210') === '');
  check('firstName', C.firstName('~ Ravi Kumar 🙂') === 'Ravi' && C.firstName('') === '');
}

section('autoSource — by whole words, with the new sources');
{
  const exp = {
    name: 'lead_name', customer_name: 'lead_name', property_name: 'property', property_code: 'code', code: 'code', '1': 'lead_name',
    visit_date: 'visit_date', visit_time: 'visit_time', area: 'area', price: 'price', config: 'config', offer_text: 'fixed',
    preferred_location: 'req_area', preferred_bhk: 'req_config', req_area: 'req_area', req_config: 'req_config', req_bhk: 'req_config',
    req_budget: 'req_budget', budget: 'req_budget', agent_name: 'agent_name', agent_phone: 'agent_phone', agent_number: 'agent_phone',
    first_name: 'first_name', enquiries: 'fixed', visits: 'fixed', feedback: 'fixed', reference_code: 'code', site_visit_date: 'visit_date'
  };
  for (const [v, s] of Object.entries(exp)) check(`autoSource(${v}) = ${s}`, C.autoSource(v) === s, C.autoSource(v));
}

section('sources — the lead’s requirement, the agent, the first name');
{
  const keys = C.SOURCES.map(s => s[0]);
  check('the new sources are listed', ['first_name', 'agent_name', 'agent_phone', 'req_area', 'req_config', 'req_budget'].every(k => keys.includes(k)));
  check('SOURCE_HELP explains every source in one line', keys.every(k => typeof C.SOURCE_HELP[k] === 'string' && C.SOURCE_HELP[k].length > 10 && !C.SOURCE_HELP[k].includes('\n')));
  const prop = { id: 'ANR003', propertyCode: 'ANR003', name: 'Sunrise Residency', location: 'Anna Nagar', startingPrice: '₹2.8 Cr', config: '4 BHK' };
  const v = (src, lead, extra) => C.sourceValue(src, { lead, prop, ...(extra || {}) });
  check('first_name', v('first_name', { name: 'Ravi Kumar' }) === 'Ravi' && v('first_name', { name: '98765 43210' }) === 'there');
  check('agent_name / agent_phone from ctx.agent', v('agent_name', {}, { agent: { name: 'Karthik S', phone: '9840012345' } }) === 'Karthik S'
    && v('agent_phone', {}, { agent: { name: 'K', phone: '9840012345' } }) === '+91 98400 12345');
  check('an agent phone that is no number is kept as typed; none → ""', v('agent_phone', {}, { agent: { phone: 'ext 204' } }) === 'ext 204' && v('agent_name', {}) === '');
  const aiLead = { propertyInterest: 'ANR003', ai: { want: { areas: ['Velachery', 'Adambakkam', 'Madipakkam'], bhk: [3, 2], budget_min: 8000000, budget_max: 12000000, budget_unit: 'total' } } };
  check('req_area: the AI’s first two areas — not the property’s area', v('req_area', aiLead) === 'Velachery, Adambakkam');
  check('req_config: the AI’s BHKs', v('req_config', aiLead) === '2 or 3 BHK');
  check('req_budget: the AI’s range when nothing is typed', v('req_budget', aiLead) === '₹80 L – ₹1.2 Cr', v('req_budget', aiLead));
  const typed = { budget: '1.5 Cr', tt: { values: { propertyInterest: '3BHK in Adyar, budget 1.8Cr' } } };
  check('req_area from what they typed, without the size or budget', v('req_area', typed) === 'Adyar', v('req_area', typed));
  check('req_config from what they typed', v('req_config', typed) === '3 BHK');
  check('req_budget: the typed budget wins', v('req_budget', typed) === '1.5 Cr');
  check('TailorTalk’s budget when the lead has none', v('req_budget', { tt: { values: { budget: '80L - 1Cr' } } }) === '80L - 1Cr');
  check('a monthly rent is not a purchase budget', v('req_budget', { ai: { want: { budget_max: 45000, budget_unit: 'per_month' } } }) === '');
  check('the type when no size is known', v('req_config', { ai: { want: { types: ['villa'] } } }) === 'villa');
  check('unknown → "" (so the lead is held back, never sent a blank)', v('req_area', {}) === '' && v('req_config', {}) === '' && v('req_budget', {}) === '');
  const r = C.leadRequirement({ budget: '90 L', ai: { want: { areas: ['OMR'] } } });
  check('leadRequirement: numbers for the journeys', r.budgetMax === 9000000 && r.areas[0] === 'OMR' && r.areaText === 'OMR');
  check('valuesFor passes the lead and agent through', JSON.stringify(C.valuesFor(['req_area', 'agent_name'], null, { lead: typed, agent: { name: 'Priya' } })) === '{"req_area":"Adyar","agent_name":"Priya"}');
  check('parseRupees: ranges by pick, no unit → null', C.parseRupees('1 to 1.5 Cr', 'max') === 15000000 && C.parseRupees('₹65L+', 'min') === 6500000
    && C.parseRupees('Price on Request') === null && C.parseRupees('3 to 4 Cr') === 35000000);
  check('formatRupees', C.formatRupees(15000000) === '₹1.5 Cr' && C.formatRupees(8500000) === '₹85 L' && C.formatRupees(0) === '');
}

section('toCsv — formulas defused, names left alone');
{
  const row = vals => C.toCsv([{ contact: '919941880088', values: { x: vals } }], ['x']).split('\r\n')[1].split(',').slice(1).join(',');
  check('= is defused', row('=1+1') === "'=1+1");
  check('+ is defused', row('+91 98') === "'+91 98");
  check('@ is defused', row('@SUM(A1)') === "'@SUM(A1)");
  check('- before a digit or = is defused', row('-5') === "'-5" && row('-=1') === "'-=1");
  check('a name with a dash is left as typed', row('-Ravi-') === '-Ravi-' && row('- 3PIN Realty') === '- 3PIN Realty' && row('Anne-Marie') === 'Anne-Marie');
}

section('the starter library — the review’s words, honest categories');
{
  const by = n => C.STARTERS.find(s => s.name === n);
  const bad = C.STARTERS.map(s => [s.name, C.lintTemplate(s)]).filter(([, r]) => !r.ok);
  check('every starter passes WhatsApp’s rules', !bad.length, bad.map(([n, r]) => [n, r.errors]));
  check('no Utility starter carries a warning', C.STARTERS.filter(s => s.category === 'UTILITY').every(s => !C.lintTemplate(s).warnings.length),
    C.STARTERS.filter(s => s.category === 'UTILITY').map(s => [s.name, C.lintTemplate(s).warnings]).filter(x => x[1].length));
  check('…nor any Marketing one', C.STARTERS.filter(s => s.category === 'MARKETING').every(s => !C.lintTemplate(s).warnings.length));
  check('names are unique', new Set(C.STARTERS.map(s => s.name)).size === C.STARTERS.length);
  const cats = Object.fromEntries(C.STARTERS.map(s => [s.name, s.category]));
  check('categories as reviewed', cats.visit_reminder_v2 === 'UTILITY' && cats.visit_feedback_v2 === 'UTILITY' && cats.visit_feedback_nudge_v2 === 'UTILITY'
    && cats.owner_monthly_report_v1 === 'UTILITY' && cats.no_show_v1 === 'UTILITY' && cats.property_sold_similar_v1 === 'MARKETING'
    && cats.new_listing_v2 === 'MARKETING' && cats.options_followup_v2 === 'MARKETING' && cats.search_checkin_v1 === 'MARKETING'
    && cats.review_referral_v1 === 'MARKETING' && cats.price_drop_v1 === 'MARKETING', cats);
  check('the reminder in the review’s words', by('visit_reminder_v2').body === 'Hi {{name}}, a reminder of your site visit to {{property}}, {{area}} on {{visit_date}} at {{visit_time}}.\n\n{{agent_name}} from 3 PIN Realty will meet you there and can be reached on {{agent_phone}}. Tap Confirm, or Reschedule if the time no longer suits you.'
    && by('visit_reminder_v2').buttons.join('|') === 'Confirm|Reschedule|Share location');
  check('the sold-out notice in the review’s words', by('property_sold_similar_v1').body === 'Hi {{name}}, {{property}} in {{area}}, which you asked about, has been sold.\n\nWe have a few similar homes nearby in the same budget. Shall we send you the 3 closest matches?'
    && by('property_sold_similar_v1').buttons.join('|') === 'Yes, send them|Not now|Stop offers');
  check('the check-in uses the lead’s requirement', JSON.stringify(C.varsIn(by('search_checkin_v1').body)) === '["name","req_config","req_area"]' && by('search_checkin_v1').purpose === 'search_checkin');
  check('the options follow-up too', C.varsIn(by('options_followup_v2').body).includes('req_area'));
  check('the new listing has an image header', by('new_listing_v2').mediaHeader === true);
  check('Stop offers on sold-out, new listing and price drop', ['property_sold_similar_v1', 'new_listing_v2', 'price_drop_v1'].every(n => by(n).buttons.includes('Stop offers')));
  check('purposes for the new ones', by('review_referral_v1').purpose === 'referral' && by('owner_monthly_report_v1').purpose === 'owner_report' && by('no_show_v1').purpose === 'no_show');
  const ta = by('visit_reminder_ta_v1');
  check('a Tamil visit reminder, in Tamil, with Tamil buttons', ta && ta.language === 'ta' && ta.purpose === 'visit_reminder' && ta.body.startsWith('வணக்கம் {{name}}!') && ta.buttons.join('|') === 'உறுதி|நேரம் மாற்ற');
  check('the English one is the reminder a purpose finds first', C.STARTERS.find(s => s.purpose === 'visit_reminder').name === 'visit_reminder_v2');
  check('dropped from the library', !by('property_price_update_v1') && !by('requirement_followup_v1') && !by('property_sold_update_v1'));
  const pk = C.PURPOSES.map(p => p[0]);
  check('PURPOSES: one each, old purposes still known, “something else” last', new Set(pk).size === pk.length && pk.includes('followup') && pk.includes('price_update') && pk[pk.length - 1] === 'other');
  check('every new sample is filled in', C.STARTERS.every(s => C.varsIn(s.header, s.body).every(v => C.sampleFor(v) !== 'sample')),
    C.STARTERS.flatMap(s => C.varsIn(s.header, s.body)).filter(v => C.sampleFor(v) === 'sample'));
  const names = { visit_feedback_nudge_v2: 'feedback_nudge', review_referral_v1: 'referral', options_followup_v2: 'options_followup', no_show_v1: 'no_show',
    owner_monthly_report_v1: 'owner_report', search_checkin_v1: 'search_checkin', visit_feedback_v2: 'visit_feedback', property_sold_similar_v1: 'sold_out',
    visit_reminder_ta_v1: 'visit_reminder', property_requirement_followup: 'followup', price_drop_v1: 'price_drop', post_visit_feedback: 'visit_feedback', mystery: '' };
  for (const [n, p] of Object.entries(names)) check(`purposeOf(${n}) = ${p || '“”'}`, C.purposeOf({ name: n }) === p, C.purposeOf({ name: n }));
  check('purposeOf: a template’s own tag wins', C.purposeOf({ name: 'sold_x', purpose: 'brochure' }) === 'brochure' && C.purposeOf(null) === '');
}

section('replies — meaning, sentiment, whether a person is needed');
{
  for (const a of ['ack', 'not_this', 'marketing_optout', 'referral', 'seller', 'loan']) check(`replyMeaning(${a}) is its own`, C.replyMeaning(a) !== C.REPLY_ACTIONS.other && !!C.REPLY_ACTIONS[a]);
  check('an unknown action reads as “Replied”', C.replyMeaning('zzz') === 'Replied');
  const pos = ['call', 'visit', 'options', 'feedback', 'referral', 'seller', 'loan', 'reschedule'];
  const neu = ['ack', 'not_now', 'other', 'found', 'zzz', undefined];
  const neg = ['not_this', 'optout', 'marketing_optout'];
  check('positive', pos.every(a => C.replySentiment(a) === 'positive'));
  check('neutral (and anything unknown)', neu.every(a => C.replySentiment(a) === 'neutral'));
  check('negative', neg.every(a => C.replySentiment(a) === 'negative'));
  check('REPLY_NO_PERSON is the CRM’s list', JSON.stringify(C.REPLY_NO_PERSON) === '["ack","optout","marketing_optout","not_this"]');
  check('replyNeedsPerson: no for a thanks/confirm, “not this one” and either STOP', ['ack', 'not_this', 'optout', 'marketing_optout'].every(a => !C.replyNeedsPerson({ action: a }) && !C.replyNeedsPerson(a)));
  check('replyNeedsPerson: yes for everything else, even a key not known yet', ['call', 'not_now', 'found', 'other', 'zzz'].every(a => C.replyNeedsPerson({ action: a })));
  check('replyNeedsPerson: a reply with no action needs a person; no reply does not', C.replyNeedsPerson({ text: 'hi' }) && !C.replyNeedsPerson(null) && !C.replyNeedsPerson(undefined));
  const lead = (o = {}) => ({ updatedAt: 10, campaignReply: { at: 20, action: 'call' }, ...o });
  check('with the lead: open while newer than the last touch', C.replyNeedsPerson(null, lead()) && C.replyNeedsPerson({ at: 20, action: 'call' }, lead()));
  check('…not once the team touched the lead', !C.replyNeedsPerson(null, lead({ updatedAt: 30 })));
  check('…nor once TailorTalk marked attention handled', !C.replyNeedsPerson(null, lead({ tt: { attentionFrom: 25 } })));
  check('…a reply with no time is not open', !C.replyNeedsPerson({ action: 'call' }, lead()) && !C.replyNeedsPerson('call', lead()));
  check('…and the no-person actions stay closed', !C.replyNeedsPerson(null, lead({ campaignReply: { at: 20, action: 'not_this' } })));
}

section('holdWhy / holdReason — the server’s rules, the server’s words');
{
  const ctx = (o = {}) => ({ optOut: new Set(['919000000001']), marketingOptOut: new Set(['919000000004']), sentNumbers: new Set(['919000000002']), marketing: true, gapDays: 7, now: NOW, ...o });
  const W = (lead, contact, o) => { const w = C.holdWhy(lead, contact, ctx(o)); return w ? w.code : ''; };
  const n = '919000000009';
  check('no number', W({}, '') === 'no number' && C.holdReason({}, '', ctx()) === 'No WhatsApp number');
  check('opted out — on the list or on the lead', W({}, '919000000001') === 'opted out' && W({ waOptOut: true }, n) === 'opted out' && C.holdReason({ waOptOut: true }, n, ctx()) === 'Asked not to be messaged');
  check('duplicate, dead', W({}, '919000000002') === 'duplicate number' && W({ tt: { status: 'dead' } }, n) === 'dead');
  check('no offers — on the lead or the list (Marketing only)', W({ waMarketingOptOut: true }, n) === 'no offers' && W({}, '919000000004') === 'no offers'
    && W({ waMarketingOptOut: true }, n, { marketing: false }) === '' && C.holdReason({ waMarketingOptOut: true }, n, ctx()) === 'Asked for no more offers');
  check('messaged recently — by lastMarketingAt', W({ lastMarketingAt: NOW - 3 * DAY }, n) === 'messaged recently' && W({ lastMarketingAt: NOW - 8 * DAY }, n) === ''
    && C.holdReason({ lastMarketingAt: NOW - 3 * DAY }, n, ctx()) === 'Messaged in the last 7 days');
  check('a Utility send since the last offer does not count once lastMarketingAt is kept', W({ lastMarketingAt: NOW - 20 * DAY, lastCampaignAt: NOW - DAY }, n) === '');
  check('a lead from before lastMarketingAt falls back to lastCampaignAt', W({ lastCampaignAt: NOW - DAY }, n) === 'messaged recently');
  check('two offers unanswered within 60 days', W({ marketingUnanswered: 2, lastMarketingAt: NOW - 30 * DAY }, n) === 'two offers unanswered'
    && W({ marketingUnanswered: 2, lastMarketingAt: NOW - 61 * DAY }, n) === '' && W({ marketingUnanswered: 1, lastMarketingAt: NOW - 30 * DAY }, n) === '');
  check('Negotiating / Won — stage as a string or a function', W({}, n, { stageKey: 'negotiation' }) === 'in negotiation/won' && W({ s: 'won' }, n, { stageKey: l => l.s }) === 'in negotiation/won'
    && C.holdReason({}, n, ctx({ stageKey: 'won' })) === 'Won — no Marketing messages' && W({}, n, { stageKey: 'visit_done' }) === '');
  check('…the referral ask is exempt', W({}, n, { stageKey: 'won', purpose: 'referral' }) === '');
  check('inside the free 24-h window', W({ tt: { lastMessageAt: NOW - 23 * H } }, n) === 'inside free 24-h window — reply in chat' && W({ tt: { lastMessageAt: NOW - 25 * H } }, n) === ''
    && C.holdReason({ tt: { lastMessageAt: NOW - H } }, n, ctx()) === 'Inside free 24-h window — reply in chat');
  check('Utility skips every Marketing rule', W({ waMarketingOptOut: true, lastMarketingAt: NOW - DAY, marketingUnanswered: 5, tt: { lastMessageAt: NOW - H } }, n, { marketing: false, stageKey: 'won' }) === '');
  check('the server’s order when several apply', W({ waMarketingOptOut: true, lastMarketingAt: NOW - DAY }, n) === 'no offers'
    && W({ lastMarketingAt: NOW - DAY, marketingUnanswered: 3 }, n) === 'messaged recently'
    && W({ marketingUnanswered: 3, lastMarketingAt: NOW - 10 * DAY }, n, { stageKey: 'won' }) === 'two offers unanswered'
    && W({ tt: { lastMessageAt: NOW - H } }, n, { stageKey: 'negotiation' }) === 'in negotiation/won');
  check('a typed-in contact (no lead) is judged by its number alone', W(null, n) === '' && W(null, '919000000004') === 'no offers');
  check('inFreeWindow', C.inFreeWindow({ tt: { lastMessageAt: NOW - H } }, NOW) && !C.inFreeWindow({}, NOW) && !C.inFreeWindow(null, NOW));
}

section('campaignStats — what one campaign earned');
{
  const T0 = NOW - 30 * DAY;
  const leads = {
    A: { id: 'A', reached: { visit_pending: T0 + 2 * DAY, won: T0 + 10 * DAY } },
    B: { id: 'B', siteVisitAt: T0 + 5 * DAY, siteVisitStatus: 'scheduled', siteVisitSetAt: T0 + DAY },
    C: { id: 'C', waMarketingOptOut: true, waMarketingOptOutAt: T0 + 3 * H },
    D: { id: 'D', siteVisitAt: T0 + 30 * DAY, siteVisitStatus: 'scheduled', siteVisitSetAt: T0 + 20 * DAY, reached: { won: T0 + 25 * DAY } }, // outside both windows
    E: { id: 'E' },
    F: { id: 'F', siteVisitAt: T0 + 5 * DAY, siteVisitStatus: 'cancelled', siteVisitSetAt: T0 + DAY }
  };
  const camp = { createdAt: T0, category: 'MARKETING', template: 'new_listing_v2', journey: 'new_listing', recipients: {
    A: { status: 'replied', reply: { action: 'visit' } },
    B: { status: 'read' },
    C: { status: 'replied', reply: { action: 'marketing_optout' } },
    D: { status: 'delivered' },
    E: { status: 'replied', reply: { action: 'ack' } },
    F: { status: 'replied', reply: { action: 'not_this' } },
    G: { status: 'failed' },
    H: { status: 'cancelled' },
    m_91: { status: 'sent', manual: true }
  } };
  const s = C.campaignStats(camp, leads, NOW);
  check('reached: sent, delivered, read, replied — typed-in contacts too, never failed or cancelled', s.reached === 7, s);
  check('replies by sentiment', s.replied === 4 && s.positive === 1 && s.neutral === 1 && s.negative === 2, s);
  check('opt-outs: the “stop offers” reply', s.optOuts === 1, s);
  check('visits booked within 14 days (a milestone or a visit set), not a cancelled one, not later', s.visitsBooked === 2, s);
  check('won within 21 days', s.won === 1, s);
  check('cost at the Marketing rate', s.cost === Math.round(7 * 0.79 * 100) / 100, s.cost);
  check('cost per positive reply and per visit', s.costPerPositive === s.cost && s.costPerVisit === Math.round((s.cost / 2) * 100) / 100, s);
  check('the windows have passed → final', s.counting === false && C.campaignStats(camp, leads, T0 + DAY).counting === true);
  check('leadsById may be a Map', JSON.stringify(C.campaignStats(camp, new Map(Object.entries(leads)), NOW)) === JSON.stringify(s));
  check('a lead who opted out within 14 days without replying counts', C.campaignStats({ createdAt: T0, recipients: { Z: { status: 'read' } } }, { Z: { waOptOutAt: T0 + DAY } }, NOW).optOuts === 1);
  const empty = C.campaignStats({ createdAt: T0, category: 'UTILITY', recipients: { a: { status: 'failed' } } }, {}, NOW);
  check('nothing reached: zeros, nothing per anything', empty.reached === 0 && empty.cost === 0 && empty.costPerPositive === null && empty.costPerVisit === null);
  check('the settings’ rate', C.campaignStats(camp, leads, NOW, { marketingRate: 1 }).cost === 7);

  section('templateJourneyTable — which template, by which journey, earns its keep');
  const camp2 = { createdAt: T0, category: 'MARKETING', template: 'new_listing_v2', journey: 'new_listing', recipients: { E: { status: 'read' }, B: { status: 'replied', reply: { action: 'call' } }, A: { status: 'sent' } } };
  const camp3 = { createdAt: T0, category: 'UTILITY', template: 'visit_reminder_v2', recipients: { E: { status: 'read' } } };
  const csv = { createdAt: T0, mode: 'csv', template: 'old_csv', recipients: { E: { status: 'exported' } } };
  const rows = C.templateJourneyTable([camp, camp2, camp3, csv, null], leads, NOW);
  const nl = rows.find(r => r.template === 'new_listing_v2');
  check('one row per template × journey, most sent first; CSV exports left out', rows.length === 2 && rows[0] === nl && nl.journey === 'new_listing' && rows[1].journey === null, rows);
  check('sends and campaigns summed', nl.sends === 10 && nl.campaigns === 2, nl);
  check('percentages to one decimal', nl.positivePct === 20 && nl.optOutPct === 10 && nl.visitsPer100 === 40, nl);
  check('cost per visit across the row', nl.costPerVisit === Math.round(((7 + 3) * 0.79 / 4) * 100) / 100, nl);
  check('no visits → no cost per visit', rows[1].costPerVisit === null && rows[1].visitsPer100 === 0);
}

section('unchanged: cost, quiet hours');
{
  check('estimateCost', C.estimateCost(100, 'MARKETING', {}).total === 79 && C.estimateCost(10, 'UTILITY', { utilityRate: 0.2 }).total === 2);
  check('quiet hours', C.inQuietHours(Date.UTC(2026, 10, 5, 21) - 5.5 * H) && !C.inQuietHours(Date.UTC(2026, 10, 5, 12) - 5.5 * H));
}

section('fallback words — a lead with no value still gets the message');
{
  const vars = ['name', 'property', 'code', 'visit_date'];
  const mapping = { name: { source: 'lead_name' }, property: { source: 'property', fallback: 'your property' }, code: { source: 'code' }, visit_date: { source: 'visit_date', fallback: '  soon ' } };
  const none = C.valuesFor(vars, mapping, { lead: { name: 'Ravi Kumar' }, prop: null, visit: null });
  check('no property: the fallback words', none.property === 'your property', none);
  check('no visit: the fallback, trimmed', none.visit_date === 'soon', none);
  check('no fallback given: still empty, so held back', none.code === '' && C.missingVars(vars, none).join() === 'code', C.missingVars(vars, none));
  check('which values fell back', C.fellBack(vars, mapping, none).join() === 'property,visit_date', C.fellBack(vars, mapping, none));
  const has = C.valuesFor(vars, mapping, { lead: { name: 'Ravi' }, prop: { id: 'MADA0001', propertyCode: 'MADA0001', name: 'Radiance Solitaire' }, visit: null });
  check('a lead with a property: theirs, not the fallback', /Radiance/.test(has.property) && !C.fellBack(vars, mapping, has).includes('property'), has);
  check('a suggestion for each source that can be empty', C.FALLBACK_HINTS.property === 'your property' && 'visit_date' in C.FALLBACK_HINTS);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
