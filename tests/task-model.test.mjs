// Tasks: who sees and may change what, due-date buckets, who is emailed (shared-assets/task-model.js).
//   node tests/task-model.test.mjs
import * as T from '../shared-assets/task-model.js';

let failed = 0, passed = 0;
const ok = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
console.log('3 PIN Realty — Tasks: the rules\n');

const TEN = 't_3pinrealty';
const CFG = { managers: ['Thirumal@threepin.in', 'swami@threepin.in'], viewers: { 'pradeep@threepin.in': ['rajesh@threepin.in', 'PRADEEP@threepin.in'] } };
const task = { title: 'Call the owner of ANR003', primary: 'Rajesh@threepin.in', secondary: ['dev@threepin.in'], status: 'todo', due: '2026-10-20' };

// Managers
ok('managers come from the configuration, lower-cased', T.managersOf(CFG).join() === 'thirumal@threepin.in,swami@threepin.in');
ok('with no configuration, Thirumal and Swami manage', T.managersOf(null).join() === 'thirumal@threepin.in,swami@threepin.in');
ok('an empty manager list falls back to them too (nobody locked out)', T.managersOf({ managers: [] }).length === 2);
ok('isManager ignores case', T.isManager(CFG, 'SWAMI@threepin.in') && !T.isManager(CFG, 'rajesh@threepin.in'));

// People and visibility
ok('assignees: the primary first, then secondaries, lower-cased, no repeats', T.assigneesOf({ primary: 'A@x.in', secondary: ['b@x.in', 'a@x.in'] }).join() === 'a@x.in,b@x.in');
ok('a viewer never "sees" themselves', T.canViewPeople(CFG, 'pradeep@threepin.in').join() === 'rajesh@threepin.in');
const vis = T.visibleToFor(task, CFG, TEN);
ok('visibleTo: the people on it and those allowed to see them, tenant-scoped', vis.join() === [TEN + '|dev@threepin.in', TEN + '|pradeep@threepin.in', TEN + '|rajesh@threepin.in'].join(), vis.join());
ok('visibleTo never lists the managers (they see everything anyway)', !vis.some(k => /thirumal|swami/.test(k)));
ok('a task for someone nobody watches is seen by its people only', T.visibleToFor({ primary: 'dev@threepin.in' }, CFG, TEN).join() === TEN + '|dev@threepin.in');

// Rights
const r = (who) => T.rightsFor(task, CFG, who);
ok('a manager may do everything', Object.values(r('thirumal@threepin.in')).every(Boolean));
ok('the primary may edit but not reassign or delete', r('rajesh@threepin.in').edit && !r('rajesh@threepin.in').reassign && !r('rajesh@threepin.in').remove);
ok('a secondary may edit too', r('dev@threepin.in').edit && !r('dev@threepin.in').reassign);
ok('a viewer may see but not edit', r('pradeep@threepin.in').view && !r('pradeep@threepin.in').edit);
ok('anyone else may not even see it', !r('3pinrentals@gmail.com').view && !r('3pinrentals@gmail.com').edit);
ok('only managers create', T.rightsFor(null, CFG, 'swami@threepin.in').create && !T.rightsFor(null, CFG, 'rajesh@threepin.in').create);
ok('the fields an assignee may change exclude the people', !T.ASSIGNEE_FIELDS.some(f => ['primary', 'secondary', 'assignees', 'visibleTo', 'tenantId', 'createdBy'].includes(f)));

// Due dates (IST)
const at = s => Date.parse(s);   // an instant
const now = at('2026-10-15T10:00:00+05:30');
ok('due by the end of that day in India', T.dueAtOf('2026-10-15') === at('2026-10-15T23:59:59+05:30'));
ok('no date, no due time', T.dueAtOf('') === null && T.dueAtOf('15/10/2026') === null);
ok('yesterday is overdue', T.dueBucket({ status: 'todo', due: '2026-10-14' }, now) === 'overdue');
ok('today is today', T.dueBucket({ status: 'doing', due: '2026-10-15' }, now) === 'today');
ok('…even late at night in India (18:30 UTC is past midnight IST)', T.dueBucket({ status: 'todo', due: '2026-10-16' }, at('2026-10-15T19:00:00Z')) === 'today');
ok('within a week is this week', T.dueBucket({ status: 'todo', due: '2026-10-19' }, now) === 'week');
ok('further out is later', T.dueBucket({ status: 'todo', due: '2026-12-01' }, now) === 'later');
ok('a completed task is done whatever its date', T.dueBucket({ status: 'done', due: '2026-01-01' }, now) === 'done');
ok('undated is none', T.dueBucket({ status: 'todo' }, now) === 'none');
const sorted = T.sortTasks([
  { id: 'later', status: 'todo', due: '2026-12-01' }, { id: 'none', status: 'todo' }, { id: 'done', status: 'done', completedAt: 5 },
  { id: 'late', status: 'todo', due: '2026-10-01' }, { id: 'today', status: 'doing', due: '2026-10-15' }], now).map(t => t.id).join();
ok('sorted: late, today, later, undated, then completed', sorted === 'late,today,later,none,done', sorted);

// Validation
ok('a good task has no problems', T.problemsWith(task).length === 0, T.problemsWith(task).join());
ok('no title, no person, bad status are all named', T.problemsWith({ status: 'x' }).length === 3, T.problemsWith({ status: 'x' }).join(' | '));
ok('the primary cannot also be a secondary', T.problemsWith({ ...task, secondary: ['RAJESH@threepin.in'] }).some(p => /primary/.test(p)));
ok('a bad date is named', T.problemsWith({ ...task, due: '20/10' }).some(p => /date/.test(p)));
ok('too many secondaries is named', T.problemsWith({ ...task, secondary: ['a@x.in', 'b@x.in', 'c@x.in', 'd@x.in', 'e@x.in', 'f@x.in'] }).some(p => /At most/.test(p)));

// History and changes
const h = T.withHistory(Array.from({ length: 70 }, (_, i) => ({ i })), T.historyEntry('X@y.in', 'made'));
ok('history keeps the latest entries only', h.length === T.MAX_HISTORY && h[h.length - 1].text === 'made' && h[h.length - 1].by === 'x@y.in');
const ch = T.changesBetween(task, { ...task, status: 'doing', due: '2026-10-22', secondary: [] });
ok('changes are said in words', ch.join(' | ') === 'status Yet to start → In Progress | due 2026-10-22 | secondary people changed', ch.join(' | '));

// Emails
ok('assigned: the people just added, never the one assigning', T.recipientsFor('assigned', task, CFG, 'thirumal@threepin.in').join() === 'rajesh@threepin.in,dev@threepin.in');
ok('assigned with an added list: only those (and only if really on it)', T.recipientsFor('assigned', task, CFG, 'swami@threepin.in', ['dev@threepin.in', 'stranger@x.in']).join() === 'dev@threepin.in');
ok('status: everyone on it and the managers, not the one who changed it',
  T.recipientsFor('status', task, CFG, 'rajesh@threepin.in').join() === 'dev@threepin.in,thirumal@threepin.in,swami@threepin.in');
ok('a manager changing the status is not emailed themselves', !T.recipientsFor('status', task, CFG, 'swami@threepin.in').includes('swami@threepin.in'));
ok('an unknown event emails nobody', T.recipientsFor('edited', task, CFG, 'x@y.in').length === 0);
const morning = T.morningListFor([
  { id: 1, primary: 'a@x.in', status: 'todo', due: '2026-10-14' }, { id: 2, primary: 'a@x.in', secondary: ['b@x.in'], status: 'doing', due: '2026-10-15' },
  { id: 3, primary: 'a@x.in', status: 'todo', due: '2026-10-30' }, { id: 4, primary: 'b@x.in', status: 'done', due: '2026-10-10' }], now);
ok('morning: each person gets their late and due-today tasks', (morning['a@x.in'] || []).map(t => t.id).join() === '1,2' && (morning['b@x.in'] || []).map(t => t.id).join() === '2', JSON.stringify(morning));

// Configuration tidy-up
const n = T.normaliseConfig({ managers: ['SWAMI@threepin.in', 'bad'], viewers: { 'A@x.in': ['a@x.in', 'B@x.in', 'junk'], 'nobody': ['c@x.in'], 'c@x.in': [] } });
ok('normaliseConfig: valid, lower-case, no self, no empties', JSON.stringify(n) === JSON.stringify({ managers: ['swami@threepin.in'], viewers: { 'a@x.in': ['b@x.in'] } }), JSON.stringify(n));

console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
