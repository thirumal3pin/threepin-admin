// WhatsApp campaigns — replies close the loop. A lead who answers a campaign is read, filed under
// what they asked for, and handed to a person: the campaign counts the reply, the lead carries it
// (lead.campaignReply, lead.campaignLog), a follow-up is set when one is due, and "stop" means
// stop — for good, in every campaign after it ("stop offers": no more Marketing messages).
//
//   readReply(text, buttons, ctx)       what a reply asks for: { action, note?, when? } (pure)
//   classifyReply(text, buttons, ctx)   just the action — one of ACTIONS (pure)
//   parseWhen(text, at)                 "after 6", "tomorrow evening", "after Pongal" → a time (pure)
//   replyCandidates(chatHistory)        the lead's messages that answer a template (pure)
//   applyCampaignReplies(db, …)         those messages, matched to their campaign and recorded
//   withCampaignLog(log, entry)         lead.campaignLog with one entry put in (pure; the sender uses it)
//   templateStatusChanges(db, …)        TailorTalk's template statuses against the last seen
//   campaignDigest(db, …) + formatters  the morning digest's "WhatsApp campaigns" section
//
// Where a reply comes from: TailorTalk records a template it sent as an assistant turn with
// metadata { type: 'template', template_name } and no text; whatever the lead says next is an
// ordinary user message (a quick-reply tap arrives as the button's text). Webhooks carry the whole
// chat and the nightly sync replays it, so every step here is idempotent — a message already
// recorded on its campaign's recipient (replyKeys) is never applied twice, and the lead remembers
// how far each template's replies were read (lead.campaignReplySeen) so a chat that has moved on
// costs no more reads.
//
// Nothing here moves lead.updatedAt or updatedBy: a reply stays "open" until a person acts on the
// lead after it, exactly like a TailorTalk signal (crm-assets/leadAttention.js openCampaignReply).
// An acknowledgement ("ok", "thanks", a visit confirmed) is recorded on the campaign and in the
// lead's campaign history only — it needs nobody.
//
// Takes `db` as an argument (never imports firebase-admin itself) so tests run it against the
// in-memory Firestore.

import { normaliseChat, isNoReplyMarker, isHumanReply, escapeHtml } from './_tailortalk-shared.js';
import { writeLead } from './_lead-views.js';
import { waNumber, laterStatus, tally, validTemplateName } from '../crm-assets/campaignModel.js';
import { stageKeyOf } from '../crm-assets/pipeline.js';
import { KNOWN_TEMPLATES } from './_campaign-known.js';

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const IST_OFFSET_MS = 5.5 * HOUR;
// A message counts as a reply for this long after the template; a campaign is matched to the
// template entry by its send time within MATCH_MS, else the nearest within FALLBACK_MS.
const REPLY_WINDOW_MS = 7 * DAY;
const MATCH_MS = 15 * MIN;
const FALLBACK_MS = 7 * DAY;
export const LOG_MAX = 20;
const REPLY_MAX = 200;
const NOT_NOW_MS = 30 * DAY;
const LATER_MS = 3 * DAY;
const SEEN_MAX = 40;
// A template entry proves the message arrived, so a send recorded as failed — or never answered —
// still takes its reply; a CSV campaign's people got theirs through TailorTalk's own broadcast.
const ANSWERED = new Set(['sent', 'delivered', 'read', 'replied', 'failed', 'sending', 'exported']);
export const MEDIA_REPLY = '(sent a photo/file)';

// ─── what a reply asks for ──────────────────────────────────────────────

const whenLabel = ms => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const withWhen = (s, x) => (x && x.when ? `${s} (${whenLabel(x.when)})` : s);

// Each action, what the lead history says, and the note on the follow-up it sets. `none`: no
// follow-up at all (the lead is not waiting for anyone); afterMs: how far out when no time was said.
export const ACTIONS = {
  optout:           { means: 'Asked to stop messages', none: true },
  marketing_optout: { means: 'Asked to stop offers', none: true },
  ack:              { means: 'Acknowledged', none: true },
  not_this:         { means: 'Not interested in this one', none: true,     note: (c, t, x) => `Not interested in ${(x && x.subject) || c}` },
  call:             { means: 'Asked for a call',                          note: (c, t, x) => withWhen(`Asked for a call — ${c}`, x) },
  visit:            { means: 'Wants a site visit',                        note: c => `Wants a site visit — ${c}` },
  options:          { means: 'Wants options or details',                  note: c => `Wants options/details — ${c}` },
  feedback:         { means: 'Gave feedback',                             note: (c, t) => `Feedback on ${c}: “${clip(t, 120)}”` },
  not_now:          { means: 'Said not now', afterMs: NOT_NOW_MS,         note: (c, t, x) => withWhen('Said not now — check back', x) },
  found:            { means: 'Says they found a property',
                      note: (c, t, x) => (x && ['negotiation', 'won'].includes(x.stageKey) ? 'Says they booked — check if it was with us' : 'Says they found a property — mark Lost?') },
  reschedule:       { means: 'Wants to reschedule the visit',             note: (c, t, x) => withWhen('Wants to reschedule the visit', x) },
  referral:         { means: 'Wants to refer someone',                    note: () => 'Get their friend’s name & number' },
  seller:           { means: 'Wants to sell or list a property',          note: () => 'Wants to sell/list' },
  loan:             { means: 'Needs help with a home loan',               note: () => 'Needs home-loan help' },
  other:            { means: 'Replied',                                   note: (c, t) => `Replied: “${clip(t, 120)}”` }
};

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Lower case, curly quotes straightened, emoji and punctuation dropped (Tamil letters kept).
const norm = s => String(s || '').toLowerCase().replace(/[’‘`]/g, "'")
  .replace(/[^\p{L}\p{M}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// The quick replies 3 PIN's templates carry, as TailorTalk delivers a tap (the button's text).
const BUTTONS = {
  'stop': 'optout', 'unsubscribe': 'optout',
  'stop offers': 'marketing_optout', 'stop promotions': 'marketing_optout', 'no offers': 'marketing_optout',
  'not interested': 'not_this', 'not for me': 'not_this',
  'request a call': 'call', 'talk to the team': 'call', 'call me': 'call', 'call back': 'call',
  'book a visit': 'visit', 'book a site visit': 'visit', 'confirmed': 'visit', 'confirm': 'visit',
  'share similar options': 'options', 'show similar properties': 'options', 'show me more': 'options',
  'send details': 'options', 'send brochure': 'options', 'still looking': 'options',
  'yes share options': 'options', 'share options': 'options', 'buy property': 'options', 'rent property': 'options',
  'liked it': 'feedback', 'share feedback': 'feedback',
  'not now': 'not_now',
  'found a property': 'found', 'already bought': 'found',
  'reschedule': 'reschedule',
  'thank you': 'ack', 'thanks': 'ack',
  'refer someone': 'referral', 'refer a friend': 'referral',
  'sell or list property': 'seller', 'sell property': 'seller', 'list my property': 'seller',
  'help with loan': 'loan', 'home loan help': 'loan',
  // The starter templates' other buttons (crm-assets/campaignModel.js STARTERS).
  'yes send them': 'options', 'send fresh options': 'options', 'send matches': 'options', 'share location': 'options',
  'have some concerns': 'feedback', 'write a review': 'feedback', 'review the price': 'call',
  'all good': 'ack', 'not yet': 'not_now', 'உறுதி': 'visit', 'நேரம் மாற்ற': 'reschedule'
};

// Words that carry no meaning of their own in a short reply.
const FILLER = /\b(sir|madam|mam|maam|ma'am|ji|bro|anna|akka|da|pa|ma|please|pls|plz|kindly|just|dear)\b/g;
const strip = (t, re = FILLER) => t.replace(re, ' ').replace(/\s+/g, ' ').trim();

const ACK_WORDS = "ok|okay|okey|okk+|k|kk|fine|noted|done|thanks|thank you|thanku|thankyou|thank u|tq|ty|thx|seri|sari|sare|got it|received|alright|cool|great|good|சரி|நன்றி";
const ACK_VISIT = "coming|will come|i will come|i'll come|ill come|we will come|we'll come|varen|varom|varuvom|confirmed|confirm|yes confirmed|see you|உறுதி|yes|yeah|yep|yup|ya|sure";
const YES = /^(ok |okay )?(yes|yeah|yep|yup|ya|yea|s|ss|sure|haan|ha|aama|aamam|amam|aam|definitely|of course|ofcourse|yes yes)( sure| please| pls| ok)?$/;
const NO = /^(no|nope|nah|na|illa|illai|illa illa|no no|இல்லை)$/;
const YES_BY = { visit_reminder: 'ack', visit_confirmed: 'ack', no_show: 'reschedule', search_checkin: 'options', sold_out: 'options', new_listing: 'options', price_drop: 'options', price_update: 'options',
  reengage: 'options', options_followup: 'options', followup: 'options', brochure: 'options', referral: 'referral', visit_feedback: 'feedback', feedback_nudge: 'feedback' };
const NO_BY = { search_checkin: 'not_this', sold_out: 'not_this', new_listing: 'not_this', price_drop: 'not_this', price_update: 'not_this', reengage: 'not_this', options_followup: 'not_this',
  followup: 'not_this', brochure: 'not_this', referral: 'not_this', visit_reminder: 'reschedule', visit_confirmed: 'reschedule', visit_feedback: 'feedback', feedback_nudge: 'feedback' };

// "Don't want it" — Tamil, Tanglish and English. With a messaging word it is a stop; with "now" or
// a time it is "not now"; alone it is "not this one" — never a stop.
const DECLINE = /\b(not interested|not intrested|not intersted|no interest|not looking|venda+|vendam|vendaam|venaam|venam|thevai ?illa|thevai ?illai|thevaiyillai|don'?t want|dont want|do not want|not required|not needed|no need|no thanks|no thank you|not for me|pidikala|pudikala|pidikkala|pudikkala)\b|வேண்டாம்|தேவையில்லை|பிடிக்கல/;
const DECLINE_ONLY = /^((not interested|not intrested|not intersted|no interest|venda+|vendam|vendaam|venaam|venam|thevai ?illa|thevai ?illai|thevaiyillai|don'?t want|dont want|do not want|not required|not needed|no need|no thanks|no thank you|not for me|pidikala|pudikala|pidikkala|pudikkala|வேண்டாம்|தேவையில்லை|பிடிக்கல)( (it|this|that|one))?\s?)+$/;
const DECLINE_EXTRA = /\b(i am|i'm|im|we are|we're|anymore|any more|thank you|thanks|thanku|sorry|in (this|that|the) (property|one|flat|house|home|project|villa|plot|place|apartment|offer|listing)|for (this|that) (one|property|flat)|right now|idhu|indha|ok)\b/g;
const NOW_OR_TIME = /\b(now|ippo|ipo|ippodhu|ippothu|ippa|ippodhaiku|currently|at the moment|this time|for now|later|next (week|month|year)|after|\d+ (days?|weeks?|months?|years?)|(few|couple of) (days|weeks|months)|this year|maybe)\b|இப்போ|இப்ப/;
const MSG_WORD = /\b(message|messages|msg|msgs|send|sending|whatsapp|contact|text|texting|sms)\b/;
const POSITIVE_ASK = /\b(send|share|show)( me| us)?( the| some| more| other| similar| any)?( \w+){0,3} (options?|details|brochure|properties|flats|homes|houses|villas|plots|pics|photos|location|list)\b|\bany (other )?(\d+ ?)?(bhk|options?|flats?|properties|villas?|plots?|houses?|homes?)\b|\bwhat about\b|\binstead\b/;

const OPTOUT = [
  /\b(unsubscribe|unsubscribed|opt ?out|optout)\b/,
  /\bstop (messaging|texting|calling|contacting|spamming|disturbing|pinging|bothering|whatsapping)\b/,
  /\bstop sending( me| us)?( (any ?more|these|this|such|your|the|all))*( (messages?|msgs?|texts?|whatsapps?|anything|it|them))?( (any ?more|now))*$/,
  /^(just )?stop( (it|this|all|now|this message|these messages|messages|msgs|msg|immediately|spam|spamming))*$/,
  /\bstop$/,
  /\bno more (messages?|msgs?|texts?|whatsapps?|calls?|spam)\b/,
  /\b(don'?t|do not|dont|never) (message|msg|text|disturb|contact|whatsapp|spam|bother)\b/,
  /\b(don'?t|do not|dont|never) (send|sent)( me| us)?( (any|anymore|these|such|your))* (messages?|msgs?|anything|texts?|whatsapps?)\b/,
  /\b(don'?t|do not|dont|never) (call|phone)( me)? (or|and) (message|msg|text|whatsapp)\b|\b(message|msg|text) (me )?(or|and) call\b/,
  /\bremove (me|my number|my no|this number|my contact|us|from (your|the|this) (list|group))\b|^remove$/,
  /^(i will |i'll |ill |will )?(block|blocked|blocking)( (you|u|this|this number|your number|it))?$|\b(will|going to|gonna) block\b/,
  /\bwrong (number|no|person|contact)\b/,
  /\bspam(ming)?\b/,
  /\bhow (did|do) (you|u) (get|got|have) (my|this) (number|no|contact|details)\b/,
  /\bthollai\b/,
  /\b(message|msg|msgs|messages|sms) ?(anuppadheenga|anupadheenga|anuppathinga|anupathinga|anuppaatheenga|anupatheenga|anuppadhinga|anupadhinga|anuppadhe|anuppa vendam|anupa vendam|anuppa venam|anupa venam|anuppa vendaam|anupa vendaam|podadheenga|podatheenga)\b/
];
const OPTOUT_TA = ['அனுப்ப வேண்டாம்', 'தொல்லை', 'மெசேஜ் வேண்டாம்'];
const MARKETING_OPTOUT = /\bstop (the |all |your )?(offers?|promotions?|promos?|ads|adverts?|advertisements?|marketing|promotional( messages)?|deals)\b|\bstop sending( me| us)? (offers?|promotions?|promos?|ads|deals)\b|\bno (more )?(offers?|promotions?|promos?|ads|deals)\b|\b(don'?t|do not|dont) send (me |us )?(any )?(offers?|promotions?|promos?|ads|deals)\b/;
const WHO = /\b(who (is|r|are) (this|you|u)|who'?s this|who is it|neenga yaaru|neenga yaar|yaaru neenga|yaar neenga|nee yaaru|yaaru|yaar ivanga)\b|யாரு|யார் நீங்க/;
const FOUND = /\b(bought|purchased|booked|finali[sz]ed|found|already got|already took)( a| the| one| my| another| our)? (property|house|home|flat|apartment|villa|plot|place)\b|\balready (bought|purchased|booked|found|finali[sz]ed|got (one|it))\b|\bfound (one|it)\b|\bdeal (is )?(done|closed)\b|\bva+ngi(ten|tom|yachu|ttom|tom)\b/;
const NOT_DONE = /\b(not|never|haven'?t|havent|hasn'?t|didn'?t|didnt|yet to|not yet|no)\b( \w+){0,3} (bought|found|purchased|booked|finali[sz]ed|got)\b|\byet\b/;
const REFERRAL = /\b(refer|referral|referring|reference|my (friend|relative|brother|sister|cousin|colleague|neighbour|neighbor)s? (is|are|wants?|looking|needs?))\b/;
const SELLER = /\b(sell(ing)? (my|our)|want to sell|wanna sell|planning to sell|i('?m| am) (a )?seller|seller here|sell or list|list (my|our) (property|flat|house|home|plot|villa|land)|resale (my|our))\b|^sell$/;
const LOAN = /\b(loan|loans|emi|emis|home ?loan|bank loan|financing|finance option)\b/;
const CALL_LATER = /\b(call|contact|ring|ping)( me| you| u)? (later|after some ?time|some ?time later)\b|\b(i'?ll|i will|will|we will|we'?ll) (call|contact|ping|get back|revert|reach)( back)?( to)?( you| u)?\b|\bget back to (you|u)\b/;
const DONT_CALL = /\b(don'?t|do not|dont|no|never) (call|calls|phone)\b/;
const RESCHEDULE = /\b(reschedul\w*|prepone\w*|(another|different|other) (day|date|time|slot)|change (the |my )?(date|time|day|slot)|can'?t (come|make it|visit)|cannot (come|make it|visit)|can not (come|visit)|won'?t (be able to )?come|will not (be able to )?come|not able to (come|visit|make it)|unable to (come|visit)|not coming|vera (naal|day|time|date)|varala|vara mudiyadhu|vara mudiyathu|vara mudiyaadhu|varamudiyadhu|varamudiyathu|vara mudiyala|vara mudiyaathu)\b/;
const POSTPONE = /\bpostpon\w*/;
const LATE = /\b(late aagum|late agum|late aaghum|late ahum|will be (a bit |a little |little |bit |\d+ ?(min|mins|minutes) )?late|running late|getting late|coming late|\d+ ?(min|mins|minutes) late|bit late|little late)\b/;
const CALL = /\b(call|calling|phone me|ring me|talk to (the |your )?team|speak (to|with)|contact me|reach me|callback|call ?back|call pannunga|call pannu|call panunga|call pannuga|call podunga)\b|கால் பண்ண|அழைக்க/;
const APRAM = /\b(apram|aprom|appuram|apparam|piragu|piraku|later) (paakalam|pakkalam|paarkalam|pakalam|solren|solrom|sollren|sollrom)\b/;
const VISIT = /\b(visit|visiting|site ?visit|see the (property|flat|house|home|place|site|villa)|come and see|come to see|confirmed|confirm|i'?ll come|i will come|will come|we will come|we'?ll come|paakanum|pakkanum|paakalam|pakkalam|paaka|varen|varom|varuvom|coming)\b|பார்க்க|வருகிறேன்|வருவோம்/;
const NOT_NOW = /\b(not now|not right now|later|maybe later|next (week|month|year)|after (diwali|deepavali|pongal|new year|some ?time|a (few|couple of) (days|weeks|months)|few (days|weeks|months)|\d+ (days|weeks|months|years))|\d+ (months|years)|busy|some ?time later|apram|aprom|appuram|apparam|piragu|piraku|naalaiku|nalaiku|naalaikku|tomorrow)\b|பிறகு|அப்புறம்/;
const LOCATION = /\b(location|map|address|pin|route|directions?)\b/;
const OPTIONS = /\b(similar|options?|show (me )?more|more (options|properties|details|homes|flats)|send (me )?(the )?(details|brochure|info|pics|photos|pictures|location|price)|brochure|still looking|yes,? share|anupunga|anuppunga|send pannunga|share pannunga|venum|venuum|vennum|evlo|evvlo|evvalavu|evalavu|rate enna|price enna|enna rate|enna price|vilai)\b|அனுப்ப|எவ்வளவு|வேணும்/;
const OPTIONS_WEAK = /\b(details|share|(?<!not )(?<!no )interested|(?<!not )intrested|price|prices|rate|cost|location|buy|rent|purchase|looking for|budget|bhk|available|availability)\b/;
const FEEDBACK = /\b(liked it|loved it|liked the|loved the|feedback|pidichirukku|pidichiruku|nalla irukku|nalla iruku|didn'?t like|did not like)\b|பிடிச்சிருக்கு/;

/**
 * What a reply to a campaign asks for — and, for a call / not now / reschedule, when.
 * @param {string} text            what the lead said (a button tap arrives as the button's text)
 * @param {Array}  templateButtons the template's quick replies (strings or { text })
 * @param {object} ctx             { purpose, template, at } — the template's purpose decides what a
 *                                 bare "yes"/"no" means; `at` (the reply's time) anchors "after 6"
 * @returns {{ action: string, note?: string, when?: number }}
 */
export function readReply(text, templateButtons = [], ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { action: 'other' };
  if (raw === MEDIA_REPLY) return { action: 'other', note: 'Sent a photo or file — open the chat' };
  const at = ctx.at || Date.now();
  const t = norm(raw);
  // A thumbs-up, a folded-hands: emoji alone is a nod.
  if (!t) return /^[\s\u{1F44D}\u{1F64F}\u{1F44C}✅\u{1F642}\u{1F60A}☺️\u{1F3FB}-\u{1F3FF}]+$/u.test(raw) ? { action: 'ack' } : { action: 'other' };
  const purpose = String(ctx.purpose || '');
  const where = `${purpose} ${ctx.template || ''}`;
  const visitCtx = /visit_(reminder|confirm)/.test(where);
  const feedbackCtx = /feedback/.test(where);
  const question = /\?\s*$/.test(raw) || /^(have|has|did|do|does|any|is|are|can|could|will|would) /.test(t);
  const when = () => parseWhen(raw, at);
  const timed = (action, fallbackMs) => { const w = when() || (fallbackMs ? at + fallbackMs : null); return w ? { action, when: w } : { action }; };

  // A known button — tapped, or the same words typed — means what that button means.
  const buttons = (Array.isArray(templateButtons) ? templateButtons : []).map(b => norm(typeof b === 'string' ? b : b && b.text)).filter(Boolean);
  const tapped = buttons.includes(t);
  if (BUTTONS[t]) {
    if (BUTTONS[t] === 'visit' && visitCtx) return { action: 'ack' };
    if (LOCATION.test(t)) return { action: 'options', note: 'Asked for the location — share the map pin' };
    return { action: BUTTONS[t] };
  }

  // Stops first, at any length: offers only, then everything.
  if (MARKETING_OPTOUT.test(t)) return { action: 'marketing_optout' };
  const core = strip(t);
  if (OPTOUT.some(re => re.test(t) || (core && re.test(core))) || OPTOUT_TA.some(w => t.includes(w))) return { action: 'optout' };
  const positive = POSITIVE_ASK.test(t);
  if (DECLINE.test(t) && MSG_WORD.test(t) && !positive) return { action: 'optout' };
  // "Who is this?" — not a stop yet, but close to one: a person should answer, personally.
  if (WHO.test(t)) return { action: 'other', note: 'Asked who we are — reply personally' };

  // The whole message is a nod (or, on a visit message, a confirmation).
  if (core && new RegExp(`^((${ACK_WORDS}${visitCtx ? '|' + ACK_VISIT : ''})\\s?)+$`).test(core)) return { action: 'ack' };
  // A bare yes or no means what the template asked.
  if (YES.test(core)) return { action: YES_BY[purpose] || (visitCtx ? 'ack' : feedbackCtx ? 'feedback' : 'other') };
  if (NO.test(core)) return { action: NO_BY[purpose] || (visitCtx ? 'reschedule' : feedbackCtx ? 'feedback' : 'other') };

  // "Don't want" with a time ("ippo vendam", "not interested now, maybe next year") is not now.
  if (DECLINE.test(t) && !positive && NOW_OR_TIME.test(t)) return timed('not_now');
  // …alone, it is "not this one" — never a stop.
  const declineCore = strip(strip(t, DECLINE_EXTRA));
  if ((core && DECLINE_ONLY.test(core)) || (declineCore && DECLINE_ONLY.test(declineCore))) return { action: 'not_this' };

  if (FOUND.test(t) && !question && !NOT_DONE.test(t)) return { action: 'found' };
  if (REFERRAL.test(t)) return { action: 'referral' };
  if (SELLER.test(t)) return { action: 'seller' };
  if (LOAN.test(t)) return { action: 'loan' };
  // "Call me later", "I'll get back to you": the lead will come back — check in a few days.
  if (CALL_LATER.test(t)) return timed('not_now', LATER_MS);
  if (RESCHEDULE.test(t) || (POSTPONE.test(t) && (visitCtx || /visit/.test(t)))) return timed('reschedule');
  if (LATE.test(t)) return { action: 'other', note: `Says they will be late — “${clip(raw, 80)}”` };
  if (DONT_CALL.test(t)) {
    if (OPTIONS.test(t) || OPTIONS_WEAK.test(t)) return { action: 'options', note: 'Wants details on WhatsApp — don’t call' };
    return { action: 'other', note: 'Prefers WhatsApp — don’t call' };
  }
  if (CALL.test(t)) return timed('call');
  // "Later" said outright — before "paakalam" (let's see) reads as wanting a visit.
  if (APRAM.test(t)) return timed('not_now');
  if (VISIT.test(t)) return { action: visitCtx && /^(coming|varen|varom|confirmed|confirm)$/.test(core) ? 'ack' : 'visit' };
  if (NOT_NOW.test(t) || POSTPONE.test(t)) return timed('not_now');
  if (OPTIONS.test(t) || positive) return LOCATION.test(t) ? { action: 'options', note: 'Asked for the location — share the map pin' } : { action: 'options' };
  // Weaker signs of wanting to hear more — not used to answer a feedback message.
  if (!feedbackCtx && OPTIONS_WEAK.test(t)) return LOCATION.test(t) ? { action: 'options', note: 'Asked for the location — share the map pin' } : { action: 'options' };
  if (FEEDBACK.test(t)) return { action: 'feedback' };
  // Anything written in answer to "how was the visit?" is feedback.
  return { action: feedbackCtx && !tapped ? 'feedback' : 'other' };
}

/** What a reply asks for: one of the ACTIONS keys (readReply without the details). */
export function classifyReply(text, templateButtons = [], ctx = {}) {
  return readReply(text, templateButtons, ctx).action;
}

// ─── when ───────────────────────────────────────────────────────────────

// Festivals people put things off until (IST dates; a follow-up goes 3 days after).
const FESTIVALS = [
  [/\b(pongal|sankranti|sankranthi)\b|பொங்கல்/, ['2027-01-14', '2028-01-15', '2029-01-14', '2030-01-14', '2031-01-14']],
  [/\b(diwali|deepavali|divali|deepawali)\b|தீபாவளி/, ['2026-11-08', '2027-10-29', '2028-10-17', '2029-11-05', '2030-10-26', '2031-11-14']],
  [/\b(tamil new year|puthandu|varusha pirappu)\b/, 'MM-04-14'],
  [/\b(christmas|xmas)\b/, 'MM-12-25'],
  [/\bnew year\b/, 'MM-01-01']
];
const NUM = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, 'couple of': 2, few: 3, 'a few': 3 };
const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const istMidnightOf = ms => Math.floor((ms + IST_OFFSET_MS) / DAY) * DAY - IST_OFFSET_MS;
const istDay = s => Date.parse(s + 'T00:00:00+05:30');

/**
 * The time a reply names, in India time: "after 6" (6 PM), "tomorrow evening", "Sunday",
 * "next week", "6 months", "after Pongal" (+3 days). A day without a time is 10 AM that day; a
 * time already past today is tomorrow. null when no time is named.
 * @param {string} text  the reply
 * @param {number} at  when it was said
 */
export function parseWhen(text, at) {
  // As norm(), but "9:30" keeps its colon.
  const t = String(text || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/(\d)[:.](\d\d)\b/g, '$1:$2')
    .replace(/[^\p{L}\p{M}\p{N}':\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const day0 = istMidnightOf(at);
  const at10 = d => d + 10 * HOUR;
  const notBefore = ms => Math.max(ms, at);
  for (const [re, dates] of FESTIVALS) {
    if (!re.test(t)) continue;
    const y = new Date(at + IST_OFFSET_MS).getUTCFullYear();
    const list = Array.isArray(dates) ? dates.map(istDay) : [y, y + 1].map(yy => istDay(dates.replace('MM', yy)));
    const next = list.find(d => d + DAY > at);
    if (next) return at10(next + 3 * DAY);
  }
  let rel = null;
  const n = t.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|few|a couple of|couple of|a|an) (day|days|week|weeks|month|months|year|years)\b/);
  if (n) {
    const k = /^\d+$/.test(n[1]) ? Number(n[1]) : (NUM[n[1]] || 1);
    const unit = n[2].replace(/s$/, '');
    rel = k * (unit === 'day' ? DAY : unit === 'week' ? 7 * DAY : unit === 'month' ? 30 * DAY : 365 * DAY);
  } else if (/\bnext week\b/.test(t)) rel = 7 * DAY;
  else if (/\bnext month\b/.test(t)) rel = 30 * DAY;
  else if (/\bnext year\b/.test(t)) rel = 300 * DAY;
  if (rel !== null) return at10(istMidnightOf(at + rel));

  let dayOff = null;
  if (/\b(day after tomorrow|naalanniku|nalanniku|naalai marunaal)\b/.test(t)) dayOff = 2;
  else if (/\b(tomorrow|tmrw|tmr|tomo|naalaiku|nalaiku|naalaikku|naalai|nalaikku)\b|நாளை/.test(t)) dayOff = 1;
  else if (/\b(today|inniku|innaiku|inaiku|indru)\b|இன்று/.test(t)) dayOff = 0;
  else {
    const w = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)\b/);
    if (w) { const dow = new Date(at + IST_OFFSET_MS).getUTCDay(); dayOff = ((WEEKDAYS[w[1]] - dow + 7) % 7) || 7; }
  }
  let h = null, m = 0;
  const clock = t.match(/\b(?:after|at|by|around|abt|about|post|before)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/) || t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/);
  if (clock) {
    h = Number(clock[1]); m = Number(clock[2] || 0);
    if (clock[3] === 'pm' && h < 12) h += 12;
    else if (clock[3] === 'am' && h === 12) h = 0;
    // "after 6" is the evening: nobody means 6 in the morning.
    else if (!clock[3] && h >= 1 && h <= 8) h += 12;
    if (h > 23 || m > 59) { h = null; m = 0; }
  }
  if (h === null) {
    if (/\b(evening|evng|eve|saayangalam|sayangalam|sayankalam|saayankaalam|maalai|malai)\b|மாலை/.test(t)) h = 18;
    else if (/\b(morning|mrng|morng|kaalai|kalai|kaalaila)\b|காலை/.test(t)) h = 10;
    else if (/\b(afternoon|noon|madhiyam|mathiyam|madhiyanam)\b/.test(t)) h = 14;
    else if (/\b(night|nite|raathiri|rathiri|iravu|rathri)\b|இரவு/.test(t)) h = 20;
  }
  if (dayOff === null && h === null) return null;
  if (h === null) return notBefore(at10(day0 + dayOff * DAY));
  if (dayOff === null) dayOff = day0 + h * HOUR + m * MIN <= at ? 1 : 0;
  return notBefore(day0 + dayOff * DAY + h * HOUR + m * MIN);
}

// ─── which messages answer a template ───────────────────────────────────

const isTemplate = m => !!(m && m.meta && m.meta.type === 'template' && m.meta.template_name);

// TailorTalk's chat_history as it arrives (each message keeps its raw form, for content that is not
// text), or the CRM's stored (normalised) conversation.
function asChat(list) {
  if (!Array.isArray(list)) return [];
  const stored = list.some(m => m && typeof m.at === 'number' && m.time === undefined && m.k);
  const chat = stored ? list.map((m, i) => ({ ...m, i: m.i ?? i })) : normaliseChat(list).map(m => ({ ...m, raw: list[m.i] }));
  return chat.filter(m => m && m.at).sort((a, b) => (a.at - b.at) || (a.i - b.i));
}

// The lead's own words. A photo, a document or a swipe-reply with nothing typed is said so, never
// "[object Object]" or the text of the message they swiped on.
function replyText(m) {
  const raw = m.raw || null;
  const md = (raw && raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : null) || m.meta || null;
  if (md && md.type === 'reply') {
    const own = String(md.user_message || '').trim();
    if (own) return own;
    const c = typeof (raw && raw.content) === 'string' ? raw.content : String(m.content || '');
    const quoted = String(md.text || '');
    const rest = quoted && c.startsWith(quoted) ? c.slice(quoted.length).replace(/^\s*:\s*/, '') : (quoted ? '' : c);
    return rest.trim() || MEDIA_REPLY;
  }
  if (raw && Array.isArray(raw.content)) {
    const words = raw.content.map(p => (p && typeof p.text === 'string' ? p.text : '')).join(' ').trim();
    return words || MEDIA_REPLY;
  }
  const c = String(m.content || '').trim();
  if (/^\[object Object\]/.test(c)) return MEDIA_REPLY;
  if (c) return c;
  if (md && /^(document|image|video|audio|voice|sticker|media|file|photo)$/i.test(String(md.type || ''))) return MEDIA_REPLY;
  return '';
}

/** True when the chat holds a template TailorTalk sent — the cheap test before anything is read. */
export function hasTemplateEntry(chatHistory) {
  return Array.isArray(chatHistory) && chatHistory.some(m => m && ((m.metadata && m.metadata.type === 'template') || (m.meta && m.meta.type === 'template')));
}

/**
 * The lead's messages that answer a template: those after it, before 3 PIN's next reply (the AI
 * or a person on the team answering is where the reply ends and a conversation starts), within a
 * week of it.
 * @returns {Array<{ key, text, at, template, templateAt, repliedTo? }>} oldest first
 */
export function replyCandidates(chatHistory) {
  const out = [];
  let tpl = null, open = false;
  for (const m of asChat(chatHistory)) {
    if (isTemplate(m)) { tpl = m; open = true; continue; }
    if (!tpl || !open) continue;
    if (m.role === 'user') {
      const text = replyText(m);
      if (text && m.at - tpl.at <= REPLY_WINDOW_MS) {
        const md = (m.raw && m.raw.metadata) || m.meta || {};
        out.push({ key: m.k, text, at: m.at, template: String(tpl.meta.template_name), templateAt: tpl.at,
          ...(md && md.replied_to_message_id ? { repliedTo: String(md.replied_to_message_id) } : {}) });
      }
    } else if (isHumanReply(m) || (String(m.content || '').trim() && !isNoReplyMarker(m))) open = false;
  }
  return out;
}

// ─── the lead's campaign history ────────────────────────────────────────

/** lead.campaignLog with `entry` put in: merged into the entry for the same campaign, else first. */
export function withCampaignLog(log, entry) {
  const list = Array.isArray(log) ? log.filter(e => e && e.id) : [];
  const i = list.findIndex(e => e.id === entry.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = { ...list[i], ...entry };
    return next.slice(0, LOG_MAX);
  }
  return [entry, ...list].slice(0, LOG_MAX);
}

/** The WhatsApp / Meta error code in an error's text — "(#131050) …" or "131026 …" — or null. */
export function errorCodeOf(text) {
  const s = String(text || '');
  const m = s.match(/\(#(\d{3,6})\)/) || s.match(/\b(1[0-9]{5})\b/) || s.match(/\b(?:code|error)[:\s#]*(\d{3,6})\b/i);
  return m ? Number(m[1]) : null;
}

// ─── recording a reply ──────────────────────────────────────────────────

// The campaign a template entry belongs to. First, the message the lead swiped "reply" on, by its
// id. Else one of this tenant's campaigns with that template that reached this person: the one
// sent nearest the entry within a quarter of an hour, else the nearest within a week — unless
// another entry in the chat sits closer to that send (each send is one entry; a later re-send of
// the template from TailorTalk itself is not a CRM campaign). A CSV campaign has no send time:
// its people are matched by number within a week of it being made.
function matchCampaign(docs, leadId, contacts, cand, entryTimes = [cand.templateAt]) {
  const templateAt = cand.templateAt;
  const closer = sentAt => entryTimes.some(t => t !== templateAt && Math.abs(sentAt - t) < Math.abs(sentAt - templateAt));
  const hits = [];
  for (const d of docs) {
    const c = d.data();
    for (const [key, r] of Object.entries(c.recipients || {})) {
      if (!r || !ANSWERED.has(r.status)) continue;
      if (key !== leadId && !(r.contact && contacts.has(r.contact))) continue;
      const own = key === leadId;
      if (cand.repliedTo && r.messageId && r.messageId === cand.repliedTo) return { ref: d.ref, id: d.id, c, key, r, gap: 0, exact: true, own };
      if (c.mode === 'csv') {
        const made = c.createdAt || 0;
        if (made && templateAt >= made - HOUR && templateAt - made <= FALLBACK_MS) hits.push({ ref: d.ref, id: d.id, c, key, r, gap: Math.abs(templateAt - made), at: made, exact: false, own });
        continue;
      }
      if (!r.sentAt) continue;
      const gap = Math.abs(r.sentAt - templateAt);
      if (gap <= FALLBACK_MS) hits.push({ ref: d.ref, id: d.id, c, key, r, gap, at: r.sentAt, exact: gap <= MATCH_MS, own });
    }
  }
  if (!hits.length) return null;
  const byGap = (a, b) => (a.gap - b.gap) || (Number(b.own) - Number(a.own));
  const exact = hits.filter(h => h.exact);
  if (exact.length) return exact.sort(byGap)[0];
  return hits.filter(h => !closer(h.at)).sort(byGap)[0] || null;
}

async function templateInfo(db, tenantId, name, cache) {
  if (cache.has(name)) return cache.get(name);
  const snap = await db.collection('campaignTemplates').doc(tenantId + '__' + name).get().catch(() => null);
  const d = snap && snap.exists ? snap.data() : {};
  const k = KNOWN_TEMPLATES[name] || {};
  const out = { buttons: (Array.isArray(d.buttons) && d.buttons.length ? d.buttons : k.buttons) || [], purpose: d.purpose || k.purpose || '' };
  cache.set(name, out);
  return out;
}

const historyId = (campaignId, key) => `hc_${campaignId}_${key}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 140);
// A template entry in the chat, as lead.campaignReplySeen keys it.
const entryKey = c => `${c.template}@${Math.floor(c.templateAt / 1000)}`;
const entryAt = k => Number(String(k).split('@').pop()) * 1000 || 0;
// The subject of a "not interested": the property the message was about.
const subjectOf = (r, c) => { const v = (r && r.values) || {}; return v.property_code || v.code || v.property_name || v.property || c.name || c.template; };

function prunedSeen(seen, now) {
  const keep = Object.entries(seen || {}).filter(([k, v]) => Number.isFinite(v) && entryAt(k) >= now - REPLY_WINDOW_MS - 2 * DAY)
    .sort((a, b) => entryAt(b[0]) - entryAt(a[0])).slice(0, SEEN_MAX);
  return Object.fromEntries(keep);
}

/**
 * Finds the lead's replies to campaigns in its chat and records each one once.
 *
 * @param {object} db
 * @param {string} tenantId
 * @param {string} leadId         the lead the chat belongs to (the webhook's lead)
 * @param {?object} lead          the lead as stored, when the caller has it; else it is read
 * @param {Array}  chatHistory    TailorTalk's chat_history (or the stored conversation)
 * @param {object} o              { now, contact } — contact: the number the chat is with
 * @returns {{ ok, applied: Array<{ campaignId, recipient, lead, action, text }>, skipped?: string }}
 */
export async function applyCampaignReplies(db, tenantId, leadId, lead, chatHistory, { now = Date.now(), contact = null } = {}) {
  if (!hasTemplateEntry(chatHistory)) return { ok: true, applied: [], skipped: 'no template' };
  // A reply to a template older than the reply window was settled long ago (or never will be):
  // dropped before anything is read.
  let cands = replyCandidates(chatHistory).filter(c => c.templateAt >= now - REPLY_WINDOW_MS - DAY);
  if (!cands.length) return { ok: true, applied: [], skipped: 'no reply' };

  const leadRef = db.collection('leads').doc(leadId);
  if (!lead) {
    const snap = await leadRef.get();
    if (!snap.exists) return { ok: true, applied: [], skipped: 'no lead' };
    lead = snap.data();
  }
  if (lead.tenantId !== tenantId) return { ok: true, applied: [], skipped: 'other tenant' };
  // How far each template entry's replies were read — per entry, so a reply a webhook missed is
  // still found by the next pull even after a later one was recorded.
  const seen = { ...(lead.campaignReplySeen || {}) };
  cands = cands.filter(c => !(seen[entryKey(c)] >= c.at));
  if (!cands.length) return { ok: true, applied: [], skipped: 'already recorded' };

  // When each template was sent, by name — to pair sends with entries one to one.
  const entryTimes = new Map();
  for (const m of asChat(chatHistory)) if (isTemplate(m)) entryTimes.set(m.meta.template_name, [...(entryTimes.get(m.meta.template_name) || []), m.at]);
  const contacts = new Set([waNumber(contact), waNumber(lead.phone), waNumber(lead.tt && lead.tt.contact), lead.phoneKey && waNumber(lead.phoneKey)].filter(Boolean));
  const byTemplate = new Map();
  const tplCache = new Map();
  let stageOf = null;
  const applied = [];
  let seenDirty = false;
  const markSeen = (k, at) => { if (!(seen[k] >= at)) { seen[k] = at; seenDirty = true; } };

  for (const cand of cands) {
    if (!byTemplate.has(cand.template)) {
      const q = await db.collection('campaigns').where('tenantId', '==', tenantId).where('template', '==', cand.template).get();
      byTemplate.set(cand.template, q.docs);
    }
    const hit = matchCampaign(byTemplate.get(cand.template), leadId, contacts, cand, entryTimes.get(cand.template));
    // A template no campaign of the CRM sent (TailorTalk's own broadcast, a test): not ours to
    // file — and never looked up again.
    if (!hit) { markSeen(entryKey(cand), cand.templateAt + REPLY_WINDOW_MS + 1); continue; }
    // Two CRM leads on one number: the reply belongs to the lead the campaign messaged.
    let target = { id: leadId, ref: leadRef };
    if (!hit.r.manual && hit.key !== leadId) {
      const s = await db.collection('leads').doc(hit.key).get().catch(() => null);
      if (s && s.exists && s.data().tenantId === tenantId) target = { id: hit.key, ref: s.ref || db.collection('leads').doc(hit.key) };
    }
    const tpl = await templateInfo(db, tenantId, cand.template, tplCache);
    const purpose = hit.c.purpose || tpl.purpose;
    const visitTpl = /visit_(reminder|confirm)/.test(`${purpose} ${cand.template}`);
    const rd = readReply(cand.text, tpl.buttons, { purpose, template: cand.template, at: cand.at });
    const name = hit.c.name || hit.c.template;
    const text = clip(cand.text, REPLY_MAX);
    const a = ACTIONS[rd.action] || ACTIONS.other;
    let stageKey = null;
    if (rd.action === 'found') {
      if (!stageOf) stageOf = await stageKeys(db, tenantId);
      const s = target.id === leadId ? lead : ((await target.ref.get()).data() || {});
      stageKey = stageOf(s);
    }
    const note = rd.note || (a.note ? a.note(name, text, { subject: subjectOf(hit.r, hit.c), stageKey, when: rd.when }) : '');
    const reply = { text, action: rd.action, at: cand.at, ...(note ? { note } : {}), ...(rd.when ? { followUpAt: rd.when } : {}) };

    // Claimed on the campaign first, in a transaction: a webhook retry or the nightly replay that
    // races this one finds the message already there and does nothing.
    const fresh = await db.runTransaction(async t => {
      const s = await t.get(hit.ref);
      if (!s.exists) return false;
      const c = s.data();
      const r = c.recipients && c.recipients[hit.key];
      if (!r || (Array.isArray(r.replyKeys) && r.replyKeys.includes(cand.key))) return false;
      const up = {};
      const p = `recipients.${hit.key}.`;
      // A send recorded as failed, or never answered: the chat proves it arrived.
      const status = laterStatus(r.status, 'replied');
      up[p + 'status'] = status;
      if (r.status === 'failed' || r.status === 'sending') { up[p + 'uncertain'] = false; up[p + 'error'] = null; up[p + 'arrived'] = true; }
      up[p + 'replyKeys'] = [...(r.replyKeys || []), cand.key].slice(-20);
      // The newest answer is the one shown — but an "ok" after a real answer does not hide it.
      const keepOld = r.reply && (r.reply.at > cand.at || (rd.action === 'ack' && r.reply.action !== 'ack'));
      if (!keepOld) up[p + 'reply'] = reply;
      const recipients = { ...c.recipients, [hit.key]: { ...r, status } };
      up.counts = tally(recipients);
      up.lastReplyAt = Math.max(c.lastReplyAt || 0, cand.at);
      t.update(hit.ref, up);
      return true;
    });
    if (!fresh) { if (target.id === leadId) markSeen(entryKey(cand), cand.at); continue; }

    try {
      // The history and the do-not-message lists first, the lead last: the lead's write is what
      // marks the reply read (campaignReplySeen), so if anything before it fails the reply is
      // simply recorded again by the next webhook or the nightly sync.
      if (rd.action !== 'ack') {
        const id = historyId(hit.id, cand.key);
        await target.ref.collection('history').doc(id).set({
          id, type: 'campaign', at: cand.at, by: 'Campaign',
          text: `📣 Replied to <b>${escapeHtml(name)}</b>: “${escapeHtml(clip(text, 160))}” — ${escapeHtml(a.means)}`
        });
      }
      if (rd.action === 'optout' && hit.r.contact) await addOptOut(db, tenantId, hit.r.contact, now);
      if (rd.action === 'marketing_optout' && hit.r.contact) await addOptOut(db, tenantId, hit.r.contact, now, 'marketingOptOut');
      // Read right before it is written: a send recorded a moment ago keeps its entry.
      const cur = (await target.ref.get()).data();
      if (cur && cur.tenantId === tenantId) {
        const patch = leadPatch(cur, hit, reply, now, { visitTpl });
        if (target.id === leadId) { markSeen(entryKey(cand), cand.at); patch.campaignReplySeen = prunedSeen(seen, now); seenDirty = false; }
        await writeLead(db, tenantId, target.ref, patch, 'update', { mustSave: true });
        if (target.id === leadId) Object.assign(lead, patch);
      }
    } catch (e) {
      // The lead was not written: let the message go again so the next webhook or the nightly
      // sync records it, rather than leaving it counted on the campaign and missing on the lead.
      await hit.ref.get().then(s => {
        const r = s.exists && s.data().recipients && s.data().recipients[hit.key];
        if (r && Array.isArray(r.replyKeys)) return hit.ref.update({ [`recipients.${hit.key}.replyKeys`]: r.replyKeys.filter(k => k !== cand.key) });
        return null;
      }).catch(() => {});
      throw e;
    }
    applied.push({ campaignId: hit.id, recipient: hit.key, lead: target.id, action: rd.action, text });
  }
  // Entries read but nothing to write on this lead (another campaign's template, a reply already
  // recorded): remembered, so the next webhook does not read them again.
  if (seenDirty) {
    const s = await leadRef.get();
    if (s.exists && s.data().tenantId === tenantId) {
      const merged = prunedSeen({ ...(s.data().campaignReplySeen || {}), ...seen }, now);
      await writeLead(db, tenantId, leadRef, { campaignReplySeen: merged }, 'update', { mustSave: true });
    }
  }
  return { ok: true, applied };
}

// The CRM stage key of a lead (crm-assets/pipeline.js), from the tenant's pipeline.
async function stageKeys(db, tenantId) {
  const snap = await db.collection('pipelines').doc(tenantId).get().catch(() => null);
  const stages = snap && snap.exists ? (snap.data().stages || []) : [];
  const byId = new Map(stages.map(s => [s.id, stageKeyOf(s)]));
  return l => (l && l.stageId ? byId.get(l.stageId) || (['negotiation', 'won'].includes(l.stageId) ? l.stageId : null) : null);
}

// What a reply writes on the lead. No updatedAt / updatedBy — the reply stays open for a person.
export function leadPatch(lead, hit, reply, now, { visitTpl = false } = {}) {
  const { c, id, r } = hit;
  const name = c.name || c.template;
  const patch = {};
  const a = ACTIONS[reply.action] || ACTIONS.other;
  const ack = reply.action === 'ack';
  const note = reply.note || (a.note ? a.note(name, reply.text, { subject: subjectOf(r, c), when: reply.followUpAt }) : '');
  const prev = lead.campaignReply;
  // An acknowledgement needs nobody, so it is never the lead's open campaign reply.
  if (!ack && (!prev || !(prev.at > reply.at))) {
    // With the property it was about, when known: the page names it ("not interested in ANR003").
    const v = (r && r.values) || {};
    const code = String(v.property_code || v.code || '').slice(0, 40);
    const property = String(v.property_name || v.property || '').slice(0, 120);
    patch.campaignReply = { campaignId: id, campaignName: name, template: c.template, text: reply.text, action: reply.action, at: reply.at,
      ...(note ? { note } : {}), ...(reply.followUpAt ? { followUpAt: reply.followUpAt } : {}),
      ...(code ? { code } : {}), ...(property ? { property } : {}), ...(c.propertyId ? { propertyId: c.propertyId } : {}) };
  }
  // Merged into the entry the send wrote; a campaign sent before the log existed gets one now.
  const logged = Array.isArray(lead.campaignLog) ? lead.campaignLog.find(e => e && e.id === id) : null;
  const keepReply = ack && logged && logged.reply && logged.action && logged.action !== 'ack';
  patch.campaignLog = withCampaignLog(lead.campaignLog, {
    id, name, template: c.template, ...(logged ? {} : { at: r.sentAt || reply.at }), status: 'replied',
    ...(keepReply ? {} : { reply: reply.text, replyAt: reply.at, action: reply.action })
  });
  // Any real answer means the offers are not going unanswered.
  if (!ack && (lead.marketingUnanswered || 0) > 0) patch.marketingUnanswered = 0;
  if (ack) {
    if (visitTpl) patch.siteVisitConfirmedAt = reply.at;
    return patch;
  }
  if (reply.action === 'optout') {
    if (!lead.waOptOut) Object.assign(patch, { waOptOut: true, waOptOutAt: reply.at, waOptOutReason: 'replied stop' });
    return patch;
  }
  if (reply.action === 'marketing_optout') {
    if (!lead.waMarketingOptOut) Object.assign(patch, { waMarketingOptOut: true, waMarketingOptOutAt: reply.at, waMarketingOptOutReason: 'replied stop offers' });
    return patch;
  }
  if (a.none) return patch;
  // A follow-up only ever comes sooner: one already set for earlier (by a person or anyone) stays.
  const due = reply.followUpAt || (reply.at + (a.afterMs || 0));
  if (!lead.followUpAt || lead.followUpAt > due) {
    Object.assign(patch, { followUpAt: due, followUpNote: note || a.note(name, reply.text, {}), followUpSetAt: now, followUpBy: 'campaign' });
  }
  return patch;
}

/**
 * A number on one of the tenant's do-not-message lists (settings.optOut, or marketingOptOut for
 * offers only), so a hand-typed contact list or a second lead on the same number is held back too.
 */
export async function addOptOut(db, tenantId, number, now, field = 'optOut') {
  const ref = db.collection('campaignSettings').doc(tenantId);
  await db.runTransaction(async t => {
    const s = await t.get(ref);
    const list = s.exists && Array.isArray(s.data()[field]) ? s.data()[field] : [];
    if (list.includes(number)) return;
    t.set(ref, { tenantId, [field]: [...list, number].slice(-5000), updatedAt: now }, { merge: true });
  });
}

// ─── template status alerts ─────────────────────────────────────────────

const API = 'https://api.tailortalk.ai/api/v1/';
const DIGEST_FETCH_MS = 10000;

/**
 * TailorTalk's live template statuses against the last ones seen (campaignTemplates.lastStatus).
 * Reads only: what changed, and commit() to record the new statuses — called once the digest
 * that reports them has gone out, so a digest that failed (or a manual "Send now") never uses up
 * the news. A template seen for the first time is only recorded — unless it was submitted from the
 * CRM, when its first status is news.
 * @returns {{ changes: Array<{ name, from, to }>, commit: () => Promise<void> }}
 */
export async function templateStatusChanges(db, tenantId, token, { fetch: f = globalThis.fetch, now = Date.now() } = {}) {
  if (!token) return { changes: [], commit: async () => {} };
  const body = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TailorTalk did not answer')), DIGEST_FETCH_MS + 100);
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(DIGEST_FETCH_MS) : undefined;
    Promise.resolve(f(API + 'get_whatsapp_templates', { headers: { Authorization: 'Agent ' + token }, signal }))
      .then(async res => { if (!res.ok) throw new Error('TailorTalk ' + res.status); return JSON.parse(await res.text()); })
      .then(resolve, reject).finally(() => clearTimeout(timer));
  });
  if (body && body.success === false) throw new Error(String(body.detail || body.message || 'TailorTalk refused'));
  const data = body && body.data && typeof body.data === 'object' ? body.data : body;
  const live = Array.isArray(data && data.templates) ? data.templates : [];
  const known = await db.collection('campaignTemplates').where('tenantId', '==', tenantId).get();
  const mine = new Map(known.docs.map(d => [d.data().name, d.data()]));
  const changes = [];
  const writes = [];
  for (const t of live) {
    const name = String(t.template_name || t.name || '');
    const to = String(t.template_status || t.status || '').toUpperCase();
    if (!validTemplateName(name) || !to) continue;
    const m = mine.get(name) || {};
    const from = m.lastStatus || (m.submittedAt ? 'SUBMITTED' : null);
    if (m.lastStatus === to) continue;
    writes.push({ name, to });
    if (from && from !== to) changes.push({ name, from, to });
  }
  const commit = async () => {
    for (const w of writes) await db.collection('campaignTemplates').doc(tenantId + '__' + w.name).set({ tenantId, name: w.name, lastStatus: w.to, lastStatusAt: now }, { merge: true });
  };
  return { changes, commit };
}

// ─── the morning digest's section ───────────────────────────────────────

const istMidnight = ms => Math.floor((ms + IST_OFFSET_MS) / DAY) * DAY - IST_OFFSET_MS;
// Replies that need nobody: a stop is acted on by the server itself.
const NEEDS_NOBODY = new Set(['optout', 'marketing_optout', 'ack']);

/** A campaign reply still waiting for a person, by the CRM's rule (leadAttention.js openCampaignReply). */
export function openReply(lead) {
  const r = lead && lead.campaignReply;
  if (!r || !r.at) return null;
  return r.at > Math.max(lead.updatedAt || 0, (lead.tt && lead.tt.attentionFrom) || 0) ? r : null;
}

/**
 * What the digest says about campaigns: yesterday's (IST) sends, replies still waiting for a person
 * (an opt-out needs nobody), and template status changes (skipped quietly without a token).
 * The section's commit() records the template statuses it reported — call it only once the
 * digest has actually gone out.
 * @param {object} o { leads: [lead…] (already read by the digest), now, token, fetch }
 */
export async function campaignDigest(db, tenantId, { leads = [], now = Date.now(), token = null, fetch: f } = {}) {
  const today = istMidnight(now), yesterday = today - DAY;
  const snap = await db.collection('campaigns').where('tenantId', '==', tenantId).get();
  const campaigns = [];
  for (const d of snap.docs) {
    const c = d.data();
    if (c.mode === 'csv') continue;
    const sentYesterday = Object.values(c.recipients || {}).some(r => r && r.sentAt >= yesterday && r.sentAt < today);
    if (!sentYesterday) continue;
    const n = tally(c.recipients);
    campaigns.push({ id: d.id, name: c.name || c.template, sent: n.sent, read: n.read, replied: n.replied, failed: n.failed, createdAt: c.createdAt || 0 });
  }
  campaigns.sort((a, b) => b.createdAt - a.createdAt);
  const waiting = leads.map(l => ({ lead: l, reply: openReply(l) }))
    .filter(x => x.reply && !NEEDS_NOBODY.has(x.reply.action))
    .sort((a, b) => b.reply.at - a.reply.at);
  let templates = [];
  let commit = async () => {};
  if (token) {
    try { const r = await templateStatusChanges(db, tenantId, token, { fetch: f, now }); templates = r.changes; commit = r.commit; }
    catch (e) { console.error('campaign digest: template statuses unread:', e.message); }
  }
  return { campaigns, waiting, templates, empty: !campaigns.length && !waiting.length && !templates.length, commit };
}

const DIGEST_LIMIT = 30;
const STATUS_WORD = { APPROVED: 'approved', REJECTED: 'rejected', PAUSED: 'paused', PENDING: 'pending', DISABLED: 'disabled', SUBMITTED: 'submitted' };
const word = s => STATUS_WORD[s] || String(s || '').toLowerCase();
const counts = c => `${c.sent} sent · ${c.read} read · ${c.replied} replied${c.failed ? ` · ${c.failed} failed` : ''}`;
const waitingLine = ({ lead, reply }) => `${lead.name || 'Lead'} — “${clip(reply.text, 80)}” — ${reply.campaignName || reply.template || 'a campaign'} (${(ACTIONS[reply.action] || ACTIONS.other).means.toLowerCase()})`;
const templateLine = t => `${t.name}: ${word(t.to)} (was ${word(t.from)})`;

/** The section as plain-text lines (email text part), or [] when there is nothing to say. */
export function campaignDigestText(sec, bullet = '-') {
  if (!sec || sec.empty) return [];
  const lines = [];
  if (sec.campaigns.length) {
    lines.push('Sent yesterday:');
    sec.campaigns.forEach(c => lines.push(`${bullet} ${c.name}: ${counts(c)}`));
  }
  if (sec.waiting.length) {
    lines.push(`Replies waiting for a person (${sec.waiting.length}):`);
    sec.waiting.slice(0, DIGEST_LIMIT).forEach(w => lines.push(`${bullet} ${waitingLine(w)}`));
    if (sec.waiting.length > DIGEST_LIMIT) lines.push(`${bullet} …and ${sec.waiting.length - DIGEST_LIMIT} more in the CRM`);
  }
  if (sec.templates.length) {
    lines.push('Template changes:');
    sec.templates.forEach(t => lines.push(`${bullet} ${templateLine(t)}`));
  }
  return lines;
}

/** The section in the digest email's HTML, or '' when there is nothing to say. */
export function campaignDigestHtml(sec) {
  if (!sec || sec.empty) return '';
  const td = 'padding:6px 10px;border-bottom:1px solid #eee;';
  const table = rows => `<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;table-layout:fixed;">${rows}</table>`;
  const sub = s => `<div style="font-family:sans-serif;color:#888;font-size:11px;text-transform:uppercase;margin:10px 0 4px;">${s}</div>`;
  let body = '';
  if (sec.campaigns.length) {
    body += sub('Sent yesterday') + table(sec.campaigns.map(c => `<tr><td style="${td}font-weight:600;">${escapeHtml(c.name)}</td><td style="${td}">${escapeHtml(counts(c))}</td></tr>`).join(''));
  }
  if (sec.waiting.length) {
    body += sub(`Replies waiting for a person (${sec.waiting.length})`) + table(sec.waiting.slice(0, DIGEST_LIMIT).map(({ lead, reply }) => `<tr>
      <td style="${td}font-weight:600;width:22%;">${escapeHtml(lead.name || 'Lead')}</td>
      <td style="${td}">“${escapeHtml(clip(reply.text, 120))}”<div style="color:#888;font-size:12px;">${escapeHtml((ACTIONS[reply.action] || ACTIONS.other).means)} · ${escapeHtml(reply.campaignName || reply.template || 'a campaign')}</div></td>
      <td style="${td}width:17%;">${escapeHtml(lead.phone || '—')}</td></tr>`).join(''));
    if (sec.waiting.length > DIGEST_LIMIT) body += `<p style="font-family:sans-serif;color:#888;font-size:12px;">…and ${sec.waiting.length - DIGEST_LIMIT} more in the CRM.</p>`;
  }
  if (sec.templates.length) {
    const color = s => (s === 'APPROVED' ? '#15803D' : s === 'REJECTED' || s === 'PAUSED' || s === 'DISABLED' ? '#B91C1C' : '#B45309');
    body += sub('Template changes') + table(sec.templates.map(t => `<tr><td style="${td}font-weight:600;">${escapeHtml(t.name)}</td><td style="${td}color:${color(t.to)};">${escapeHtml(word(t.to))} <span style="color:#888;">(was ${escapeHtml(word(t.from))})</span></td></tr>`).join(''));
  }
  return `
    <h3 style="color:#0F766E;margin:18px 0 8px;font-family:sans-serif;">📣 WhatsApp campaigns</h3>${body}`;
}
