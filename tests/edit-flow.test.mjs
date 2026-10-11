// The editor's flow.   node tests/edit-flow.test.mjs
import { setEdit, editOf, editLogOf, editColumn, editorTrack, normalizeEdit, span, ED_DROP, priority, checks, postGate, cutKeys, cutOfChannel, cutEdit, cutLog, setCut, materializeCuts, ownCuts, cutsView, cutShared, editorTrack as track2 } from '../track-assets/edit-flow.js';

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
check('Done and its post went live this week → Posted', col({ status: 'done', by: 'R', startedAt: NOW - 3 * H, doneAt: NOW - H }, { shot: true, now: NOW, posts: { total: 1, live: 1, lastLiveAt: NOW - 2 * DAY } }) === 'posted');
check('…a week after the last post: off the view (a past edit)', col({ status: 'done', by: 'R', startedAt: 10, doneAt: 20 }, { shot: true, now: NOW, posts: { total: 2, live: 2, lastLiveAt: NOW - 8 * DAY } }) === null);
check('Done and posted, then another round planned in Posting → back in Edit done (schedule it)', col({ status: 'done', by: 'R', startedAt: 10, doneAt: 20 }, { shot: true, posts: { total: 3, live: 2, planned: 1, lastLiveAt: 30 } }) === 'done');
check('…marked live before the edit was marked done (recorded afterwards): still Posted', col({ status: 'done', by: 'R', startedAt: NOW - 60000, doneAt: NOW }, { shot: true, now: NOW, posts: { total: 1, live: 1, lastLiveAt: NOW - 120000 } }) === 'posted');
check('Posted has no deadline', priority({ edit: { status: 'done', by: 'R', doneAt: NOW } }, { shot: true, now: NOW, posts: { total: 1, live: 1, lastLiveAt: NOW } }, NOW).rank === Infinity);
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

// ── cuts: one edit per outlet ──
{
  const card = { id: 'C', forPlan: { igReel: true, yt: true, igStory: true }, forDone: {} };
  eq('The cuts a card has: its planned outlets, FB folded into the Reel', cutKeys(card), ['igStory', 'igReel', 'yt']);
  eq('…and an outlet with a post in Posting', cutKeys({ id: 'C' }, ['fbReel']), ['igReel']);
  eq('FB Reel its own cut when the card says so', cutKeys({ ...card, fbOwnCut: true, forPlan: { ...card.forPlan, fbReel: true } }), ['igStory', 'igReel', 'fbReel', 'yt']);
  check('FB Reel follows the Insta Reel cut by default', cutOfChannel(card, 'fbReel') === 'igReel' && cutOfChannel({ fbOwnCut: true }, 'fbReel') === 'fbReel');
  // The Reel edited on Monday, YouTube on Thursday: each its own.
  let x = card;
  const r1 = setCut(x, 'igReel', 'start', { by: 'Rajesh' }, NOW, '');
  x = { ...x, ...r1.patch };
  const r2 = setCut(x, 'igReel', 'done', {}, NOW + H, '');
  x = { ...x, ...r2.patch };
  eq('Reel done: its cut is done, YouTube untouched', [cutEdit(x, 'igReel').status, cutEdit(x, 'yt').status], ['done', '']);
  check('…Shoot for follows: Reel made, YouTube not', x.forDone.igReel && !x.forDone.yt);
  x = { ...x, ...setCut(x, 'yt', 'plan', { by: 'Anu', planAt: NOW + 3 * DAY }, NOW, '').patch };
  eq('YouTube planned for Thursday by Anu, the Reel still done', [cutEdit(x, 'yt').status, cutEdit(x, 'yt').by, cutEdit(x, 'igReel').status], ['planned', 'Anu', 'done']);
  check('The rules follow the cut: the Reel can go live, YouTube cannot yet', postGate({ edit: cutEdit(x, 'igReel') }, 'live').ok && !postGate({ edit: cutEdit(x, 'yt') }, 'live').ok);
  x = { ...x, ...setCut(x, 'igReel', 'start', { by: 'Rajesh' }, NOW + DAY, '').patch };
  check('Editing the Reel again keeps the first edit in its log', cutLog(x, 'igReel').length === 1 && cutEdit(x, 'igReel').status === 'active' && !x.forDone.igReel);
  // Cards from before cuts.
  check('A card\'s one old edit stands for each planned outlet', cutEdit({ forPlan: { yt: true }, edit: { status: 'active', by: 'R', startedAt: 1 } }, 'yt').status === 'active' && cutEdit({ forPlan: { igReel: true }, edit: { status: 'active', by: 'R', startedAt: 1 } }, 'yt').status === '');
  check('…and for the whole video ("Video") when no outlet was ever ticked', JSON.stringify(cutKeys({ edit: { status: 'active', by: 'R', startedAt: 1 } })) === '["all"]' && cutEdit({ edit: { status: 'active', by: 'R', startedAt: 1 } }, 'yt').status === 'active');
  check('…and a "made" tick reads as that cut done', cutEdit({ forPlan: { igStory: true }, forDone: { igStory: true } }, 'igStory').status === 'done');
  check('An unknown outlet is refused', !setCut(card, 'tiktok', 'plan', { by: 'R' }, NOW, '').ok);
}

// ── the review's cases: old cards read once, re-edits, cleared cuts ──
{
  // 1. An old "made" tick on a Live card is edited-before, not new work.
  const live = { forPlan: { igReel: true, yt: true }, forDone: { igReel: true, yt: true } };
  check('Live card with old made ticks: off the Editor view (no posts)', editColumn({ edit: cutEdit(live, 'yt') }, { stageKey: 'live', shot: true, posts: {} }) === null);
  check('…on the view when Posting has it scheduled', editColumn({ edit: cutEdit(live, 'yt') }, { stageKey: 'live', shot: true, posts: { total: 1, scheduled: 1 } }) === 'scheduled');
  // 2. An old edit means what it meant when first read: ticking YouTube later does not make YouTube done.
  const old = { forPlan: { igReel: true }, edit: { status: 'done', by: 'R', startedAt: 1, doneAt: 2 } };
  const m = materializeCuts(old);
  const after = { ...old, cuts: m, forPlan: { igReel: true, yt: true } };
  check('Read once: the old edit is the Reel\'s; YouTube ticked later is not edited', cutEdit(after, 'igReel').status === 'done' && cutEdit(after, 'yt').status === '');
  // 4. "Video": an old whole-card edit; work on it is what Posting reads for every outlet.
  const vid = { edit: { status: 'planned', by: 'R' } };
  let v = { ...vid, ...setCut(vid, 'all', 'start', {}, NOW, 'R').patch };
  v = { ...v, ...setCut(v, 'all', 'done', {}, NOW + H, 'R').patch };
  check('Video started and done: every outlet reads it as done', cutEdit(v, 'yt').status === 'done' && cutEdit(v, cutOfChannel(v, 'fbReel')).status === 'done');
  // 5. A cut cleared and no longer planned goes.
  let c5 = { forPlan: { yt: true } };
  c5 = { ...c5, ...setCut(c5, 'yt', 'plan', { by: 'R' }, NOW, '').patch };
  c5 = { ...c5, ...setCut(c5, 'yt', 'reset', {}, NOW, '').patch, forPlan: { yt: false } };
  check('Cleared and unticked: the cut goes', cutKeys(c5).length === 0);
  // 6. Edit again after an earlier post: waiting for its own post, not Posted.
  let r6 = { forPlan: { igReel: true } };
  r6 = { ...r6, ...setCut(r6, 'igReel', 'start', { by: 'R' }, NOW - 30 * DAY, '').patch };
  r6 = { ...r6, ...setCut(r6, 'igReel', 'done', {}, NOW - 29 * DAY, '').patch };
  r6 = { ...r6, ...setCut(r6, 'igReel', 'start', { by: 'R' }, NOW - H, '').patch };
  r6 = { ...r6, ...setCut(r6, 'igReel', 'done', {}, NOW, '').patch };
  const ctx6 = (liveAt) => ({ shot: true, now: NOW, stageKey: 'live', posts: { total: 1, live: 1, lastLiveAt: liveAt } });
  check('Re-edit after a post 20 days ago: Edit done (its own post to come)', editColumn({ edit: cutEdit(r6, 'igReel'), editLog: cutLog(r6, 'igReel') }, ctx6(NOW - 20 * DAY)) === 'done');
  check('…once posted after it: Posted', editColumn({ edit: cutEdit(r6, 'igReel'), editLog: cutLog(r6, 'igReel') }, ctx6(NOW - 60000)) === 'posted');
  // 7. An old edit under way wins over an old made tick.
  check('Old edit under way + old made tick: still being edited', cutEdit({ forPlan: { igReel: true }, forDone: { igReel: true }, edit: { status: 'active', by: 'R', startedAt: 1 } }, 'igReel').status === 'active');
  // 9. An old "Instagram" tick is folded into the Reel by any cut write.
  const ins = setCut({ forPlan: { insta: true }, forDone: { insta: true } }, 'igReel', 'reset', {}, NOW, '').patch;
  check('Old Instagram tick folded: Reel planned, not made after a reset', ins.forPlan.igReel && !ins.forPlan.insta && !ins.forDone.insta && !ins.forDone.igReel);
  // 10. An FB-only made tick does not make the Insta Reel done.
  check('FB made alone: the Reel + FB cut is not done', cutEdit({ forPlan: { igReel: true, fbReel: true }, forDone: { fbReel: true } }, 'igReel').status === '');
  // 11. The old edit counts once.
  const two = materializeCuts({ forPlan: { igReel: true, yt: true }, edit: { status: 'done', by: 'R', startedAt: 1, doneAt: 2 }, editLog: [{ by: 'R', startedAt: 0, doneAt: 1 }] });
  check('Old edit on two outlets: the second is a shared copy, the log on the first only', !two.igReel.shared && two.yt.shared && two.igReel.log.length === 1 && two.yt.log.length === 0);
}

// ── the second review's cases ──
{
  // 1. Planning one outlet on an old card keeps the others (plan dialog goes through setCut 'details').
  const old = { forPlan: { igReel: true, yt: true }, edit: { status: 'active', by: 'R', startedAt: 5 } };
  const r1 = setCut({ ...old, cuts: cutsView(old) }, 'yt', 'details', { by: 'A', planAt: 0, dueAt: 0, note: '' }, NOW, '');
  check('Plan one outlet of an old card: the other keeps its edit', r1.ok && r1.patch.cuts.igReel.status === 'active' && r1.patch.cuts.yt.status === 'active' && r1.patch.cuts.yt.by === 'A');
  // 2. shared is written every time (a merge save would keep an old true).
  check('…the outlet worked on is written shared: false', r1.patch.cuts.yt.shared === false);
  // 3. An old done edit wins over a bare "made" tick.
  const d3 = materializeCuts({ forPlan: { igReel: true }, forDone: { igReel: true }, edit: { status: 'done', by: 'Ravi', startedAt: 1, doneAt: 2 } });
  check('Old done edit + made tick: Ravi\'s edit kept', d3.igReel.by === 'Ravi' && d3.igReel.doneAt === 2);
  // 4. 'Video' split once: the outlet worked on takes the edit and its history, others are shared copies.
  const v = { edit: { status: 'done', by: 'R', startedAt: 1, doneAt: 2 }, editLog: [{ by: 'Z', startedAt: 0, doneAt: 1 }] };
  const vm = { ...v, cuts: materializeCuts(v), forPlan: { igReel: true, yt: true } };
  const r4 = setCut(vm, 'igReel', 'start', { by: 'R' }, NOW, '');
  const after = { ...vm, ...r4.patch };
  const items = Object.keys(cutsView(after)).filter(k => !cutShared(after, k)).map(k => ({ x: { id: 'v', edit: cutEdit(after, k), editLog: cutLog(after, k) }, title: k }));
  const t = editorTrack(items, NOW);
  const R = t.find(r => r.name === 'R'), Z = t.find(r => r.name === 'Z');
  check('Video split: R\'s old edit counted once, Z\'s once, the new start once', R.done.length === 1 && R.active.length === 1 && Z.done.length === 1, JSON.stringify(t.map(r => [r.name, r.done.length, r.active.length])));
  check('…YouTube still reads the old edit (a shared copy), Video emptied', cutEdit(after, 'yt').status === 'done' && cutShared(after, 'yt') && !cutEdit(after, 'all').status);
  const r4b = setCut(after, 'yt', 'plan', { by: 'A' }, NOW, '');
  check('…planning the shared YouTube copy: no history copied over', r4b.ok && r4b.patch.cuts.yt.log.length === 0 && r4b.patch.cuts.yt.shared === false);
  check('…ownCuts leaves a card with no Video alone', JSON.stringify(ownCuts({ cuts: { yt: { status: 'planned', by: 'A' } } }, 'igReel')) === JSON.stringify({ yt: { status: 'planned', by: 'A' } }));
  // 6. A first edit: a post live long before it is not this edit's.
  const first = { edit: { status: 'done', by: 'R', startedAt: NOW - H, doneAt: NOW } };
  check('First edit, Reel posted 60 days earlier: Edit done (its post to come)', editColumn(first, { shot: true, now: NOW, stageKey: 'live', posts: { total: 1, live: 1, lastLiveAt: NOW - 60 * DAY } }) === 'done');
  check('…posted 2 days before the edit was recorded: Posted', editColumn(first, { shot: true, now: NOW, stageKey: 'live', posts: { total: 1, live: 1, lastLiveAt: NOW - 2 * DAY } }) === 'posted');
  // 6b. The real TNagar series: posted in the morning, then edits recorded (a quick redo) that evening.
  const redo = { edit: { status: 'done', by: 'Rajesh', startedAt: NOW - 60000, doneAt: NOW }, editLog: [{ by: 'T', startedAt: 0, doneAt: NOW - 120000 }] };
  check('Edits recorded after the post went live (a redo): Posted', editColumn(redo, { shot: true, now: NOW, stageKey: 'media_ready', posts: { total: 1, live: 1, lastLiveAt: NOW - 8 * H } }) === 'posted');
  // 7. Re-planning Video does not tick an "all" outlet.
  const r7 = setCut({ edit: { status: 'planned', by: 'R' } }, 'all', 'details', { by: 'A' }, NOW, '');
  check('Re-plan Video: no forPlan.all', r7.ok && !('all' in r7.patch.forPlan));
  // 8. "Made" unticked: back a step, editor and days kept.
  let c8 = { forPlan: { yt: true } };
  c8 = { ...c8, ...setCut(c8, 'yt', 'start', { by: 'R', dueAt: NOW + DAY }, NOW - H, '').patch };
  c8 = { ...c8, ...setCut(c8, 'yt', 'done', {}, NOW, '').patch };
  const r8 = setCut(c8, 'yt', 'reopen', {}, NOW, '');
  check('Made unticked: being edited again by R, delivery kept, not made', r8.patch.cuts.yt.status === 'active' && r8.patch.cuts.yt.by === 'R' && r8.patch.cuts.yt.dueAt === NOW + DAY && !r8.patch.forDone.yt);
  const r8b = setCut({ forPlan: { yt: true }, forDone: { yt: true } }, 'yt', 'reopen', {}, NOW, '');
  check('…a bare made tick unticked: not planned', r8b.ok && r8b.patch.cuts.yt.status === '');
}

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
