// attendance-core.js: India days, sessions and hours. node tests/attendance.test.mjs
import assert from 'node:assert/strict';
import * as C from '../shared-assets/attendance-core.js';

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('the India day, not the server’s', () => {
  // 20:00 UTC on 21 Nov is 01:30 on 22 Nov in India.
  assert.equal(C.dayOf(Date.UTC(2026, 10, 21, 20, 0)), '2026-11-22');
  assert.equal(C.dayOf(Date.UTC(2026, 10, 21, 18, 0)), '2026-11-21');
  assert.equal(C.hourOf(Date.UTC(2026, 10, 22, 1, 30)), 7, '01:30 UTC is 7 am India');
  assert.equal(C.hourOf(Date.UTC(2026, 10, 22, 1, 29)), 6);
});
t('calendar steps', () => {
  assert.equal(C.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(C.daysBetween('2026-11-20', '2026-11-22'), ['2026-11-20', '2026-11-21', '2026-11-22']);
  assert.equal(C.isDay('2026-02-30'), false);
  assert.equal(C.isDay('2026-11-22'), true);
});
t('sessions and worked time', () => {
  const h = 3600e3;
  const s = C.summarise([
    { type: 'in', at: 0 }, { type: 'out', at: 2 * h }, { type: 'site_visit', at: 3 * h },
    { type: 'in', at: 4 * h }, { type: 'in', at: 5 * h }, { type: 'out', at: 6.5 * h },
  ]);
  assert.equal(s.sessions.length, 2, 'a double sign-in is one session; other event types are ignored');
  assert.equal(s.workedMs, 4.5 * h);
  assert.equal(s.open, false);
  assert.equal(s.firstIn, 0);
  assert.equal(s.lastOut, 6.5 * h);
  const o = C.summarise([{ type: 'in', at: 0 }]);
  assert.equal(o.open, true);
  assert.equal(C.liveMs(o, h), h, 'still in: counts up to now');
  const m = C.summarise([{ type: 'in', at: 0 }, { type: 'out', at: 20 * h, missedOut: true }]);
  assert.equal(m.workedMs, 0, 'never signed out: not counted');
  assert.equal(m.lastOut, null);
});
t('words', () => {
  assert.equal(C.hm(0), '0m');
  assert.equal(C.hm(45 * 60e3), '45m');
  assert.equal(C.hm(7 * 3600e3 + 5 * 60e3), '7h 05m');
  assert.match(C.clock(Date.UTC(2026, 10, 22, 4, 12)), /^9:42 am$/);
  assert.match(C.dayLabel('2026-11-22'), /^Sun,? 22 Nov$/);
  assert.match(C.alertLine({ type: 'in', at: Date.UTC(2026, 10, 22, 4, 12), name: 'Pradeep' }), /^Pradeep signed in at 9:42 am$/);
});
t('who is kept and who is an admin', () => {
  assert.deepEqual(C.adminsOf({}), ['thirumal@threepin.in', 'swami@threepin.in']);
  assert.deepEqual(C.adminsOf({ admins: ['A@x.in', 'a@x.in'] }), ['a@x.in']);
  assert.equal(C.isTracked({}, 'r@x.in', 'agent'), false);
  assert.equal(C.isTracked({}, 'r@x.in', 'none'), true);
  assert.equal(C.isTracked({ tracked: { 'r@x.in': true } }, 'R@x.in', 'agent'), true);
  assert.equal(C.isTracked({ tracked: { 'r@x.in': false } }, 'r@x.in', 'admin'), false);
});
console.log(`attendance: ${n} groups passed`);
