// The editor's flow.   node tests/edit-flow.test.mjs
import { setEdit, editOf, editLogOf, editColumn, editorTrack, normalizeEdit, span, ED_DROP, priority, checks, postGate } from '../track-assets/edit-flow.js';

let failed = 0;
const check = (label, cond, detail) => { if (!cond) { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
const eq = (l, a, b) => check(l, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const NOW = 1789000000000, H = 3600000, DAY = 24 * H;
const apply = (x, r) => ({ ...x, edit: r.edit, editLog: r.editLog });

console.log('3 PIN Realty — edit flow');

check('Nothing recorded reads as not planned', editOf({}).status === '' && editLogOf({}).length === 0);
check('A bad status reads as not planned', normalizeEdit({ status: 'zzz', startedAt: 5 }).status === '' && normalizeEdit({ status: 'zzz', startedAt: 5 }).startedAt === 0);

// plan → start → done
check('Planning needs an editor', !setEdit({}, 'plan', {}, NOW, '').ok);
let x = { id: 'L1' };
x = apply(x, setEdit(x, 'plan', { by: 'Ravi', planAt: NOW + DAY }, NOW, 'admin@x'));
eq('Planned for a day, by an editor', [x.edit.status, x.edit.by, x.edit.planAt], ['planned', 'Ravi', NOW + DAY]);
x = apply(x, setEdit(x, 'start', {}, NOW + H, 'admin@x'));
eq('Started keeps the editor and the plan, stamps the time', [x.edit.status, x.edit.by, x.edit.planAt, x.edit.startedAt], ['active', 'Ravi', NOW + DAY, NOW + H]);
check('Cannot start twice', !setEdit(x, 'start', {}, NOW + 2 * H).ok);
x = apply(x, setEdit(x, 'done', {}, NOW + 3 * H, 'admin@x'));
eq('Done stamps the time, keeps when it started', [x.edit.status, x.edit.startedAt, x.edit.doneAt], ['done', NOW + H, NOW + 3 * H]);
check('Cannot finish twice', !setEdit(x, 'done', {}, NOW + 4 * H).ok);
const quick = apply({ id: 'Q' }, setEdit({ id: 'Q' }, 'start', { by: 'Anu' }, NOW, ''));
check('Started without a plan', quick.edit.status === 'active' && quick.edit.by === 'Anu' && !quick.edit.planAt);
check('The person signed in edits when nobody is named', setEdit({}, 'start', {}, NOW, 'Anu').edit.by === 'Anu');

// a re-edit keeps the first edit
const re = apply(x, setEdit(x, 'start', { by: 'Anu' }, NOW + DAY, ''));
eq('A re-edit starts fresh', [re.edit.status, re.edit.by, re.edit.startedAt, re.edit.doneAt], ['active', 'Anu', NOW + DAY, 0]);
eq('…and the finished edit is in the log', re.editLog.map(l => [l.by, l.startedAt, l.doneAt]), [['Ravi', NOW + H, NOW + 3 * H]]);
check('Planning again after done also logs it', setEdit(x, 'plan', { by: 'Ravi' }, NOW + DAY).editLog.length === 1);
check('Reset keeps the log of a done edit', setEdit(x, 'reset', {}, NOW).edit.status === '' && setEdit(x, 'reset', {}, NOW).editLog.length === 1);
check('Assigning an unplanned card plans it', setEdit({}, 'assign', { by: 'Ravi' }, NOW).edit.status === 'planned');
check('Assigning an active edit changes only who', setEdit(quick, 'assign', { by: 'Ravi' }, NOW).edit.startedAt === NOW && setEdit(quick, 'assign', { by: 'Ravi' }, NOW).edit.by === 'Ravi');
eq('Only the editor\'s own columns take a drop', Object.keys(ED_DROP).sort(), ['active', 'done', 'planned', 'shoot_done']);

// columns
const col = (edit, ctx) => editColumn({ edit }, ctx);
check('Booked, not shot → Shoot planned', col(null, { stageKey: 'shoot_scheduled', shootPlanned: true }) === 'shoot_planned');
check('Not booked → not in the editor view', col(null, { stageKey: 'new_listing' }) === null);
check('Shot → Shoot done', col(null, { stageKey: 'shoot_done', shot: true }) === 'shoot_done');
check('Planned → Planned to edit', col({ status: 'planned', by: 'R' }, { stageKey: 'shoot_done', shot: true }) === 'planned');
check('Editing shows even on hold', col({ status: 'active', by: 'R', startedAt: 1 }, { stageKey: 'on_hold' }) === 'active');
check('Planned on hold is parked', col({ status: 'planned', by: 'R' }, { stageKey: 'on_hold' }) === null);
check('Done, nothing scheduled → Edit done', col({ status: 'done', by: 'R', doneAt: 1 }, { stageKey: 'media_ready', shot: true, posts: { total: 0 } }) === 'done');
check('Done and a post has a time → Post scheduled', col({ status: 'done', by: 'R', doneAt: 1 }, { shot: true, posts: { total: 2, scheduled: 1, live: 1 } }) === 'scheduled');
check('Done and posted since → past edit, off the view', col({ status: 'done', by: 'R', startedAt: 10, doneAt: 20 }, { shot: true, posts: { total: 2, live: 2, lastLiveAt: 30 } }) === null);
check('Done and posted, then another round planned in Posting → back in Edit done (schedule it)', col({ status: 'done', by: 'R', startedAt: 10, doneAt: 20 }, { shot: true, posts: { total: 3, live: 2, planned: 1, lastLiveAt: 30 } }) === 'done');
check('Done, but the only live post is from before this edit → still Edit done', col({ status: 'done', by: 'R', startedAt: 10, doneAt: 20 }, { shot: true, posts: { total: 1, live: 1, lastLiveAt: 5 } }) === 'done');
check('An old live card with no edit is not new work', col(null, { stageKey: 'live', shot: true }) === null);
check('…unless Posting has it scheduled', col(null, { stageKey: 'live', shot: true, posts: { total: 1, scheduled: 1 } }) === 'scheduled');
check('Sold → off the view', col(null, { stageKey: 'closed', shot: true }) === null);
check('A post already live but a cut still to make → still Shoot done', col(null, { stageKey: 'shoot_done', shot: true, cutsLeft: 2, posts: { total: 1, live: 1 } }) === 'shoot_done');
check('…nothing left to cut → off the view', col(null, { stageKey: 'shoot_done', shot: true, cutsLeft: 0, posts: { total: 1, live: 1 } }) === null);
check('Shot with a post planned in Posting, edit not planned → Planned to edit / post', col(null, { stageKey: 'shoot_done', shot: true, posts: { total: 1, planned: 1 } }) === 'planned');
check('…a post already scheduled before the edit, likewise', col(null, { stageKey: 'shoot_done', shot: true, posts: { total: 1, scheduled: 1 } }) === 'planned');
check('Media ready, every cut made, no edit record: edited before — off the view', col(null, { stageKey: 'media_ready', shot: true, cutsLeft: 0 }) === null);
check('…a cut still to make: still work', col(null, { stageKey: 'media_ready', shot: true, cutsLeft: 1 }) === 'shoot_done');

// priority: the nearest deadline first
const day0 = new Date(NOW); day0.setHours(0, 0, 0, 0); const D0 = day0.getTime();
const pr = (edit, ctx) => priority({ edit }, ctx, NOW);
check('Before the shoot, the shoot date leads', pr(null, { stageKey: 'shoot_scheduled', shootPlanned: true, shootAt: NOW + DAY }).what === 'shoot');
const both = pr({ status: 'planned', by: 'R', dueAt: D0 + 3 * DAY }, { shot: true, postAt: D0 + 2 * DAY + 18 * H });
check('An edit is due by the earlier of delivery and post day', both.what === 'post' && both.soon);
check('…the delivery date when it comes first', pr({ status: 'planned', by: 'R', dueAt: D0 + DAY }, { shot: true, postAt: D0 + 5 * DAY }).what === 'delivery');
check('Delivery due today is today, not late', pr({ status: 'active', by: 'R', startedAt: 1, dueAt: D0 + 10 * H }, { shot: true }).today);
check('Delivery yesterday is late', pr({ status: 'active', by: 'R', startedAt: 1, dueAt: D0 - DAY }, { shot: true }).late);
check('A shoot that has passed unshot is late', pr(null, { stageKey: 'shoot_scheduled', shootPlanned: true, shootAt: NOW - H }).late);
check('A scheduled post is never "late" here (Posting confirms it)', !pr({ status: 'done', by: 'R', doneAt: 1 }, { shot: true, posts: { total: 1, scheduled: 1 }, postAt: NOW - H }).late);
check('"Due soon" window is configurable', !priority({ edit: { status: 'planned', by: 'R', dueAt: D0 + 3 * DAY } }, { shot: true }, NOW, 2).soon && priority({ edit: { status: 'planned', by: 'R', dueAt: D0 + 3 * DAY } }, { shot: true }, NOW, 4).soon);
check('A post planned for today (no time) is today, not late', pr({ status: 'planned', by: 'R' }, { shot: true, postAt: D0, postTimed: false }).today);
check('No date, ranked last', pr({ status: 'planned', by: 'R' }, { shot: true }).rank === Infinity);
check('Delivery before the edit day is refused', !setEdit({}, 'plan', { by: 'R', planAt: D0 + 2 * DAY, dueAt: D0 + DAY }, NOW).ok);
check('Planning keeps the delivery date', setEdit({}, 'plan', { by: 'R', dueAt: D0 + DAY }, NOW).edit.dueAt === D0 + DAY);

// the track
const items = [
  { x: { id: 'A', edit: { status: 'active', by: 'Ravi', startedAt: NOW - 2 * H } }, title: 'A' },
  { x: { id: 'B', edit: { status: 'planned', by: 'ravi', planAt: NOW + DAY } }, title: 'B' },
  { x: { id: 'C', edit: { status: 'done', by: 'Anu', startedAt: NOW - 5 * H, doneAt: NOW - H }, editLog: [{ by: 'Ravi', startedAt: NOW - 10 * DAY, doneAt: NOW - 10 * DAY + 2 * H }] }, title: 'C' },
  { x: { id: 'D', edit: { status: 'planned', by: '' } }, title: 'D' }
];
const tr = editorTrack(items, NOW);
const ravi = tr.find(r => r.name.toLowerCase() === 'ravi'), anu = tr.find(r => r.name === 'Anu');
check('One line per editor, whatever the case', tr.filter(r => r.name.toLowerCase() === 'ravi').length === 1);
eq('Ravi: editing one, one planned, one past edit', [ravi.active.length, ravi.planned.length, ravi.done.length], [1, 1, 1]);
check('Past edits count from the log', ravi.done[0].id === 'C' && ravi.doneWeek === 0);
check('Anu: one done this week, 4h on average', anu.done.length === 1 && anu.doneWeek === 1 && Math.round(anu.avgHours) === 4);
check('Unassigned last', tr[tr.length - 1].name === '');
check('Busiest editor first', tr[0].name.toLowerCase() === 'ravi');
eq('Spans read plainly', [span(35 * 60000), span(130 * 60000), span(2 * H), span(76 * H)], ['35m', '2h 10m', '2h', '3d 4h']);

// the two checks and the posting rules
check('Edit planned, no post planned: edited in free time, post later', JSON.stringify(checks({ edit: { status: 'planned', by: 'R' } }, { posts: {} })) === JSON.stringify({ edit: true, editDone: false, post: false, gap: 'post' }));
check('Post planned, no edit: the gap to fix', checks({}, { posts: { planned: 1 } }).gap === 'edit');
check('Both planned: no gap', checks({ edit: { status: 'done', by: 'R', doneAt: 1 } }, { posts: { scheduled: 1 } }).gap === '');
check('A post with a time needs its edit planned', !postGate({}, 'schedule').ok && postGate({ edit: { status: 'planned', by: 'R' } }, 'schedule').ok);
check('A post goes live only once its edit is done', !postGate({ edit: { status: 'active', by: 'R', startedAt: 1 } }, 'live').ok && postGate({ edit: { status: 'done', by: 'R', doneAt: 1 } }, 'live').ok);
check('No board card: not held back', postGate(null, 'live').ok);
// Cards from before the Editor view existed are taken as edited — not held back, not flagged.
check('A Live card with no edit record can post (edited before)', postGate({}, 'live', { stageKey: 'live' }).ok && postGate({}, 'schedule', { stageKey: 'live' }).ok);
check('…a Media ready card with nothing left to cut, too', postGate({}, 'live', { stageKey: 'media_ready', cutsLeft: 0 }).ok);
check('…and a card made from Posting for its brochure', postGate({ source: 'posting' }, 'live', { stageKey: 'shoot_done' }).ok);
check('…but Media ready with a cut still to make is held', !postGate({}, 'live', { stageKey: 'media_ready', cutsLeft: 1 }).ok);
check('Checklist agrees: an edited-before card is not flagged', checks({}, { stageKey: 'live', posts: { scheduled: 1 } }).gap === '');
console.log(failed ? `\n${failed} failure(s)` : '\nAll good.');
process.exit(failed ? 1 : 0);
