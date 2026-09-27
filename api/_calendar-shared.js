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
const STAMP = '3pin.lead';
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
// Injectable, and not only for convenience: the guard below is the one piece
// of this file that must never regress, and a rule about what the CRM REFUSES
// to touch can only be proved against a transport that records what was asked.
function realClient(subject, key) {
  return new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE], subject });
}

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
    + `&singleEvents=true&orderBy=startTime&maxResults=100&timeZone=${encodeURIComponent(TZ)}`;
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
      // "busy" is the honest signal for status: an event marked free (a
      // reminder, a birthday) must not make somebody look unavailable.
      busy: e.transparency !== 'transparent',
      status: e.status || 'confirmed',
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

function visitEventBody(lead, visit) {
  const end = visit.at + 60 * 60000;
  const code = visit.property ? ` · ${visit.property}` : '';
  const lines = [
    lead.phone ? `Phone: ${lead.phone}` : null,
    lead.propertyInterest ? `Looking for: ${lead.propertyInterest}` : null,
    lead.budget ? `Budget: ${lead.budget}` : null,
    '',
    'Created by the 3 PIN CRM. Reschedule it there and this entry follows.'
  ].filter(x => x !== null);
  return {
    summary: `Site visit: ${lead.name || 'Lead'}${code}`,
    description: lines.join('\n'),
    location: visit.property || undefined,
    start: { dateTime: new Date(visit.at).toISOString(), timeZone: TZ },
    end: { dateTime: new Date(end).toISOString(), timeZone: TZ },
    // The stamp. Everything below refuses to act on an event without it.
    extendedProperties: { private: { [STAMP]: lead.id } },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] }
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
 * Puts this lead's site visit in `subject`'s calendar, moves it when it moves,
 * and takes it out when the visit is cancelled or the owner changes.
 *
 * Returns { eventId, owner } to store on the lead, or { eventId: null } when
 * there is nothing to show. Never touches an event it did not create.
 */
export async function syncVisitEvent({ lead, visit, subject, previous = {}, key = serviceKey(), makeClient = realClient }) {
  if (!key) throw new CalendarNotReady('No Google service account is configured on this deployment');
  const wanted = !!(subject && visit && visit.at && visit.status !== 'cancelled');

  // Moved to somebody else's calendar, or no longer wanted: clear the old one
  // first, so a rescheduled visit never leaves a ghost in the wrong diary.
  if (previous.eventId && (!wanted || previous.owner !== subject)) {
    const mine = await stampedEvent(previous.owner, previous.eventId, lead.id, key, makeClient);
    if (mine) {
      await makeClient(previous.owner, key)
        .request({ url: `${CAL}/calendars/${encodeURIComponent(previous.owner)}/events/${encodeURIComponent(previous.eventId)}`, method: 'DELETE' })
        .catch(() => {});
    }
    previous = {};
  }
  if (!wanted) return { eventId: null, owner: null };

  const body = visitEventBody(lead, visit);
  try {
    if (previous.eventId && previous.owner === subject) {
      const mine = await stampedEvent(subject, previous.eventId, lead.id, key, makeClient);
      if (mine) {
        await makeClient(subject, key).request({
          url: `${CAL}/calendars/${encodeURIComponent(subject)}/events/${encodeURIComponent(previous.eventId)}`,
          method: 'PATCH', data: body
        });
        return { eventId: previous.eventId, owner: subject };
      }
      // The stamp is gone: somebody deleted it in Google. Make a fresh one
      // rather than resurrecting an event a person chose to remove... and do
      // it only because the CRM still holds a live visit for this lead.
    }
    const r = await makeClient(subject, key).request({
      url: `${CAL}/calendars/${encodeURIComponent(subject)}/events`, method: 'POST', data: body
    });
    return { eventId: r.data.id, owner: subject };
  } catch (e) {
    throw explain(e);
  }
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
 * @param {string}   [o.eventId]  an existing meeting to move, rather than a new one
 * @param {boolean}  [o.cancel]   call it off and tell everyone
 */
export async function syncTeamMeeting({ organiser, attendees = [], title, at, minutes = 30, about, where,
  meet = false, eventId = null, cancel = false, key = serviceKey(), makeClient = realClient }) {
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
    guestsCanModify: true
  };
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
