// ═══════════════════════════════════════════════════════════════════════
// EDIT FLOW — from a shoot to a scheduled post, as the editor sees it.
//
// Pure, dependency-free ES module (same shape as track-pipeline.js), shared by the board's Editor
// view, the Posting tab and the tests.
//
// The board's columns follow a PROPERTY through getting listed. The Editor view follows the same
// cards through the editor's day instead — same data, other columns:
//
//   Shoot planned → Shoot done → Planned to edit → Editing → Edit done → Post scheduled → Posted
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
  { key: 'scheduled', label: 'Post scheduled', hint: 'In Posting with a date and time' },
  { key: 'posted', label: 'Posted', hint: 'Live — shown for a week, then it leaves the view' }
];
export const POSTED_FOR = 7 * 86400000;   // how long a posted card stays in view
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
// action: 'plan' ({ by, planAt }) · 'start' ({ by }) · 'done' · 'reset' (back to not planned) · 'assign' ({ by })
//   · 'details' ({ by, planAt, dueAt, note } — the status kept) · 'reopen' (done taken back a step).
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
    case 'details':
      // Planned or being edited: who, which day, delivered by when, the note — where it stands is kept.
      if (e.status !== EDIT_STATUS.PLANNED && e.status !== EDIT_STATUS.ACTIVE) return setEdit(x, 'plan', o, now, who);
      if (!by) return { ok: false, error: 'Pick who edits it.' };
      if (num(o.dueAt) && num(o.planAt) && num(o.dueAt) < num(o.planAt)) return { ok: false, error: 'The delivery date is before the edit day.' };
      next = { ...e, by, planAt: num(o.planAt), dueAt: num(o.dueAt), note: str(o.note !== undefined ? o.note : e.note) };
      break;
    case 'reopen':
      // Done taken back: being edited again if it was, else planned — its editor and days kept. A bare
      // "made" tick (no editor, no time) goes back to not planned.
      if (e.status !== EDIT_STATUS.DONE) return { ok: false, error: 'Not done.' };
      next = !e.by && !e.startedAt ? normalizeEdit(null)
        : { ...e, status: e.startedAt ? EDIT_STATUS.ACTIVE : EDIT_STATUS.PLANNED, doneAt: 0 };
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
    // It follows Posting: a post with a time → Post scheduled; one only planned for a day → waiting
    // to be scheduled; posted since this edit → Posted (for a week after, then off the view).
    if (p.scheduled) return 'scheduled';
    // Only a "made" tick from before (no editor, no time) on a card already live or media-ready: edited
    // before this view existed — not new work waiting to be scheduled.
    if (!e.doneAt && !e.by && (c.stageKey === 'live' || c.stageKey === 'media_ready')) return null;
    if (p.planned) return c.stageKey === 'closed' ? null : 'done';
    // A post that went live after this edit began counts (a few days' grace, for a post confirmed before
    // the edit was recorded; an old "made" tick has no time — any post). A re-edit whose earlier round was
    // posted (the last post came after it): only a post after that earlier edit — that one was not this
    // cut's. An earlier edit with no post after it (recorded late, or a quick redo) is not a round of its own.
    const prev = editLogOf(x)[0], start = e.startedAt || e.doneAt;
    const since = prev && p.lastLiveAt > prev.doneAt ? Math.max(prev.doneAt, start - 86400000) : start ? start - 3 * 86400000 : 0;
    const after = p.lastLiveAt && p.lastLiveAt > since;
    if (after) return (c.now || Date.now()) - p.lastLiveAt < POSTED_FOR ? 'posted' : null;
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
  if (col === 'posted') return { at: 0, what: '', late: false, today: false, soon: false, rank: Infinity };
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

// ── Cuts: one edit per outlet ──
// A property is edited per outlet — the Reel on Monday, YouTube on Thursday — and posted per outlet. A
// CUT is one property × one outlet, with its own edit (the same record as above) kept on the card:
//   cuts: { igStory|igReel|fbReel|yt|collab: { status, by, planAt, dueAt, startedAt, doneAt, note, log } }
// The FB Reel is the Insta Reel's video unless the card says otherwise (fbOwnCut): then it is a cut of
// its own. "Made" on the card's Shoot for is that cut's edit done; the two are kept the same.
// A card from before cuts: its one edit stands for each outlet planned on it, and a "made" tick is done.
export const CUTS = [['igStory', 'Insta Story'], ['igReel', 'Insta Reel'], ['fbReel', 'FB Reel'], ['yt', 'YouTube'], ['collab', 'Collab']];
export const CUT_SHORT = { igStory: 'Story', igReel: 'Reel', fbReel: 'FB Reel', yt: 'YouTube', collab: 'Collab', all: 'Video' };
// 'all': a card edited before outlets were split, with no outlet ticked — its one edit stands for every
// outlet (it shows as "Video") until outlets are planned.
const ALL_CHANNELS = ['igStory', 'igReel', 'fbReel', 'yt'];
export const fbOwnCut = x => !!(x && x.fbOwnCut);
export const cutOfChannel = (x, ch) => (ch === 'fbReel' && !fbOwnCut(x) ? 'igReel' : ch);
export function channelsOfCut(x, k) {
  if (k === 'collab') return [];
  if (k === 'all') return ALL_CHANNELS;
  if (k === 'igReel') return fbOwnCut(x) ? ['igReel'] : ['igReel', 'fbReel'];
  return [k];
}
export const cutLabel = (x, k) => (k === 'igReel' && !fbOwnCut(x) ? 'Reel + FB' : CUT_SHORT[k] || k);
const outletPlanned = (x, k) => !!(x && x.forPlan && (x.forPlan[k] || (k === 'igReel' && x.forPlan.insta)));
const outletMade = (x, k) => !!(x && x.forDone && (x.forDone[k] || (k === 'igReel' && x.forDone.insta)));
// Is this cut wanted at all: planned on Shoot for (a folded FB Reel counts for the Reel's cut).
export const cutPlanned = (x, k) => outletPlanned(x, k) || (k === 'igReel' && !fbOwnCut(x) && outletPlanned(x, 'fbReel'));
// The outlets a cut stands for that are planned (its own key always).
const cutOutlets = (x, k) => (k === 'collab' ? ['collab'] : k === 'all' ? [] : channelsOfCut(x, k).filter(ch => ch === k || outletPlanned(x, ch)));

// ── A card from before cuts, read ONCE into cuts ──
// What its old single edit, its log and its Shoot for "made" ticks mean per outlet, as the card stands
// right now. The board writes this onto the card the first time the card is changed (materializeCuts),
// so a later tick never changes what an old edit meant. Until then it is read the same way, every time.
//   · an old edit (planned, being edited or done): it is each planned outlet's (it wins over a tick)
//   · else every planned outlet of the cut "made": done (a tick — no editor, no time)
//   · nothing ticked: the old edit stands for the whole video ('all', shown as "Video")
// The old edit and its log count once (the first outlet); its copies are marked shared.
export function legacyCuts(x) {
  const old = editOf(x), log = editLogOf(x), out = {};
  const keys = CUTS.map(c => c[0]).filter(k => !(k === 'fbReel' && !fbOwnCut(x)) && cutPlanned(x, k));
  let used = false;
  for (const k of keys) {
    const outs = cutOutlets(x, k);
    const made = outs.length > 0 && outs.every(ch => outletMade(x, ch));
    let rec = null;
    if (old.status) {
      rec = { ...old, log: used ? [] : log };
      if (used) rec.shared = true;
      used = true;
    } else if (made) rec = { ...normalizeEdit({ status: EDIT_STATUS.DONE }), log: [] };
    if (rec) out[k] = rec;
  }
  if (!keys.length && (old.status || log.length)) out.all = { ...old, log };
  else if (log.length && !used && keys.length) out[keys[0]] = { ...(out[keys[0]] || normalizeEdit(null)), log };
  return out;
}
// The cuts as they are: the card's own once written, else read from its old fields.
export const cutsView = x => (x && x.cuts && typeof x.cuts === 'object' ? x.cuts : legacyCuts(x || {}));
// For the board, before its first change to a card from before cuts: the cuts to write (null: none needed).
export function materializeCuts(x) {
  if (!x || (x.cuts && typeof x.cuts === 'object')) return null;
  const c = legacyCuts(x);
  return Object.keys(c).length ? c : null;
}
const cutRecord = (x, k) => { const v = cutsView(x)[k]; return v && typeof v === 'object' ? v : null; };
// An outlet without an edit of its own, on a card whose old edit stood for the whole video: that edit.
const recordFor = (x, k) => cutRecord(x, k) || (k !== 'all' ? cutRecord(x, 'all') : null);
export function cutEdit(x, k) { return normalizeEdit(recordFor(x, k)); }
export const cutLog = (x, k) => editLogOf({ editLog: (recordFor(x, k) || {}).log });
export const cutShared = (x, k) => !!(cutRecord(x, k) || {}).shared;
// The cuts a card has: planned on Shoot for, with an edit under way or done, or with a post in Posting
// (postChannels: the channels with a planned, scheduled or live post), in the outlets' order. A cut
// cleared and no longer planned goes. "Video" only while no outlet is.
export function cutKeys(x, postChannels) {
  const posts = new Set(postChannels || []), keys = new Set();
  for (const [k] of CUTS) {
    if (k === 'fbReel' && !fbOwnCut(x)) continue;
    const rec = cutRecord(x, k);
    if (cutPlanned(x, k) || (rec && rec.status && !rec.shared) || channelsOfCut(x, k).some(ch => posts.has(ch))) keys.add(k);
  }
  const out = CUTS.map(c => c[0]).filter(k => keys.has(k));
  if (!out.length && (cutRecord(x, 'all') || {}).status) return ['all'];
  return out;
}
// One cut moved along (setEdit's steps). Returns { ok, patch } for the card — every cut (an old card's
// read into cuts in the same write), and Shoot for kept the same: the cut's outlets planned, "made"
// while its edit is done; an old "Instagram" tick folded into the Reel.
// The cuts, with outlet k holding a record of its own. On a card whose old edit stood for the whole video
// ('all'), the first outlet worked on splits it: k takes the old edit and its history, every other outlet
// a copy marked shared (counted once), and 'all' is emptied — each outlet then moves on its own.
export function ownCuts(x, k) {
  const base = { ...cutsView(x) }, all = base.all;
  if (k === 'all' || cutRecord(x, k) || !all || !(all.status || (all.log || []).length)) return base;
  for (const [c] of CUTS) {
    if (c === 'fbReel' && !fbOwnCut(x)) continue;
    if (!base[c]) base[c] = c === k ? { ...all, shared: false } : { ...all, log: [], shared: true };
  }
  base.all = { ...normalizeEdit(null), log: [], shared: true };
  return base;
}
export function setCut(x, k, action, opts, now, who) {
  if (k !== 'all' && !CUTS.some(c => c[0] === k)) return { ok: false, error: 'Unknown outlet' };
  const base = ownCuts(x, k), rec = base[k] || {};
  const r = setEdit({ edit: rec, editLog: rec.log }, action, opts, now, who);
  if (!r.ok) return r;
  // A copy of an edit counted on another outlet: what it held is not this outlet's history.
  if (rec.shared) r.editLog = [];
  const fold = m => { const o = { ...((x && x[m]) || {}) }; if (o.insta) { o.igReel = true; o.insta = false; } return o; };
  const forDone = fold('forDone'), forPlan = fold('forPlan');
  for (const ch of (k === 'collab' ? ['collab'] : k === 'all' ? [] : channelsOfCut(x, k))) {
    if (action !== 'reset' && (ch === k || forPlan[ch])) forPlan[ch] = true;
    if (ch === k || forPlan[ch]) forDone[ch] = r.edit.status === EDIT_STATUS.DONE;
  }
  // shared written every time: the save merges into the stored card, and an old true would stay.
  return { ok: true, edit: r.edit, patch: { cuts: { ...base, [k]: { ...r.edit, log: r.editLog, shared: false } }, forDone, forPlan } };
}

// ── The two checks: is the edit planned, is the post planned ──
// An editor can edit in free time and the post be scheduled later, or the post day be fixed first:
// either can come first. But a post with a time needs its edit planned, and goes live only once the
// edit is done (postGate). posts = { scheduled, planned } from the Posting tab (not yet live).
export const editPlanned = x => !!editOf(x).status;
// No edit recorded, but edited before this view existed — the same reading editColumn makes: a card in
// Live, or in Media ready with nothing left to cut, or one made from the Posting tab for its brochure.
// ctx = { stageKey, cutsLeft } (the board's edCtx).
export function editedBefore(x, ctx) {
  if (editOf(x).status) return false;
  const c = ctx || {};
  return c.stageKey === 'live' || (c.stageKey === 'media_ready' && !c.cutsLeft) || (!!x && x.source === 'posting');
}
export function checks(x, ctx) {
  const p = (ctx && ctx.posts) || {}, e = editOf(x), before = editedBefore(x, ctx);
  const edit = !!e.status || before;
  const post = (p.scheduled || 0) + (p.planned || 0) > 0;
  return { edit, editDone: e.status === EDIT_STATUS.DONE || before, post, gap: post && !edit ? 'edit' : edit && !post ? 'post' : '' };
}
// May this post be scheduled with a time ('schedule') / marked live ('live')? A property with no board
// card (no edit record) is not held back.
export function postGate(x, action, ctx) {
  if (!x || editedBefore(x, ctx)) return { ok: true };
  const e = editOf(x);
  if (action === 'live' && e.status !== EDIT_STATUS.DONE) return { ok: false, need: 'done', text: e.status ? 'The edit is not done yet — a post goes live once its edit is done.' : 'The edit is not marked done — a post goes live once its edit is done.' };
  if (action === 'schedule' && !e.status) return { ok: false, need: 'plan', text: 'The edit is not planned — a post with a time needs its edit planned.' };
  return { ok: true };
}

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
