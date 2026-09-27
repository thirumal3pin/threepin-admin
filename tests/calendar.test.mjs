// ═══════ THE TEAM'S GOOGLE CALENDARS ═══════
//
//   node tests/calendar.test.mjs
//
// The CRM can now write into real people's diaries. That is a different kind
// of privilege from anything else in this codebase: a bug in the board draws
// the wrong box on a screen, and a bug here deletes somebody's dentist
// appointment. So most of this file is about what the CRM must REFUSE to do.
//
// The guard is a stamp. Every event the CRM creates carries
// extendedProperties.private['3pin.lead'], and every update and delete reads
// the event back and walks away unless the stamp matches. These tests drive a
// fake Google that records every request, so "it never touched that event" is
// something the test can actually see rather than assume.

import { teamCalendar, syncVisitEvent, syncTeamMeeting, freeSlots, visitOwnerFor, CalendarNotReady } from '../api/_calendar-shared.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); fails.push(label); }
};
const section = t => { console.log(''); console.log(t); };

const KEY = { client_email: 'sa@pin-realty.iam.gserviceaccount.com', private_key: 'x' };
const T = ['sales@threepin.in', 'swami@threepin.in', 'pradeep@threepin.in'];
const LEAD = { id: 'L1', name: 'Mr Kumar', phone: '9840012345', propertyInterest: 'Anna Nagar 3BHK', budget: '3 Cr' };
const AT = Date.parse('2026-10-03T11:00:00+05:30');

// A Google that remembers what it was asked, and what it holds.
function fakeGoogle(events = {}) {
  const log = [];
  const store = JSON.parse(JSON.stringify(events));
  const make = (subject) => ({
    request: async ({ url, method = 'GET', data }) => {
      log.push({ subject, method, url, data });
      const idMatch = url.match(/\/events\/([^?]+)/);
      if (method === 'GET' && idMatch) {
        const e = (store[subject] || {})[decodeURIComponent(idMatch[1])];
        if (!e) { const err = new Error('Not Found'); err.response = { data: { error: { message: 'Not Found' } } }; throw err; }
        return { data: e };
      }
      if (method === 'GET') return { data: { items: Object.values(store[subject] || {}) } };
      if (method === 'POST') {
        const id = 'ev' + (log.length);
        store[subject] = store[subject] || {};
        store[subject][id] = { id, ...data };
        return { data: store[subject][id] };
      }
      if (method === 'PATCH') {
        const id = decodeURIComponent(idMatch[1]);
        store[subject][id] = { ...store[subject][id], ...data };
        return { data: store[subject][id] };
      }
      if (method === 'DELETE') { delete store[subject][decodeURIComponent(idMatch[1])]; return { data: {} }; }
      return { data: {} };
    }
  });
  return { make, log, store,
    touched: (subject, id) => log.some(r => r.subject === subject && r.method !== 'GET' && r.url.includes(id)) };
}

const stamped = (id, leadId, extra = {}) => ({ id, summary: 'Site visit: Mr Kumar',
  start: { dateTime: new Date(AT).toISOString() }, end: { dateTime: new Date(AT + 3600000).toISOString() },
  extendedProperties: { private: { '3pin.lead': leadId } }, ...extra });
const personal = (id, summary) => ({ id, summary,
  start: { dateTime: new Date(AT).toISOString() }, end: { dateTime: new Date(AT + 3600000).toISOString() } });

// ═══════════════════════════════════════════════════════════════════════
section('IT MUST NOT TOUCH WHAT IT DID NOT CREATE');
// ═══════════════════════════════════════════════════════════════════════
{
  // The worst case: the CRM holds an event id that now points at a real
  // appointment — a stale id, a reused one, a record edited by hand. Updating
  // it would overwrite somebody's actual day with a site visit.
  const g = fakeGoogle({ 'swami@threepin.in': { ev9: personal('ev9', 'Dentist') } });
  const r = await syncVisitEvent({ lead: LEAD, visit: { at: AT, status: 'scheduled', property: 'ANRL001' },
    subject: 'swami@threepin.in', previous: { eventId: 'ev9', owner: 'swami@threepin.in' }, key: KEY, makeClient: g.make });
  ok('an unstamped event is never patched', !g.touched('swami@threepin.in', 'ev9'),
    JSON.stringify(g.log.filter(x => x.method !== 'GET').map(x => x.method + ' ' + x.url.slice(-40))));
  ok('...the dentist appointment is still there', g.store['swami@threepin.in'].ev9.summary === 'Dentist');
  ok('...and a fresh event is made instead', !!r.eventId && r.eventId !== 'ev9');
}
{
  // The same on the way out: cancelling a visit must not delete a real event.
  const g = fakeGoogle({ 'swami@threepin.in': { ev9: personal('ev9', 'School run') } });
  await syncVisitEvent({ lead: LEAD, visit: { at: AT, status: 'cancelled' },
    subject: 'swami@threepin.in', previous: { eventId: 'ev9', owner: 'swami@threepin.in' }, key: KEY, makeClient: g.make });
  ok('an unstamped event is never deleted', !!g.store['swami@threepin.in'].ev9,
    JSON.stringify(Object.keys(g.store['swami@threepin.in'])));
}
{
  // A stamp belonging to a DIFFERENT lead is not our event either.
  const g = fakeGoogle({ 'swami@threepin.in': { ev9: stamped('ev9', 'OTHER-LEAD') } });
  await syncVisitEvent({ lead: LEAD, visit: { at: AT, status: 'cancelled' },
    subject: 'swami@threepin.in', previous: { eventId: 'ev9', owner: 'swami@threepin.in' }, key: KEY, makeClient: g.make });
  ok('another lead’s event is not ours to delete', !!g.store['swami@threepin.in'].ev9);
}

// ═══════════════════════════════════════════════════════════════════════
section('WHAT IT SHOULD DO');
// ═══════════════════════════════════════════════════════════════════════
{
  const g = fakeGoogle();
  const r = await syncVisitEvent({ lead: LEAD, visit: { at: AT, status: 'scheduled', property: 'ANRL001' },
    subject: 'swami@threepin.in', key: KEY, makeClient: g.make });
  const made = g.store['swami@threepin.in'][r.eventId];
  ok('a site visit lands in the agent’s calendar', !!made, JSON.stringify(r));
  ok('...titled so it is obvious on a phone', /Site visit: Mr Kumar/.test(made.summary), made.summary);
  ok('...naming the property', /ANRL001/.test(made.summary + made.location));
  // The number is the reason an agent opens this on the way to the property.
  ok('...carrying the phone number to ring on the way', /9840012345/.test(made.description), made.description);
  ok('...stamped as the CRM’s own', made.extendedProperties.private['3pin.lead'] === 'L1');
  ok('...and it says where to reschedule it', /CRM/.test(made.description));
}
{
  // Rescheduling moves the same entry rather than leaving two.
  const g = fakeGoogle({ 'swami@threepin.in': { ev1: stamped('ev1', 'L1') } });
  const MOVED = AT + 2 * 86400000;
  const r = await syncVisitEvent({ lead: LEAD, visit: { at: MOVED, status: 'scheduled', property: 'ANRL001' },
    subject: 'swami@threepin.in', previous: { eventId: 'ev1', owner: 'swami@threepin.in' }, key: KEY, makeClient: g.make });
  ok('rescheduling moves the entry it already made', r.eventId === 'ev1', JSON.stringify(r));
  ok('...to the new time', g.store['swami@threepin.in'].ev1.start.dateTime === new Date(MOVED).toISOString());
  ok('...leaving exactly one', Object.keys(g.store['swami@threepin.in']).length === 1);
}
{
  // Cancelled in the CRM should not leave somebody driving to a cancelled visit.
  const g = fakeGoogle({ 'swami@threepin.in': { ev1: stamped('ev1', 'L1') } });
  const r = await syncVisitEvent({ lead: LEAD, visit: { at: AT, status: 'cancelled' },
    subject: 'swami@threepin.in', previous: { eventId: 'ev1', owner: 'swami@threepin.in' }, key: KEY, makeClient: g.make });
  ok('a cancelled visit is taken out of the diary', !g.store['swami@threepin.in'].ev1 && r.eventId === null);
}
{
  // Handed to a colleague: it must not stay in the first person's diary.
  const g = fakeGoogle({ 'swami@threepin.in': { ev1: stamped('ev1', 'L1') } });
  const r = await syncVisitEvent({ lead: LEAD, visit: { at: AT, status: 'scheduled', property: 'ANRL001' },
    subject: 'pradeep@threepin.in', previous: { eventId: 'ev1', owner: 'swami@threepin.in' }, key: KEY, makeClient: g.make });
  ok('handing the visit over clears the old diary', !g.store['swami@threepin.in'].ev1);
  ok('...and fills the new one', !!g.store['pradeep@threepin.in'][r.eventId] && r.owner === 'pradeep@threepin.in');
}
{
  // A visit with no time yet ("they said yes, no date agreed") is not an event.
  const g = fakeGoogle();
  const r = await syncVisitEvent({ lead: LEAD, visit: { at: null, status: 'requested' },
    subject: 'swami@threepin.in', key: KEY, makeClient: g.make });
  ok('a visit with no time booked is not put in the diary', r.eventId === null && !g.log.some(x => x.method === 'POST'));
}

// ═══════════════════════════════════════════════════════════════════════
section('READING THE DAY');
// ═══════════════════════════════════════════════════════════════════════
{
  const g = fakeGoogle({
    'sales@threepin.in': { a: personal('a', 'Standup'), b: stamped('b', 'L1') },
    'swami@threepin.in': {},
    'pradeep@threepin.in': { c: { ...personal('c', 'Birthday'), transparency: 'transparent' },
      d: { ...personal('d', 'Team offsite'), attendees: [{ self: true, responseStatus: 'declined' }] } }
  });
  const day = await teamCalendar(T, AT - 3600000, AT + 7200000, { key: KEY, makeClient: g.make });
  ok('every person in the team gets a column', day.length === 3 && day.every(d => T.includes(d.person)));
  ok('...including the one with an empty day', (day.find(d => d.person === 'swami@threepin.in') || {}).events.length === 0);
  const sales = day.find(d => d.person === 'sales@threepin.in');
  ok('the CRM’s own visits are marked as such', sales.events.some(e => e.leadId === 'L1'));
  ok('...and a personal event is not', sales.events.some(e => e.title === 'Standup' && !e.leadId));
  const p = day.find(d => d.person === 'pradeep@threepin.in');
  // A birthday should not make somebody look unavailable all day.
  ok('an event marked free does not read as busy', (p.events.find(e => e.title === 'Birthday') || {}).busy === false);
  // Nor should a meeting they turned down.
  ok('a declined invitation is not shown as a commitment', !p.events.some(e => e.title === 'Team offsite'),
    JSON.stringify(p.events.map(e => e.title)));
}
{
  // One broken mailbox must not blank the whole team.
  const g = fakeGoogle({ 'sales@threepin.in': { a: personal('a', 'Standup') } });
  const make = (subject, key) => subject === 'swami@threepin.in'
    ? { request: async () => { throw new Error('calendar disabled for this user'); } } : g.make(subject, key);
  const day = await teamCalendar(T, AT, AT + 3600000, { key: KEY, makeClient: make });
  ok('one unreadable calendar does not blank the rest', day.find(d => d.person === 'sales@threepin.in').events.length === 1);
  ok('...and says so on that person', !!day.find(d => d.person === 'swami@threepin.in').error);
}
{
  // Setup that is not finished yet must read as setup, not as a crash.
  const notSet = (subject) => ({ request: async () => {
    const e = new Error('unauthorized'); e.response = { data: { error: 'unauthorized_client', error_description: 'Client is not authorized' } }; throw e; } });
  let caught = null;
  await teamCalendar(T, AT, AT + 3600000, { key: KEY, makeClient: notSet }).catch(e => { caught = e; });
  ok('an unauthorised CRM says so in words a person can act on', caught instanceof CalendarNotReady, String(caught));
  ok('...and names the step that is missing', /Domain Wide Delegation/i.test(caught.hint || ''), caught && caught.hint);
}

// ═══════════════════════════════════════════════════════════════════════
section('WHOSE CALENDAR A VISIT BELONGS IN');
// ═══════════════════════════════════════════════════════════════════════
{
  // There is no "lead owner" field in this CRM, so it reads who did the work.
  ok('the person who set the visit',
    visitOwnerFor({ id: 'x' }, { by: 'swami@threepin.in' }, T) === 'swami@threepin.in');
  ok('...then whoever last worked the lead',
    visitOwnerFor({ id: 'x', updatedBy: 'pradeep@threepin.in' }, { by: 'ai' }, T) === 'pradeep@threepin.in');
  // An unowned visit landing nowhere is worse than one on the shared calendar.
  ok('...and the shared inbox rather than nowhere at all',
    visitOwnerFor({ id: 'x' }, { by: 'ai' }, T) === 'sales@threepin.in');
  ok('somebody who has left the team is not a calendar',
    visitOwnerFor({ id: 'x', updatedBy: 'gone@example.com' }, { by: 'ai' }, T) === 'sales@threepin.in');
  ok('no team at all is not a crash', visitOwnerFor({ id: 'x' }, { by: 'ai' }, []) === null);
}

// ════════════════════════════════════════════════════════════════════════
section('MEETINGS AMONG THE TEAM');
// ════════════════════════════════════════════════════════════════════════
{
  const g = fakeGoogle();
  const r = await syncTeamMeeting({ organiser: 'swami@threepin.in',
    attendees: ['pradeep@threepin.in', 'sales@threepin.in'],
    title: 'Monday review', at: AT, minutes: 45, about: 'Pipeline', meet: true, key: KEY, makeClient: g.make });
  const made = g.store['swami@threepin.in'][r.eventId];
  ok('a meeting is booked', !!made, JSON.stringify(r));
  // It must belong to the person who booked it, exactly as if they had used
  // Google themselves — their name on it, their calendar, their right to change it.
  ok('...on the organiser\u2019s own calendar', g.log.every(x => x.subject === 'swami@threepin.in'));
  ok('...inviting the others', made.attendees.map(a => a.email).sort().join(',') === 'pradeep@threepin.in,sales@threepin.in');
  ok('...not inviting the organiser to their own meeting', !made.attendees.some(a => a.email === 'swami@threepin.in'));
  ok('...for the length asked for',
    Date.parse(made.end.dateTime) - Date.parse(made.start.dateTime) === 45 * 60000);
  ok('...with a Meet link requested', !!(made.conferenceData && made.conferenceData.createRequest));
  // Without sendUpdates=all Google files the invitation silently and nobody
  // finds out they have a meeting.
  const post = g.log.find(x => x.method === 'POST');
  ok('...and everybody is actually told', /sendUpdates=all/.test(post.url), post.url);
  ok('...conferenceDataVersion set, or Google drops the link', /conferenceDataVersion=1/.test(post.url));
}
{
  // No Meet link unless asked: an in-person meeting at the office should not
  // arrive with a video link people then wonder whether to join.
  const g = fakeGoogle();
  const r = await syncTeamMeeting({ organiser: 'swami@threepin.in', attendees: ['sales@threepin.in'],
    title: 'Site walkthrough', at: AT, where: 'ANRL001', key: KEY, makeClient: g.make });
  const made = g.store['swami@threepin.in'][r.eventId];
  ok('an in-person meeting gets no video link', !made.conferenceData);
  ok('...but does get the place', made.location === 'ANRL001');
  ok('...and a sensible default length', Date.parse(made.end.dateTime) - Date.parse(made.start.dateTime) === 30 * 60000);
}
{
  // Moving a meeting moves it for everyone, rather than leaving two.
  const g = fakeGoogle({ 'swami@threepin.in': { m1: { id: 'm1', summary: 'Monday review',
    start: { dateTime: new Date(AT).toISOString() }, end: { dateTime: new Date(AT + 1800000).toISOString() },
    extendedProperties: { private: { '3pin.meeting': '1' } } } } });
  const MOVED = AT + 3600000;
  const r = await syncTeamMeeting({ organiser: 'swami@threepin.in', attendees: ['sales@threepin.in'],
    title: 'Monday review', at: MOVED, eventId: 'm1', key: KEY, makeClient: g.make });
  ok('moving a meeting moves the one that exists', r.eventId === 'm1');
  ok('...to the new time', g.store['swami@threepin.in'].m1.start.dateTime === new Date(MOVED).toISOString());
  ok('...telling the attendees', g.log.some(x => x.method === 'PATCH' && /sendUpdates=all/.test(x.url)));
}
{
  const g = fakeGoogle({ 'swami@threepin.in': { m1: { id: 'm1', summary: 'Monday review',
    extendedProperties: { private: { '3pin.meeting': '1' } } } } });
  const r = await syncTeamMeeting({ organiser: 'swami@threepin.in', eventId: 'm1', cancel: true, key: KEY, makeClient: g.make });
  ok('cancelling a meeting removes it', !g.store['swami@threepin.in'].m1 && r.cancelled === true);
  ok('...so nobody turns up to it', g.log.some(x => x.method === 'DELETE' && /sendUpdates=all/.test(x.url)));
}
{
  // The guard again, on the meeting side: a meeting somebody set up in Google
  // themselves is not the CRM\u2019s to cancel or rewrite.
  const g = fakeGoogle({ 'swami@threepin.in': { own: personal('own', 'Board meeting with the bank') } });
  const r = await syncTeamMeeting({ organiser: 'swami@threepin.in', eventId: 'own', cancel: true, key: KEY, makeClient: g.make });
  ok('a meeting the CRM did not create is not cancelled', !!g.store['swami@threepin.in'].own && !!r.skipped, JSON.stringify(r));
  const r2 = await syncTeamMeeting({ organiser: 'swami@threepin.in', title: 'Hijack', at: AT, eventId: 'own', key: KEY, makeClient: g.make });
  ok('...nor rewritten', g.store['swami@threepin.in'].own.summary === 'Board meeting with the bank', JSON.stringify(r2));
}

// ════════════════════════════════════════════════════════════════════════
section('WHEN IS EVERYONE FREE');
// ════════════════════════════════════════════════════════════════════════
{
  const H = 3600000;
  const day = [
    { person: 'a@x', events: [{ start: new Date(AT).toISOString(), end: new Date(AT + H).toISOString(), busy: true }] },
    { person: 'b@x', events: [{ start: new Date(AT + 2 * H).toISOString(), end: new Date(AT + 3 * H).toISOString(), busy: true }] }
  ];
  const slots = freeSlots(day, { from: AT, to: AT + 4 * H, minutes: 60, step: 60 });
  ok('a slot where somebody is busy is not offered', !slots.includes(AT), new Date(AT).toISOString());
  ok('...nor one where the other is', !slots.includes(AT + 2 * H));
  ok('...and the free hours are', slots.length === 2 && slots.includes(AT + H) && slots.includes(AT + 3 * H),
    JSON.stringify(slots.map(t => new Date(t).toISOString())));
  // Birthdays and reminders are marked free, and must not block a Tuesday.
  const withBirthday = [{ person: 'a@x', events: [{ start: new Date(AT).toISOString(), end: new Date(AT + H).toISOString(), busy: false }] }];
  ok('an event marked free blocks nothing', freeSlots(withBirthday, { from: AT, to: AT + H, minutes: 60, step: 60 }).length === 1);
  // An all-day event is usually "I am around but tagged", not a wall.
  const allDay = [{ person: 'a@x', events: [{ start: '2026-10-03', end: '2026-10-04', busy: true, allDay: true }] }];
  ok('an all-day tag does not wipe out the whole day',
    freeSlots(allDay, { from: AT, to: AT + 2 * H, minutes: 60, step: 60 }).length === 2);
}

console.log('');
console.log('─'.repeat(64));
if (fails.length) {
  console.log(fails.length + ' failing of ' + (pass + fails.length) + ':');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
console.log(pass + ' checks, all good.');
