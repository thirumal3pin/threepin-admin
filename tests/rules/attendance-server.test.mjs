// Attendance's server (api/_attendance.js) against the LOCAL Firestore emulator.
// Run: cd tests/rules && node run.mjs attendance-server.test.mjs. Never touches the live database.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run through run.mjs: the emulator must be up');
if (!getApps().length) initializeApp({ projectId: 'demo-threepin' });
const db = getFirestore();
const A = await import('../../api/_attendance.js');
const C = await import('../../shared-assets/attendance-core.js');

const T = 't_3pinrealty';
const person = (uid, email, role, name) => ({ uid, email, displayName: name, disabled: false, customClaims: { tenantId: T, ...(role ? { role } : {}) } });
const TEAM = [
  person('u_swami', 'swami@threepin.in', 'admin', 'Swami'),
  person('u_thiru', 'thirumal@threepin.in', 'admin', 'Thirumal'),
  person('u_pradeep', 'pradeep@threepin.in', 'admin', 'Pradeep'),
  person('u_rajesh', 'rajesh@threepin.in', null, 'Rajesh'),
  person('u_rameez', 'rameez@threepin.in', 'agent', 'Rameez'),
  { ...person('u_x', 'x@other.in', null, 'Other'), customClaims: { tenantId: 't_other' } },
];
A.__setTeamSource(() => TEAM);
let mails = [];
A.__setMailer(async (to, subject, text, html) => { mails.push({ to, subject, text, html }); return { ok: true }; });

const U = {
  swami: { uid: 'u_swami', email: 'swami@threepin.in', role: 'admin', email_verified: true, tenantId: T },
  thiru: { uid: 'u_thiru', email: 'thirumal@threepin.in', role: 'admin', email_verified: true, tenantId: T },
  pradeep: { uid: 'u_pradeep', email: 'pradeep@threepin.in', role: 'admin', email_verified: true, tenantId: T },
  rajesh: { uid: 'u_rajesh', email: 'rajesh@threepin.in', email_verified: true, tenantId: T },
  rameez: { uid: 'u_rameez', email: 'rameez@threepin.in', role: 'agent', email_verified: true, tenantId: T },
};
const call = async (who, action, body = {}) => { const r = await A.attendanceAct(U[who], { action, ...body }); return { status: r.status, ...(await r.json()) }; };
const today = C.dayOf();
const rec = async (uid, day = today) => (await db.collection('attendance').doc(C.docId(T, uid, day)).get()).data();
// Moves a person's last event back in time, so the one-minute guard does not refuse the next tap.
async function age(uid, ms, day = today) {
  const ref = db.collection('attendance').doc(C.docId(T, uid, day));
  const r = (await ref.get()).data();
  const events = r.events.map(e => ({ ...e, at: e.at - ms }));
  await ref.set({ ...r, events, ...C.summarise(events) });
}

beforeEach(async () => {
  mails = [];
  for (const c of ['attendance', 'attendanceConfig', 'attendanceSeen', 'users']) {
    const s = await db.collection(c).get();
    for (const d of s.docs) await d.ref.delete();
  }
  await db.collection('users').doc('u_pradeep').set({ name: 'Pradeep K', tenantId: T });
});

test('sign in, sign out, sign in again: sessions add up and every change alerts the two admins', async () => {
  let r = await call('pradeep', 'status');
  assert.equal(r.tracked, true);
  assert.equal(r.isAdmin, false, 'pradeep is an admin of the app but not of attendance');
  assert.equal(r.today.sessions.length, 0);

  r = await call('pradeep', 'sign-in', { source: 'popup' });
  assert.equal(r.ok, true);
  assert.equal(r.today.open, true);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'thirumal@threepin.in, swami@threepin.in');
  assert.match(mails[0].subject, /Pradeep K signed in/);
  assert.match(mails[0].text, /pradeep@threepin\.in/);

  r = await call('pradeep', 'sign-in');
  assert.equal(r.already, true, 'a second sign-in while in changes nothing');
  assert.equal(mails.length, 1, 'and sends nothing');

  r = await call('pradeep', 'sign-out');
  assert.equal(r.status, 429, 'within a minute of signing in: refused');
  await age('u_pradeep', 2 * 3600e3);
  r = await call('pradeep', 'sign-out');
  assert.equal(r.ok, true);
  assert.equal(r.today.open, false);
  assert.ok(Math.abs(r.today.workedMs - 2 * 3600e3) < 5000, 'two hours worked');
  assert.match(mails[1].subject, /signed out/);

  await age('u_pradeep', 30 * 60e3);
  r = await call('pradeep', 'sign-in');
  assert.equal(r.ok, true);
  const d = await rec('u_pradeep');
  assert.equal(d.sessions.length, 2);
  assert.equal(d.events.length, 3);
  assert.equal(d.name, 'Pradeep K');
  assert.equal(d.open, true);
});

test('both admins are e-mailed about every sign-in, an admin’s own included', async () => {
  await call('swami', 'sign-in');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'thirumal@threepin.in, swami@threepin.in');
  const b = await call('swami', 'board');
  assert.ok(b.alerts.some(a => a.email === 'swami@threepin.in'), 'and it is in their own alerts list');
});

test('agents are not kept unless an admin switches them on; only attendance admins see the board', async () => {
  let r = await call('rameez', 'status');
  assert.equal(r.tracked, false);
  r = await call('rameez', 'sign-in');
  assert.equal(r.status, 403);
  assert.equal((await call('rajesh', 'board')).status, 403, 'staff cannot see everyone');
  assert.equal((await call('pradeep', 'board')).status, 403, 'an app admin who is not an attendance admin cannot either');
  r = await call('thiru', 'set-tracked', { email: 'rameez@threepin.in', on: true });
  assert.equal(r.ok, true);
  assert.equal((await call('rameez', 'sign-in')).ok, true);
  assert.equal((await call('thiru', 'set-tracked', { email: 'x@other.in', on: true })).status, 404, 'nobody from another business');
});

test('the board: everyone tracked, their state, and alerts each admin clears for themselves', async () => {
  await call('pradeep', 'sign-in');
  await call('rajesh', 'sign-in');
  await age('u_rajesh', 3600e3);
  await call('rajesh', 'sign-out');
  let b = await call('thiru', 'board');
  assert.equal(b.ok, true);
  assert.deepEqual(b.people.map(p => p.email).sort(), ['pradeep@threepin.in', 'rajesh@threepin.in', 'swami@threepin.in', 'thirumal@threepin.in']);
  assert.equal(b.people[0].email, 'pradeep@threepin.in', 'whoever is in comes first');
  assert.equal(b.alerts.length, 3, 'pradeep in, rajesh in, rajesh out');
  assert.match(b.alerts[0].text, /Rajesh signed out at .* — 1h 00m today/);
  assert.ok(!b.everyone.find(p => p.email === 'x@other.in'));

  await call('thiru', 'clear-alerts', { ids: [b.alerts[0].id] });
  b = await call('thiru', 'board');
  assert.equal(b.alerts.length, 2);
  const s = await call('swami', 'board');
  assert.equal(s.alerts.length, 3, 'Swami still sees all three: clearing is per admin');
  await call('swami', 'clear-alerts', { all: true });
  assert.equal((await call('swami', 'board')).alerts.length, 0);
  assert.equal((await call('thiru', 'board')).alerts.length, 2);
});

test('signing out after midnight closes yesterday’s session; a forgotten one is flagged, not counted', async () => {
  const y = C.addDays(today, -1);
  const at = Date.now() - 5 * 3600e3;
  const events = [{ id: 'a', type: 'in', at, source: 'page' }];
  await db.collection('attendance').doc(C.docId(T, 'u_rajesh', y)).set({ tenantId: T, uid: 'u_rajesh', email: 'rajesh@threepin.in', name: 'Rajesh', day: y, events, ...C.summarise(events) });
  let r = await call('rajesh', 'sign-out');
  assert.equal(r.ok, true);
  let yd = await rec('u_rajesh', y);
  assert.equal(yd.open, false);
  assert.ok(Math.abs(yd.workedMs - 5 * 3600e3) < 5000, 'the night shift counts on the day it began');

  // A day left open, and the next morning's sign-in.
  await db.collection('attendance').doc(C.docId(T, 'u_swami', y)).set({ tenantId: T, uid: 'u_swami', email: 'swami@threepin.in', name: 'Swami', day: y, events, ...C.summarise(events) });
  r = await call('swami', 'sign-in');
  assert.equal(r.ok, true);
  yd = await rec('u_swami', y);
  assert.equal(yd.open, false);
  assert.equal(yd.workedMs, 0, 'never signed out: nothing counted');
  assert.equal(yd.sessions[0].missedOut, true);
  const b = await call('thiru', 'board', { day: y });
  assert.ok(b.alerts.some(a => a.missedOut && /didn’t sign out/.test(a.text)));
});

test('history and one person’s days', async () => {
  await call('rajesh', 'sign-in');
  let r = await call('rajesh', 'history');
  assert.equal(r.days.length, 7);
  assert.equal(r.days[0].day, today, 'newest first');
  assert.equal(r.days[0].open, true);
  r = await call('thiru', 'person', { uid: 'u_rajesh', from: C.addDays(today, -29), to: today });
  assert.equal(r.days.length, 30);
  assert.equal(r.name, 'Rajesh');
  assert.equal((await call('thiru', 'person', { uid: 'u_x' })).status, 404);
  assert.equal((await call('rajesh', 'history', { from: today, to: C.addDays(today, -3) })).status, 400);
});

test('the test e-mail goes to both admins, marked TEST, in the requested words', async () => {
  const r = await call('thiru', 'test-email');
  assert.equal(r.ok, true);
  assert.equal(mails[0].to, 'thirumal@threepin.in, swami@threepin.in');
  assert.match(mails[0].subject, /^\[TEST\] 🟢 Pradeep signed in · /);
  assert.match(mails[0].text, /THIS IS A TEST MESSAGE FOR ATTENDANCE ALERTS/);
  assert.match(mails[0].text, /Pradeep \(pradeep@threepin\.in\) signed in now — /);
  assert.match(mails[0].html, /test message for attendance alerts/i);
});

test('an admin puts a missed sign-out right: the hours count, and only an admin can', async () => {
  const y = C.addDays(today, -1);
  const [Y, M, D] = y.split('-').map(Number);
  const istAt = (h, m = 0) => Date.UTC(Y, M - 1, D, h, m) - 5.5 * 3600000;
  const inAt = istAt(9, 30);
  // Signed in at 9:30 yesterday, never signed out; this morning's sign-in closed it as "no sign-out".
  const events = [{ id: 'a', type: 'in', at: inAt, source: 'page' }];
  await db.collection('attendance').doc(C.docId(T, 'u_rajesh', y)).set({ tenantId: T, uid: 'u_rajesh', email: 'rajesh@threepin.in', name: 'Rajesh', day: y, events, ...C.summarise(events) });
  await call('rajesh', 'sign-in');
  let yd = await rec('u_rajesh', y);
  assert.equal(yd.workedMs, 0, 'closed as no sign-out: nothing counted');
  assert.equal((await call('rajesh', 'fix-out', { uid: 'u_rajesh', day: y, inAt, time: '18:30' })).status, 403, 'not the person themselves');
  let r = await call('thiru', 'fix-out', { uid: 'u_rajesh', day: y, inAt, time: '18:30' });
  assert.equal(r.ok, true);
  yd = await rec('u_rajesh', y);
  assert.equal(yd.workedMs, 9 * 3600e3, '9:30 to 6:30 counts: 9 hours');
  assert.equal(yd.sessions[0].missedOut, undefined, 'no longer marked missed');
  const ev = yd.events.find(e => e.type === 'out');
  assert.equal(ev.fixedBy, 'thirumal@threepin.in');
  assert.ok(ev.was, 'what it said before is kept');
  // A session still open on a past day (they never signed in again): closed at the time given.
  const y2 = C.addDays(today, -2);
  const [Y2, M2, D2] = y2.split('-').map(Number);
  const in2 = Date.UTC(Y2, M2 - 1, D2, 10, 0) - 5.5 * 3600000;
  const ev2 = [{ id: 'b', type: 'in', at: in2, source: 'page' }, { id: 'c', type: 'out', at: in2 + 2 * 3600e3, source: 'page' }, { id: 'd', type: 'in', at: in2 + 3 * 3600e3, source: 'page' }];
  await db.collection('attendance').doc(C.docId(T, 'u_swami', y2)).set({ tenantId: T, uid: 'u_swami', email: 'swami@threepin.in', name: 'Swami', day: y2, events: ev2, ...C.summarise(ev2) });
  assert.equal((await call('thiru', 'fix-out', { uid: 'u_swami', day: y2, inAt: in2, time: '11:30' })).status, 409, 'a session with a real sign-out is not "fixed"');
  assert.equal((await call('thiru', 'fix-out', { uid: 'u_swami', day: y2, inAt: in2 + 3 * 3600e3, time: '12:00' })).status, 400, 'a sign-out before the sign-in is refused');
  r = await call('thiru', 'fix-out', { uid: 'u_swami', day: y2, inAt: in2 + 3 * 3600e3, time: '17:00' });
  assert.equal(r.ok, true);
  const s2 = await rec('u_swami', y2);
  assert.equal(s2.open, false);
  assert.equal(s2.workedMs, 2 * 3600e3 + 4 * 3600e3, '2 h + 1 pm to 5 pm');
});
