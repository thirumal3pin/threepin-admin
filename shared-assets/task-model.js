// ═══════════════════════════════════════════════════════════════════════
// TASKS — the one definition of what a task is and who may do what with it.
//
// Pure, dependency-free ES module, imported by every place that touches a task: the CRM's Tasks
// page and Daily task (crm.html bridges it to window.PinTaskModel), the Settings → Configurations
// section that sets who sees whose (track-assets), and the server that sends the emails
// (api/followup-digest.js). One copy, so the page, the emails and the tests cannot disagree.
//
// ── THE RULES (set by the owner, 15 Oct 2026) ─────────────────────────
//   • Managers (Thirumal and Swami to start with; Settings → Configurations) assign tasks, see
//     every task, and decide who can see whose.
//   • A task has a primary person and any secondary people. Each of them sees it and may change
//     everything on it EXCEPT who it is assigned to (that stays with the managers).
//   • Anyone else sees a task only when a manager has let them see one of its people's tasks
//     (cfg.viewers[viewer] = [people]) — and then only to read it.
//   • Email: the people it is assigned to when it is assigned (or they are added); the people on
//     it plus the managers when its status changes; each person their due and overdue tasks in
//     the morning.
//
// The database enforces the same (firestore.rules, match /tasks): the page never shows what the
// rules would refuse, and the rules refuse what the page does not offer. Visibility is stored on
// each task as `visibleTo` keys "tenant|email", so a person's query and the rule that guards it
// read one field.
// ═══════════════════════════════════════════════════════════════════════

export const STATUSES = [['todo', 'Yet to start'], ['doing', 'In Progress'], ['done', 'Completed']];
// No prototype: a status of 'constructor' (written by hand) is simply unknown, never a function's text.
export const STATUS_LABEL = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(STATUSES)));
// Who assigns, until someone changes it in Settings → Configurations.
export const DEFAULT_MANAGERS = ['thirumal@threepin.in', 'swami@threepin.in'];
export const MAX_SECONDARY = 5;
export const MAX_TITLE = 140;
export const MAX_DESCRIPTION = 4000;
export const MAX_HISTORY = 60;
// The fields a person the task is assigned to may change (and the rules allow them to).
export const ASSIGNEE_FIELDS = ['title', 'description', 'status', 'due', 'link', 'updatedAt', 'updatedBy', 'statusAt', 'completedAt', 'history'];

export const lc = s => String(s == null ? '' : s).trim().toLowerCase();
const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));
const uniq = list => [...new Set(list)];

// ── The configuration ──

/** The managers: from the saved configuration, or the starting pair when there is none. */
export function managersOf(cfg) {
  const m = cfg && Array.isArray(cfg.managers) ? uniq(cfg.managers.map(lc).filter(isEmail)) : [];
  return m.length ? m : DEFAULT_MANAGERS.slice();
}
export function isManager(cfg, email) {
  const e = lc(email);
  return !!e && managersOf(cfg).includes(e);
}
/** Whose tasks this person may see, besides their own (a manager sees everyone's). */
export function canViewPeople(cfg, viewer) {
  const v = lc(viewer);
  const map = (cfg && cfg.viewers) || {};
  const list = Array.isArray(map[v]) ? map[v] : [];
  return uniq(list.map(lc).filter(e => isEmail(e) && e !== v));
}
/** A configuration tidied for saving: lower-case, valid emails, no one set to see themselves. */
export function normaliseConfig(cfg) {
  const viewers = {};
  const raw = (cfg && cfg.viewers) || {};
  for (const [k, v] of Object.entries(raw)) {
    const key = lc(k);
    if (!isEmail(key)) continue;
    const list = canViewPeople({ viewers: { [key]: v } }, key);
    if (list.length) viewers[key] = list;
  }
  return { managers: managersOf(cfg), viewers };
}

// ── A task's people and who sees it ──

/** Everyone the task is assigned to: the primary first, then the secondaries. */
export function assigneesOf(task) {
  const t = task || {};
  const sec = Array.isArray(t.secondary) ? t.secondary : [];
  return uniq([t.primary, ...sec].map(lc).filter(isEmail));
}
export const visKey = (tenantId, email) => String(tenantId || '') + '|' + lc(email);
/** The visibleTo keys a task carries: its people, and everyone allowed to see any of them. */
export function visibleToFor(task, cfg, tenantId) {
  const people = assigneesOf(task);
  const map = (cfg && cfg.viewers) || {};
  const viewers = Object.keys(map).filter(v => canViewPeople(cfg, v).some(p => people.includes(p)));
  return uniq([...people, ...viewers.map(lc)]).filter(isEmail).sort().map(e => visKey(tenantId, e));
}
export function isAssignee(task, email) { return assigneesOf(task).includes(lc(email)); }
export function canSee(task, cfg, email) {
  const e = lc(email);
  if (!e) return false;
  if (isManager(cfg, e) || isAssignee(task, e)) return true;
  const sees = canViewPeople(cfg, e);
  return assigneesOf(task).some(p => sees.includes(p));
}
/** What this person may do with this task. */
export function rightsFor(task, cfg, email) {
  const mgr = isManager(cfg, email);
  const mine = !!task && isAssignee(task, email);
  return {
    create: mgr,
    edit: mgr || mine,              // title, description, status, due date, link
    reassign: mgr,                  // primary and secondary
    remove: mgr,
    view: !task || canSee(task, cfg, email)
  };
}

// ── Due dates ──
// A due date is a day ("2026-10-20"), due by the end of that day in India, wherever the code runs
// (the server runs in UTC).
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function dueAtOf(due) {
  if (!DUE_RE.test(String(due || ''))) return null;
  const t = Date.parse(due + 'T23:59:59+05:30');
  return isFinite(t) ? t : null;
}
export function istDay(ts) { return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
/**
 * Where a task stands against its date: 'done', 'overdue', 'today', 'week' (by the end of the
 * coming Sunday), 'later', or 'none' (no date).
 */
export function dueBucket(task, now) {
  const t = task || {};
  if (t.status === 'done') return 'done';
  const at = dueAtOf(t.due);
  if (at == null) return 'none';
  const n = now == null ? Date.now() : now;
  const today = istDay(n);
  if (t.due < today) return 'overdue';
  if (t.due === today) return 'today';
  return at - n <= 7 * 86400000 ? 'week' : 'later';
}
export function isOpen(task) { return !!task && task.status !== 'done'; }

/** Open tasks first — overdue, then by due date, undated last — then completed, newest first. */
export function sortTasks(list, now) {
  const rank = { overdue: 0, today: 1, week: 2, later: 3, none: 4, done: 5 };
  return (list || []).slice().sort((a, b) => {
    const ra = rank[dueBucket(a, now)], rb = rank[dueBucket(b, now)];
    if (ra !== rb) return ra - rb;
    if (ra === 5) return (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0);
    const da = dueAtOf(a.due) || Infinity, db = dueAtOf(b.due) || Infinity;
    if (da !== db) return da - db;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

// ── Writing a task ──

/** What is wrong with a task before it is saved, as sentences; empty when it is fine. */
export function problemsWith(task) {
  const t = task || {}, out = [];
  if (!String(t.title || '').trim()) out.push('Give the task a title.');
  if (String(t.title || '').length > MAX_TITLE) out.push(`Keep the title under ${MAX_TITLE} characters.`);
  if (String(t.description || '').length > MAX_DESCRIPTION) out.push('The description is too long.');
  if (!isEmail(t.primary)) out.push('Choose who the task is for.');
  const sec = Array.isArray(t.secondary) ? t.secondary : [];
  if (sec.length > MAX_SECONDARY) out.push(`At most ${MAX_SECONDARY} secondary people.`);
  if (sec.map(lc).includes(lc(t.primary))) out.push('The primary person cannot also be a secondary.');
  if (!STATUS_LABEL[t.status]) out.push('Pick a status.');
  if (t.due && !DUE_RE.test(String(t.due))) out.push('The due date is not a date.');
  return out;
}

/** One line for the task's own history. */
export const historyEntry = (by, text, at) => ({ at: at || Date.now(), by: lc(by), text: String(text || '').slice(0, 300) });
export function withHistory(history, entry) {
  const h = Array.isArray(history) ? history.slice() : [];
  h.push(entry);
  return h.slice(-MAX_HISTORY);
}

/** What changed between two versions of a task, in words — for its history and the emails. */
export function changesBetween(before, after, nameOf) {
  const name = nameOf || (e => e);
  const b = before || {}, a = after || {}, out = [];
  if ((b.title || '') !== (a.title || '')) out.push('title changed');
  if ((b.description || '') !== (a.description || '')) out.push('description changed');
  if (b.status !== a.status) out.push(`status ${STATUS_LABEL[b.status] || '—'} → ${STATUS_LABEL[a.status] || '—'}`);
  if ((b.due || '') !== (a.due || '')) out.push(a.due ? `due ${a.due}` : 'due date removed');
  if (lc(b.primary) !== lc(a.primary)) out.push(`now for ${name(a.primary)}`);
  const bs = (b.secondary || []).map(lc).sort().join(), as = (a.secondary || []).map(lc).sort().join();
  if (bs !== as) out.push('secondary people changed');
  const bl = b.link ? b.link.kind + ':' + b.link.id : '', al = a.link ? a.link.kind + ':' + a.link.id : '';
  if (bl !== al) out.push(al ? `linked to ${a.link.label || a.link.id}` : 'link removed');
  return out;
}

// ── Who is emailed ──

/**
 * The people an event emails, never the person who caused it.
 *   'assigned' — the people just put on the task (`added`; all of them for a new task)
 *   'status'   — everyone on the task, and the managers
 */
export function recipientsFor(event, task, cfg, actor, added) {
  const me = lc(actor);
  const people = assigneesOf(task);
  let to = [];
  if (event === 'assigned') to = (Array.isArray(added) ? added : people).map(lc).filter(e => people.includes(e));
  else if (event === 'status') to = [...people, ...managersOf(cfg)];
  return uniq(to).filter(e => isEmail(e) && e !== me);
}

/** Each person's open tasks that are due today or late, for their morning email. */
export function morningListFor(tasks, now) {
  const by = {};
  for (const t of tasks || []) {
    const b = dueBucket(t, now);
    if (b !== 'overdue' && b !== 'today') continue;
    for (const p of assigneesOf(t)) (by[p] = by[p] || []).push(t);
  }
  for (const k of Object.keys(by)) by[k] = sortTasks(by[k], now);
  return by;
}
