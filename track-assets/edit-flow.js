// ═══════════════════════════════════════════════════════════════════════
// EDIT FLOW — from a shoot to a scheduled post, as the editor sees it.
//
// Pure, dependency-free ES module (same shape as track-pipeline.js), shared by the board's Editor
// view, the Posting tab and the tests.
//
// The board's columns follow a PROPERTY through getting listed. The Editor view follows the same
// cards through the editor's day instead — same data, other columns:
//
//   Shoot planned → Shoot done → Planned to edit → Editing → Edit done → Post scheduled
//
// The first two are read from the shoot, the last from the Posting tab; the middle three are the
// editor's own, kept on the card:
//
//   edit:    { status: ''|'planned'|'active'|'done', by, planAt, dueAt, startedAt, doneAt, note }
//            planAt = the day it is planned to be edited, dueAt = when the edit is expected delivered
//   editLog: [{ by, startedAt, doneAt, note }]   earlier edits of the same card (a re-edit, a new cut),
//                                                newest first — the editor's track keeps them.
//
// A series card goes through the same columns: its "shoot" is done once every property in it is shot.
// ═══════════════════════════════════════════════════════════════════════

export const EDIT_STATUS = { NONE: '', PLANNED: 'planned', ACTIVE: 'active', DONE: 'done' };
export const EDIT_LABEL = { '': 'Not planned', planned: 'Planned to edit', active: 'Editing', done: 'Edit done' };

export const ED_COLS = [
  { key: 'shoot_planned', label: 'Shoot planned', hint: 'Booked, not shot yet' },
  { key: 'shoot_done', label: 'Shoot done', hint: 'Shot — the edit is not planned yet' },
  { key: 'planned', label: 'Planned to edit / post', hint: 'Edit planned, or a post day fixed in Posting — deliver by the earlier' },
  { key: 'active', label: 'Editing', hint: 'Being edited right now' },
  { key: 'done', label: 'Edit done', hint: 'Ready — schedule it in Posting' },
  { key: 'scheduled', label: 'Post scheduled', hint: 'In Posting with a date and time' }
];
export const ED_KEYS = ED_COLS.map(c => c.key);
// The columns a card can be dragged into: the editor's own. The others are read, never set.
export const ED_DROP = { planned: 'plan', active: 'start', done: 'done', shoot_done: 'reset' };

const str = v => (v == null ? '' : String(v).trim());
const num = v => Number(v) || 0;

export function normalizeEdit(e) {
  const s = e && Object.values(EDIT_STATUS).includes(e.status) ? e.status : EDIT_STATUS.NONE;
  return {
    status: s, by: str(e && e.by), note: str(e && e.note),
    planAt: s ? num(e && e.planAt) : 0,
    dueAt: s ? num(e && e.dueAt) : 0,
    startedAt: s === EDIT_STATUS.ACTIVE || s === EDIT_STATUS.DONE ? num(e && e.startedAt) : 0,
    doneAt: s === EDIT_STATUS.DONE ? num(e && e.doneAt) : 0
  };
}
export const editOf = x => normalizeEdit(x && x.edit);
export function editLogOf(x) {
  return (Array.isArray(x && x.editLog) ? x.editLog : [])
    .map(l => ({ by: str(l && l.by), startedAt: num(l && l.startedAt), doneAt: num(l && l.doneAt), note: str(l && l.note) }))
    .filter(l => l.doneAt);
}

// ── Moving an edit along ──
// action: 'plan' ({ by, planAt }) · 'start' ({ by }) · 'done' · 'reset' (back to not planned) · 'assign' ({ by }).
// A finished edit that is planned or started again is a new edit: the finished one goes to the log
// first, so nothing done is ever lost. Returns { ok, edit, editLog } or { ok:false, error }.
export function setEdit(x, action, opts, now, who) {
  const e = editOf(x), o = opts || {};
  let log = editLogOf(x);
  const by = str(o.by) || e.by || str(who);
  const archive = () => { if (e.status === EDIT_STATUS.DONE && e.doneAt) log = [{ by: e.by, startedAt: e.startedAt, doneAt: e.doneAt, note: e.note }, ...log].slice(0, 50); };
  let next;
  switch (action) {
    case 'plan':
      if (!by) return { ok: false, error: 'Pick who edits it.' };
      if (num(o.dueAt) && num(o.planAt) && num(o.dueAt) < num(o.planAt)) return { ok: false, error: 'The delivery date is before the edit day.' };
      archive();
      next = { status: EDIT_STATUS.PLANNED, by, planAt: num(o.planAt), dueAt: num(o.dueAt), startedAt: 0, doneAt: 0, note: str(o.note !== undefined ? o.note : e.status === EDIT_STATUS.DONE ? '' : e.note) };
      break;
    case 'start': {
      if (!by) return { ok: false, error: 'Pick who edits it.' };
      if (e.status === EDIT_STATUS.ACTIVE) return { ok: false, error: 'Already being edited.' };
      const fresh = e.status === EDIT_STATUS.DONE;
      archive();
      next = { status: EDIT_STATUS.ACTIVE, by, planAt: fresh ? 0 : e.planAt, dueAt: fresh ? num(o.dueAt) : (num(o.dueAt) || e.dueAt), startedAt: now, doneAt: 0, note: fresh ? '' : e.note };
      break;
    }
    case 'done':
      if (e.status === EDIT_STATUS.DONE) return { ok: false, error: 'Already done.' };
      if (!by) return { ok: false, error: 'Pick who edited it.' };
      next = { status: EDIT_STATUS.DONE, by, planAt: e.planAt, dueAt: e.dueAt, startedAt: e.startedAt || 0, doneAt: now, note: str(o.note !== undefined ? o.note : e.note) };
      break;
    case 'assign':
      if (!e.status) return setEdit(x, 'plan', { by: o.by, planAt: 0 }, now, who);
      next = { ...e, by: str(o.by) };
      break;
    case 'reset':
      next = { status: EDIT_STATUS.NONE, by: '', planAt: 0, dueAt: 0, startedAt: 0, doneAt: 0, note: '' };
      archive();
      break;
    default: return { ok: false, error: 'Unknown step' };
  }
  return { ok: true, edit: next, editLog: log };
}

// ── Which Editor column a card is in ──
// ctx = { stageKey, shot, shootPlanned, cutsLeft, posts: { total, scheduled, live, planned, lastLiveAt } }
//   shot          the shoot is done (a series: every property in it is shot)
//   shootPlanned  a shoot is booked (a series: a property is still to be shot)
//   cutsLeft      cuts planned on the card's Shoot for and not made yet — work still to edit
//   posts         this property's posts in the Posting tab (scheduled = with a time, not live yet)
// null = not in the editor's world: nothing booked yet, finished long ago, on hold or dropped.
export function editColumn(x, ctx) {
  const c = ctx || {}, e = editOf(x), p = c.posts || {};
  const parked = ['on_hold', 'dropped'].includes(c.stageKey);
  if (e.status === EDIT_STATUS.ACTIVE) return 'active';      // being edited shows wherever the card is
  if (parked) return null;
  if (e.status === EDIT_STATUS.PLANNED) return 'planned';
  if (e.status === EDIT_STATUS.DONE) {
    if (p.scheduled) return 'scheduled';
    // A post planned for a day (another round, say) and the video is ready: schedule it.
    if (p.planned) return c.stageKey === 'closed' ? null : 'done';
    // Posted since this edit (a post live after it started): a past edit now. A post that went live
    // before it — an earlier round — does not count: this cut is still waiting to go out.
    if (p.lastLiveAt && p.lastLiveAt >= (e.startedAt || e.doneAt)) return null;
    return c.stageKey === 'closed' ? null : 'done';
  }
  if (c.stageKey === 'closed') return null;
  if (!c.shot) return c.shootPlanned ? 'shoot_planned' : null;
  // Shot, edit never recorded. A card already live from before the editor's view existed is not new
  // work — its posts with a time are taken as edited. Otherwise a post planned or scheduled in Posting
  // puts it in "Planned to edit / post": the post day is fixed, the edit has to be planned for it.
  if (c.stageKey === 'live') return p.scheduled ? 'scheduled' : null;
  // Every post out and nothing left to cut: done before. A cut still to make is still work.
  if (p.total && p.live >= p.total && !c.cutsLeft) return null;
  // Already in Media ready with every planned cut made: edited before this view existed.
  if (c.stageKey === 'media_ready' && !c.cutsLeft) return p.scheduled ? 'scheduled' : null;
  if (p.scheduled || p.planned) return 'planned';
  return 'shoot_done';
}

// ── What to do first ──
// The deadline for a card's next piece of work, and how close it is — so an editor can work the
// nearest first. ctx as for editColumn, plus shootAt and postAt (the next post: its time, or its
// planned day). Before the shoot the shoot date leads; after it, the edit is due by its delivery date
// or the post day, whichever comes first. A done edit waiting on Posting is measured to its post.
//   { at, what: 'shoot'|'delivery'|'post', late, today, soon (within soonDays, default 2), rank }   rank: smaller = sooner
export function priority(x, ctx, now, soonDays) {
  const c = ctx || {}, e = editOf(x), col = c.column || editColumn(x, c);
  const soonN = soonDays == null ? 2 : Math.max(0, Number(soonDays) || 0);
  const day0 = startOfDay(now);
  let at = 0, what = '';
  if (col === 'shoot_planned') { at = num(c.shootAt); what = 'shoot'; }
  else if (col === 'done' || col === 'scheduled') { at = num(c.postAt); what = 'post'; }
  else if (col) {
    const due = e.dueAt, post = num(c.postAt);
    if (due && (!post || due <= post)) { at = due; what = 'delivery'; }
    else if (post) { at = post; what = 'post'; }
  }
  if (!at) return { at: 0, what: '', late: false, today: false, soon: false, rank: Infinity };
  // A shoot or a scheduled post has a time: late once it has passed. A delivery date, or a post only
  // planned for a day (ctx.postTimed false), is a day: late the day after.
  const byDay = what === 'delivery' || (what === 'post' && c.postTimed === false);
  const late = byDay ? startOfDay(at) < day0 : at < now && col !== 'scheduled';
  const today = !late && startOfDay(at) === day0;
  return { at, what, late, today, soon: !late && !today && startOfDay(at) <= day0 + soonN * 86400000, rank: at };
}
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

// ── The editor's track: what each editor is on, has coming, and has done ──
// items = [{ x, title, column }] (column from editColumn). Done includes every logged edit.
// Editors are keyed by name as written (case-insensitive); '' = not assigned.
export function editorTrack(items, now) {
  const by = new Map();
  const get = name => {
    const k = str(name).toLowerCase();
    if (!by.has(k)) by.set(k, { name: str(name), active: [], planned: [], done: [], hours: 0, timed: 0 });
    return by.get(k);
  };
  for (const it of items || []) {
    const e = editOf(it.x);
    if (e.status === EDIT_STATUS.ACTIVE) get(e.by).active.push({ id: it.x.id, title: it.title, since: e.startedAt, planAt: e.planAt });
    else if (e.status === EDIT_STATUS.PLANNED) get(e.by).planned.push({ id: it.x.id, title: it.title, planAt: e.planAt });
    const done = [...(e.status === EDIT_STATUS.DONE ? [e] : []), ...editLogOf(it.x)];
    for (const d of done) {
      const r = get(d.by);
      r.done.push({ id: it.x.id, title: it.title, startedAt: d.startedAt, doneAt: d.doneAt });
      if (d.startedAt && d.doneAt > d.startedAt) { r.hours += (d.doneAt - d.startedAt) / 3600000; r.timed++; }
    }
  }
  const week = now - 7 * 86400000;
  return [...by.values()].map(r => ({
    ...r,
    active: r.active.sort((a, b) => a.since - b.since),
    planned: r.planned.sort((a, b) => (a.planAt || Infinity) - (b.planAt || Infinity)),
    done: r.done.sort((a, b) => b.doneAt - a.doneAt),
    doneWeek: r.done.filter(d => d.doneAt >= week).length,
    avgHours: r.timed ? r.hours / r.timed : 0
  })).sort((a, b) => (!a.name) - (!b.name) || b.active.length - a.active.length || b.planned.length - a.planned.length || a.name.localeCompare(b.name));
}

// "2h 10m", "35m", "3d 4h" — how long something has run.
export function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  return Math.floor(h / 24) + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
}
