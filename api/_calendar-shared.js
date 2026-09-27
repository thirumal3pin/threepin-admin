// ═══════ THE TEAM'S GOOGLE CALENDARS ═══════
//
// threepin.in is a Google Workspace domain, which is what makes this simple.
// The service account this project already uses for Firestore can be granted
// permission, once, to act on behalf of people in the domain — so no agent
// links anything, no OAuth consent is clicked, no refresh tokens are stored or
// re-minted, and nothing breaks when somebody changes their password. The two
// console steps that turn it on are in scripts/check-calendar-access.mjs, which
// also says which of them is missing.
//
// ═══════ WRITING TO A REAL PERSON'S DIARY ═══════
//
// Reading is harmless. Writing is not: a bug here is a bug in somebody's day.
// So every event this file creates is STAMPED —
//
//     extendedProperties.private['3pin.lead'] = <leadId>
//
// — and every update and delete refuses to touch an event without that stamp.
// The CRM can therefore only ever edit the events it made itself. An agent's
// own entries, and anything their colleagues put in their calendar, are
// unreachable from here no matter what the caller asks for.

import { JWT } from 'google-auth-library';

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 3600000;
const STAMP = '3pin.lead';
const sameEmail = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/**
 * The guest list for a PATCH, with everyone's answer carried across.
 *
 * Google is sent the whole list every time, and an entry that omits
 * responseStatus is an entry with no answer on it. So an edit that changes
 * nothing about WHEN would otherwise wipe what everybody had already said.
 *
 * When the time HAS moved, the opposite is wanted: a yes to Tuesday at eleven
 * is not a yes to Saturday at four, so everybody is asked again. Somebody
 * newly invited starts unanswered either way.
 */
function keepAnswers(next, current, moved) {
  const was = new Map((current || []).map(a => [String(a.email || '').toLowerCase(), a]));
  return (next || []).map(a => {
    if (moved) return { ...a, responseStatus: 'needsAction' };
    const before = was.get(String(a.email || '').toLowerCase());
    return before
      ? { ...a, responseStatus: before.responseStatus || 'needsAction', comment: before.comment || undefined }
      : { ...a, responseStatus: 'needsAction' };
  });
}
const MEET_STAMP = '3pin.meeting';

// A Workspace that has not been set up yet must fail as "not configured",
// never as a stack trace in the middle of the CRM.
export class CalendarNotReady extends Error {
  constructor(message, hint) { super(message); this.name = 'CalendarNotReady'; this.hint = hint || null; }
}

// The same service account the rest of the API already runs on, from the same
// env var (FIREBASE_SERVICE_ACCOUNT_JSON, see _bot-shared.js). Nothing new to
// set on Vercel: the only thing that changes is what Google lets this identity
// do, and that is granted in the Workspace admin console rather than here.
function serviceKey() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Acting AS a person, which is what domain-wide delegation buys. Each subject
// needs its own client: the token is minted for that one mailbox.
//
// KEPT, not rebuilt. A JWT holds its access token for an hour, and a new one
// has to buy a fresh token from Google before it can ask anything — about
// 200ms, paid per person, before the calendar call even starts. Reading six
// calendars was doing that six times: measured at 1,169ms rebuilt against
// 496ms reused, so well over half the wait was spent proving who we are.
//
// Serverless instances are reused between requests, so on a warm one this is
// free after the first read. Capped because a Map that only grows is a leak,
// though at six mailboxes that is theory rather than practice.
const clients = new Map();
const MAX_CLIENTS = 64;
function realClient(subject, key) {
  const id = subject + '|' + key.client_email;
  let c = clients.get(id);
  if (!c) {
    if (clients.size >= MAX_CLIENTS) clients.clear();
    c = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE], subject });
    clients.set(id, c);
  }
  return c;
}

// Injectable, and not only for convenience: the guard below is the one piece
// of this file that must never regress, and a rule about what the CRM REFUSES
// to touch can only be proved against a transport that records what was asked.

function explain(e) {
  const d = (e && e.response && e.response.data) || {};
  const err = String(d.error && (d.error.message || d.error) || d.error_description || e.message || e);
  if (/unauthorized_client/i.test(err)) {
    return new CalendarNotReady('Google has not been told this CRM may read the team calendars',
      'Add client id 118007570407573886710 with scope .../auth/calendar under Domain Wide Delegation in the Workspace admin console.');
  }
  if (/has not been used|SERVICE_DISABLED|is disabled/i.test(err)) {
    return new CalendarNotReady('The Google Calendar API is switched off for this project',
      'Enable "Google Calendar API" on the pin-realty project in the Google Cloud console.');
  }
  if (/invalid_grant/i.test(err)) {
    return new CalendarNotReady('Google accepted the CRM but not that mailbox',
      'The address must be a real active account in the Workspace — an alias or a closed account fails here.');
  }
  return e;
}

// ── Reading ────────────────────────────────────────────────────────────────

/**
 * One person's events between two instants.
 * Returns [] rather than throwing when that single calendar is unreadable, so
 * one closed mailbox cannot blank the whole team's day.
 */
async function eventsFor(subject, fromIso, toIso, key, make) {
  const url = `${CAL}/calendars/${encodeURIComponent(subject)}/events`
    + `?timeMin=${encodeURIComponent(fromIso)}&timeMax=${encodeURIComponent(toIso)}`
    + `&singleEvents=true&orderBy=startTime&maxResults=100&timeZone=${encodeURIComponent(TZ)}`
    // Days off and working-location markers are separate event types and do not
    // arrive unless they are asked for by name.
    + '&eventTypes=default&eventTypes=outOfOffice&eventTypes=workingLocation&eventTypes=focusTime';
  const r = await make(subject, key).request({ url });
  return (r.data.items || [])
    // A declined invitation is not a commitment, and showing it as one is how
    // a calendar starts lying about who is free.
    .filter(e => !(e.attendees || []).some(a => a.self && a.responseStatus === 'declined'))
    .map(e => ({
      id: e.id,
      title: e.summary || '(no title)',
      start: e.start && (e.start.dateTime || e.start.date) || null,
      end: e.end && (e.end.dateTime || e.end.date) || null,
      allDay: !!(e.start && e.start.date && !e.start.dateTime),
      where: e.location || null,
      about: e.description || null,
      // "busy" is the honest signal for status: an event marked free (a
      // reminder, a birthday) must not make somebody look unavailable.
      busy: e.transparency !== 'transparent',
      status: e.status || 'confirmed',
      // Google distinguishes a meeting from a day off and from "working from
      // home today". Treating all three as one grey block is how somebody gets
      // a site visit booked on their leave — and worse, Google can be set to
      // auto-decline conflicting invitations during out-of-office, so that
      // booking comes back as a refusal the agent never made.
      kind: e.eventType || 'default',
      away: e.eventType === 'outOfOffice',
      whereWorking: e.eventType === 'workingLocation'
        ? ((e.workingLocationProperties || {}).type === 'homeOffice' ? 'working from home'
          : ((e.workingLocationProperties || {}).officeLocation || {}).label
            || ((e.workingLocationProperties || {}).customLocation || {}).label || 'in the office')
        : null,
      leadId: (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private[STAMP]) || null,
      meetingId: (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private[MEET_STAMP]) || null,
      organiser: (e.organizer && e.organizer.email) || null,
      // Who else is in the room, so the grid can show one meeting once rather
      // than as five unexplained blocks that happen to line up.
      attendees: (e.attendees || []).map(a => ({ email: a.email, status: a.responseStatus || 'needsAction' })),
      meet: e.hangoutLink || null,
      link: e.htmlLink || null
    }));
}

/** Every listed person's events in one window. One slow calendar does not hold up the rest. */
export async function teamCalendar(people, from, to, { key = serviceKey(), makeClient = realClient } = {}) {
  if (!key) throw new CalendarNotReady('No Google service account is configured on this deployment');
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const out = await Promise.all((people || []).map(async person => {
    try {
      return { person, events: await eventsFor(person, fromIso, toIso, key, makeClient) };
    } catch (e) {
      const known = explain(e);
      // A whole-domain problem is worth surfacing once, loudly, rather than as
      // five identical per-person footnotes.
      if (known instanceof CalendarNotReady) throw known;
      return { person, events: [], error: String((e && e.message) || e).slice(0, 160) };
    }
  }));
  return out;
}

// ── Writing: only ever our own events ──────────────────────────────────────

function visitEventBody(lead, visit, agents, property, crmBase) {
  const end = visit.at + (visit.minutes || 60) * 60000;
  const code = visit.property ? ` \u00b7 ${visit.property}` : '';
  // Not every viewing needs somebody to drive to it. Some are handled entirely
  // on the phone \u2014 the agent rings the seller, rings the client, and puts the
  // two together. An agent glancing at a phone screen has to know which kind
  // this is before they decide whether to set off, so it goes in the TITLE and
  // not in a field three lines down that nobody opens in the car.
  const remote = visit.mode === 'remote';
  const lead_line = `Client: ${lead.name || 'Lead'}${lead.phone ? ' \u00b7 ' + lead.phone : ''}`;
  const lines = [
    remote ? 'BY PHONE \u2014 no travel. Call the seller and the client and put the visit together.' : null,
    remote ? '' : null,
    lead_line,
    lead.propertyInterest ? `Looking for: ${lead.propertyInterest}` : null,
    lead.budget ? `Budget: ${lead.budget}` : null,
    property && (property.contactName || property.contactNumber)
      ? `Seller: ${property.contactName || '\u2014'}${property.contactNumber ? ' \u00b7 ' + property.contactNumber : ''}` : null,
    property && property.location ? `${remote ? 'Property' : 'Where'}: ${property.location}` : null,
    visit.notes ? `\nNotes from the office:\n${visit.notes}` : null,
    '',
    'Booked in the 3 PIN CRM. Accept or decline here or in the CRM \u2014 either way both agree.'
  ].filter(x => x !== null);
  return {
    summary: `${remote ? 'Coordinate (call only)' : 'Site visit'}: ${lead.name || 'Lead'}${code}`,
    description: lines.join('\n'),
    // A phone job must not put an address in the agent's calendar: the map
    // link is an instruction to drive somewhere they are not going.
    location: remote ? undefined : ((property && property.location) || visit.property || undefined),
    start: { dateTime: new Date(visit.at).toISOString(), timeZone: TZ },
    end: { dateTime: new Date(end).toISOString(), timeZone: TZ },
    // The agents are GUESTS, not owners. That is what turns this from an entry
    // appearing in somebody's diary into an invitation they can answer, which
    // is the difference between assuming a visit is covered and knowing it.
    attendees: (agents || []).map(email => ({ email })),
    extendedProperties: { private: { [STAMP]: lead.id } },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: remote ? 15 : 60 }] },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    // One tap from the calendar entry to the lead it belongs to. An agent
    // standing outside a building wants the history, not to go and search for
    // the name in the CRM.
    source: crmBase ? { title: 'Open this lead in the 3 PIN CRM', url: `${crmBase}/crm.html?lead=${encodeURIComponent(lead.id)}` } : undefined,
    // The entry carries the client's number AND the seller's. Private keeps the
    // detail to the people actually going, rather than to anybody in the domain
    // who can see the agent's calendar.
    visibility: 'private',
    // 3 PIN's own bookings stand out in the agent's own calendar app.
    colorId: remote ? '5' : '6'
  };
}

async function stampedEvent(subject, eventId, leadId, key, make) {
  try {
    const r = await make(subject, key).request({ url: `${CAL}/calendars/${encodeURIComponent(subject)}/events/${encodeURIComponent(eventId)}` });
    const stamp = r.data.extendedProperties && r.data.extendedProperties.private && r.data.extendedProperties.private[STAMP];
    return stamp === leadId ? r.data : null;
  } catch { return null; }
}

/**
 * Puts this lead's site visit in the diary as an invitation to the agents who
 * are going, moves it when it moves, and calls it off when it is cancelled.
 *
 * `subject` is the ORGANISER \u2014 whoever booked it. The agents are attendees, so
 * they get the ordinary Google invitation, answer it from whatever calendar
 * app they use, and their answer comes back on the event for the CRM to show.
 *
 * Returns { eventId, owner, agents } to store on the lead. Never touches an
 * event it did not create.
 */
export async function syncVisitEvent({ lead, visit, subject, agents = [], property = null,
  crmBase = process.env.CRM_BASE_URL || 'https://admin.threepin.in',
  previous = {}, key = serviceKey(), makeClient = realClient }) {
  if (!key) throw new CalendarNotReady('No Google service account is configured on this deployment');
  const wanted = !!(subject && visit && visit.at && visit.status !== 'cancelled');

  // Moved to somebody else's calendar, or no longer wanted: clear the old one
  // first, so a rescheduled visit never leaves a ghost in the wrong diary, and
  // everybody who was invited is told it is off.
  if (previous.eventId && (!wanted || previous.owner !== subject)) {
    const mine = await stampedEvent(previous.owner, previous.eventId, lead.id, key, makeClient);
    if (mine) {
      await makeClient(previous.owner, key)
        .request({ url: `${CAL}/calendars/${encodeURIComponent(previous.owner)}/events/${encodeURIComponent(previous.eventId)}?sendUpdates=all`, method: 'DELETE' })
        .catch(() => {});
    }
    previous = {};
  }
  if (!wanted) return { eventId: null, owner: null, agents: [] };

  const body = visitEventBody(lead, visit, agents, property, crmBase);
  // Without this Google files the change quietly and an agent turns up at the
  // old time, or does not turn up at all.
  const q = '?sendUpdates=all';
  try {
    if (previous.eventId && previous.owner === subject) {
      const mine = await stampedEvent(subject, previous.eventId, lead.id, key, makeClient);
      if (mine) {
        // Same rule as a meeting: a visit that moves has to be agreed again.
        // An agent who said yes to Tuesday morning has not agreed to Saturday.
        const wasAt = mine.start && mine.start.dateTime ? Date.parse(mine.start.dateTime) : null;
        const moved = wasAt !== null && wasAt !== visit.at;
        await makeClient(subject, key).request({
          url: `${CAL}/calendars/${encodeURIComponent(subject)}/events/${encodeURIComponent(previous.eventId)}${q}`,
          method: 'PATCH',
          data: { ...body, attendees: keepAnswers(body.attendees, mine.attendees, moved) }
        });
        return { eventId: previous.eventId, owner: subject, agents: agents, reAsked: moved };
      }
      // The stamp is gone: somebody deleted it in Google. Make a fresh one
      // rather than resurrecting an event a person chose to remove \u2014 and only
      // because the CRM still holds a live visit for this lead.
    }
    const r = await makeClient(subject, key).request({
      url: `${CAL}/calendars/${encodeURIComponent(subject)}/events${q}`, method: 'POST', data: body
    });
    return { eventId: r.data.id, owner: subject, agents: agents };
  } catch (e) {
    throw explain(e);
  }
}

/**
 * How the agents answered an invitation the CRM sent.
 * Read as the organiser, because it is their event that carries the replies.
 */
export async function visitReplies({ organiser, eventId, key = serviceKey(), makeClient = realClient }) {
  if (!key || !organiser || !eventId) return [];
  try {
    const r = await makeClient(organiser, key).request({
      url: `${CAL}/calendars/${encodeURIComponent(organiser)}/events/${encodeURIComponent(eventId)}` });
    // `comment` is Google's own field for "why" \u2014 the same one the CRM writes
    // when an agent declines with a reason, so an answer given in Gmail and an
    // answer given in the CRM come back through one channel.
    return (r.data.attendees || []).map(a => ({
      email: a.email, status: a.responseStatus || 'needsAction', reason: a.comment || null }));
  } catch { return []; }
}

/**
 * Whose calendar a visit belongs in.
 *
 * There is no "lead owner" field in this CRM, so this reads who actually did
 * the work: the person who set the visit, then whoever last touched the lead,
 * and finally the shared inbox — because an unowned visit that lands nowhere
 * is worse than one that lands on the team's shared calendar.
 */
export function visitOwnerFor(lead, visit, team) {
  const known = new Set((team || []).map(e => String(e).toLowerCase()));
  const pick = v => (v && known.has(String(v).toLowerCase())) ? String(v).toLowerCase() : null;
  return pick(visit && visit.by) || pick(lead.siteVisitBy) || pick(lead.updatedBy) || pick(lead.followUpBy)
    || (team || []).find(e => /^sales@/i.test(e)) || (team || [])[0] || null;
}

// ── Meetings among the team ────────────────────────────────────────────────
//
// The same privilege, pointed at the team rather than at a client: one person
// books, Google invites everybody, and it lands on each attendee's calendar
// with a Meet link if they asked for one. That is what makes this feel like
// Teams rather than like a shared spreadsheet of times.
//
// It is created on the ORGANISER's calendar, acting as them, so it behaves
// exactly like a meeting they booked themselves: their name on the invitation,
// their calendar it belongs to, and their right to change it. Attendees get a
// normal Google invitation they can accept or decline.
//
// Stamped like everything else, so the CRM can move or cancel the meetings it
// made and nothing else.

// Google states repetition as an RRULE. Only the handful a brokerage actually
// uses are offered: the weekly review, the daily morning call, the Monday-to-
// Saturday standup. Anything more elaborate is a thing somebody sets up once
// in Google and the grid shows like any other event.
//
// The day names come from the meeting's OWN date in IST, not from the server's
// idea of today — a Monday review booked from a machine on UTC would otherwise
// repeat on Sundays.
const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export function recurrenceRule(repeat, at) {
  if (!repeat || repeat === 'none') return null;
  const ist = new Date(at + IST_OFFSET_MS);
  const day = ICS_DAYS[ist.getUTCDay()];
  if (repeat === 'daily') return ['RRULE:FREQ=DAILY'];
  if (repeat === 'weekly') return [`RRULE:FREQ=WEEKLY;BYDAY=${day}`];
  // Brokers work Saturdays; Sunday is the day off, so "every working day" is
  // Monday to Saturday here and not the Monday-to-Friday every calendar app
  // assumes.
  if (repeat === 'workdays') return ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA'];
  if (repeat === 'monthly') return [`RRULE:FREQ=MONTHLY;BYMONTHDAY=${ist.getUTCDate()}`];
  return null;
}

/**
 * Creates, moves or cancels a meeting among the team.
 *
 * @param {object}   o
 * @param {string}   o.organiser  who is booking it (must be in the Workspace)
 * @param {string[]} o.attendees  the others invited
 * @param {string}   o.title
 * @param {number}   o.at         start, ms
 * @param {number}   o.minutes    how long
 * @param {string}   [o.about]    agenda
 * @param {string}   [o.where]    a room, or an address
 * @param {boolean}  [o.meet]     attach a Google Meet link
 * @param {string}   [o.repeat]   none | daily | workdays | weekly | monthly
 * @param {string}   [o.eventId]  an existing meeting to move, rather than a new one
 * @param {boolean}  [o.cancel]   call it off and tell everyone
 */
export async function syncTeamMeeting({ organiser, attendees = [], title, at, minutes = 30, about, where,
  meet = false, repeat = 'none', eventId = null, cancel = false, key = serviceKey(), makeClient = realClient }) {
  if (!key) throw new CalendarNotReady('No Google service account is configured on this deployment');
  if (!organiser) throw new Error('A meeting needs somebody to book it');

  const client = makeClient(organiser, key);
  const base = `${CAL}/calendars/${encodeURIComponent(organiser)}/events`;

  if (cancel) {
    if (!eventId) return { eventId: null };
    // Same rule as a site visit: we only cancel what we booked. A meeting
    // somebody set up in Google themselves is not ours to call off.
    const mine = await stampedMeeting(organiser, eventId, key, makeClient);
    if (!mine) return { eventId, skipped: 'not a meeting this CRM created' };
    // sendUpdates=all so nobody turns up to a meeting that is not happening.
    await client.request({ url: `${base}/${encodeURIComponent(eventId)}?sendUpdates=all`, method: 'DELETE' }).catch(() => {});
    return { eventId: null, cancelled: true };
  }

  if (!title || !at) throw new Error('A meeting needs a title and a time');
  const body = {
    summary: title,
    description: about || undefined,
    location: where || undefined,
    start: { dateTime: new Date(at).toISOString(), timeZone: TZ },
    end: { dateTime: new Date(at + Math.max(5, minutes) * 60000).toISOString(), timeZone: TZ },
    attendees: attendees.filter(a => a && a !== organiser).map(email => ({ email })),
    extendedProperties: { private: { [MEET_STAMP]: '1' } },
    // The person who booked it moves it. A guest who could move the meeting
    // could move it out from under the person who called it.
    guestsCanModify: false
  };
  // Cancelling or moving a repeating meeting acts on the whole series, which
  // is what somebody pressing "call it off" on a weekly review means.
  const rule = recurrenceRule(repeat, at);
  if (rule) body.recurrence = rule;
  // A Meet link has to be ASKED for, with a request id Google uses to
  // de-duplicate retries — so the same booking pressed twice gets one link.
  if (meet && !eventId) {
    body.conferenceData = { createRequest: { requestId: `3pin-${at}-${Math.random().toString(36).slice(2, 10)}`,
      conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  const q = `?sendUpdates=all&conferenceDataVersion=1`;

  try {
    if (eventId) {
      const mine = await stampedMeeting(organiser, eventId, key, makeClient);
      if (!mine) return { eventId, skipped: 'not a meeting this CRM created' };
      // A yes to Tuesday at eleven is not a yes to Saturday at four. When the
      // TIME moves, everybody is asked again; when only the title or the place
      // changes, their answer still stands and re-asking would be noise.
      //
      // Set explicitly rather than left to Google's default, because what that
      // default is is not something worth being wrong about twice.
      const wasAt = mine.start && mine.start.dateTime ? Date.parse(mine.start.dateTime) : null;
      const moved = wasAt !== null && wasAt !== at;
      // The guest list is sent whole on every PATCH, and a bare {email} entry
      // has no responseStatus — so without this, correcting a typo in the title
      // wiped everybody's answer and the meeting looked unanswered by a team
      // that had all said yes.
      body.attendees = keepAnswers(body.attendees, mine.attendees, moved);
      const r = await client.request({ url: `${base}/${encodeURIComponent(eventId)}${q}`, method: 'PATCH', data: body });
      return { eventId: r.data.id, meet: r.data.hangoutLink || null, link: r.data.htmlLink || null };
    }
    const r = await client.request({ url: `${base}${q}`, method: 'POST', data: body });
    return { eventId: r.data.id, meet: r.data.hangoutLink || null, link: r.data.htmlLink || null };
  } catch (e) {
    throw explain(e);
  }
}

async function stampedMeeting(subject, eventId, key, make) {
  try {
    const r = await make(subject, key).request({ url: `${CAL}/calendars/${encodeURIComponent(subject)}/events/${encodeURIComponent(eventId)}` });
    const p = (r.data.extendedProperties && r.data.extendedProperties.private) || {};
    return p[MEET_STAMP] ? r.data : null;
  } catch { return null; }
}

/**
 * When everybody is free, given what teamCalendar() returned.
 *
 * Booking a meeting by guessing and then reading five refusals is how people
 * give up on a scheduler, so the picker offers the times that actually work.
 * Only events marked busy count: a birthday should not block a Tuesday.
 */
export function freeSlots(day, { from, to, minutes = 30, step = 30 } = {}) {
  const busy = [];
  for (const person of day || []) {
    for (const e of person.events || []) {
      if (!e.busy || e.allDay || !e.start || !e.end) continue;
      busy.push([Date.parse(e.start), Date.parse(e.end)]);
    }
  }
  const out = [];
  const span = minutes * 60000;
  for (let t = from; t + span <= to; t += step * 60000) {
    if (!busy.some(([s, e]) => t < e && t + span > s)) out.push(t);
  }
  return out;
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550 ANSWERING FROM INSIDE THE CRM \u2550\u2550\u2550\u2550\u2550\u2550\u2550
//
// An agent can answer the invitation in Gmail, on their phone, or on the lead
// in the CRM, and all three are the same act: this writes the response onto
// the SAME Google event everyone else reads, acting as that agent. There is no
// second copy of the answer to drift out of step, because there is no second
// copy of the answer.
//
// The reason goes in Google's own `comment` field on the attendee, so it comes
// back through exactly the channel a reason typed into Gmail would.


export async function respondToEvent({ agent, eventId, response, reason = '', leadId = null,
  key = serviceKey(), makeClient = realClient }) {
  if (!key) throw new CalendarNotReady('No Google service account is configured on this deployment');
  if (!agent || !eventId) throw new Error('Who is answering, and to what?');
  if (!['accepted', 'declined', 'tentative'].includes(response)) throw new Error('That is not an answer');

  const client = makeClient(agent, key);
  const url = `${CAL}/calendars/${encodeURIComponent(agent)}/events/${encodeURIComponent(eventId)}`;
  let cur;
  try {
    cur = await client.request({ url });
  } catch (e) {
    const known = explain(e);
    if (known instanceof CalendarNotReady) throw known;
    // The invitation is gone from their calendar \u2014 deleted, or never arrived.
    return { ok: false, gone: true };
  }

  // Only ever the CRM's own bookings, the same rule everything else here
  // follows. Somebody's other invitations are answered in their own calendar.
  //
  // With a leadId this is a site visit and must be THAT lead's. Without one it
  // is a team meeting, and any booking the CRM made will do — but something
  // the CRM did not make still will not, so a private appointment cannot be
  // answered, or read, from here.
  const priv = (cur.data.extendedProperties && cur.data.extendedProperties.private) || {};
  if (leadId) { if (priv[STAMP] !== leadId) return { ok: false, notOurs: true }; }
  else if (!priv[STAMP] && !priv[MEET_STAMP]) return { ok: false, notOurs: true };

  const attendees = cur.data.attendees || [];
  if (!attendees.some(a => sameEmail(a.email, agent))) return { ok: false, notInvited: true };

  // The whole guest list is handed back with one entry changed. Sending only
  // the responder would have Google treat the others as removed, and an agent
  // saying "yes" would uninvite everybody else on the visit.
  const next = attendees.map(a => sameEmail(a.email, agent)
    ? { ...a, responseStatus: response, comment: reason ? String(reason).slice(0, 500) : undefined }
    : a);

  try {
    // sendUpdates=all so the office is told, which is the point of answering.
    const r = await client.request({ url: url + '?sendUpdates=all', method: 'PATCH', data: { attendees: next } });
    return { ok: true, replies: (r.data.attendees || []).map(a => ({
      email: a.email, status: a.responseStatus || 'needsAction', reason: a.comment || null })) };
  } catch (e) {
    throw explain(e);
  }
}

/**
 * Our booking for this lead, found by the stamp rather than by a remembered id.
 *
 * The id is stored on the lead, but a restore, a hand-edit or a half-finished
 * write can lose it — and without this the CRM would make a SECOND entry in
 * the agent's diary for a visit that is already there. Asking Google which of
 * its events carries our mark is the reliable question.
 */
export async function findVisitEvent({ organiser, leadId, from, to,
  key = serviceKey(), makeClient = realClient }) {
  if (!key || !organiser || !leadId) return null;
  const url = `${CAL}/calendars/${encodeURIComponent(organiser)}/events`
    + `?privateExtendedProperty=${encodeURIComponent(STAMP + '=' + leadId)}`
    + `&maxResults=5&singleEvents=true&orderBy=startTime`
    + (from ? `&timeMin=${encodeURIComponent(new Date(from).toISOString())}` : '')
    + (to ? `&timeMax=${encodeURIComponent(new Date(to).toISOString())}` : '');
  try {
    const r = await makeClient(organiser, key).request({ url });
    const hit = (r.data.items || []).find(e => e.status !== 'cancelled');
    return hit ? hit.id : null;
  } catch { return null; }
}

/** A site visit, which is an event with a lead behind it. Same act, narrower rule. */
export const respondToVisit = respondToEvent;

/**
 * One CRM-made event as the person looking at it, with who is coming.
 * Read AS them, so it only ever returns something already in their calendar.
 */
export async function eventDetail({ viewer, eventId, key = serviceKey(), makeClient = realClient }) {
  if (!key || !viewer || !eventId) return null;
  try {
    const r = await makeClient(viewer, key).request({
      url: `${CAL}/calendars/${encodeURIComponent(viewer)}/events/${encodeURIComponent(eventId)}` });
    const e = r.data;
    const priv = (e.extendedProperties && e.extendedProperties.private) || {};
    // Not ours is not shown. The grid may draw somebody's dentist appointment
    // as a busy block; opening it here must not hand over the details.
    if (!priv[STAMP] && !priv[MEET_STAMP]) return { ok: false, notOurs: true };
    return {
      ok: true, id: e.id, title: e.summary || '(no title)',
      start: e.start && (e.start.dateTime || e.start.date) || null,
      end: e.end && (e.end.dateTime || e.end.date) || null,
      where: e.location || null, about: e.description || null,
      meet: e.hangoutLink || null, link: e.htmlLink || null,
      organiser: (e.organizer && e.organizer.email) || null,
      // Editing and cancelling belong to whoever booked it. Everyone else
      // answers their own invitation and leaves the arrangements alone.
      iCreated: sameEmail((e.organizer && e.organizer.email) || '', viewer),
      minutes: (e.start && e.end && e.start.dateTime && e.end.dateTime)
        ? Math.round((Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime)) / 60000) : null,
      repeats: Array.isArray(e.recurrence) && e.recurrence.length > 0,
      leadId: priv[STAMP] || null,
      attendees: (e.attendees || []).map(a => ({ email: a.email, status: a.responseStatus || 'needsAction', reason: a.comment || null })),
      mine: (e.attendees || []).filter(a => sameEmail(a.email, viewer))
        .map(a => a.responseStatus || 'needsAction')[0] || null
    };
  } catch { return { ok: false, gone: true }; }
}
