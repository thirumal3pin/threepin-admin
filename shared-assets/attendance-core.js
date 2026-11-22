// ═══════ ATTENDANCE — the rules, in one place ═══════
//
// Pure functions shared by the server (api/_attendance.js), the Attendance page, the sign-in pop-up
// and the tests: no Firestore, no DOM. Everything time-related is India time (Asia/Kolkata), whatever
// the clock of the server or the phone says.
//
// ── The record ──
// One document per person per day, attendance/{tenantId}__{uid}__{YYYY-MM-DD}:
//   { tenantId, uid, email, name, day,
//     events:   [{ id, type, at, source, ... }]   — everything that happened, in order (the log)
//     sessions: [{ in, out, missedOut? }]           — signed-in stretches, worked out from the events
//     workedMs, open, firstIn, lastOut, updatedAt } — the summary the lists read
// `events` is deliberately a typed log, not just sign-in/out pairs: site visits, a location, a task
// done are later new event types on the same day record, read by the same screens. Only 'in' and
// 'out' change the sessions; any other type is carried along untouched (see summarise()).

export const TZ = 'Asia/Kolkata';
export const PROMPT_HOUR = 7;              // the sign-in pop-up offers itself from 7 am India time
export const MIN_GAP_MS = 60 * 1000;       // a second tap within a minute is refused (no double alerts)
export const MAX_RANGE_DAYS = 62;          // the longest history read at once
export const DEFAULT_ADMINS = ['thirumal@threepin.in', 'swami@threepin.in'];
export const SESSION_TYPES = ['in', 'out'];

const pad = n => String(n).padStart(2, '0');
const parts = (t, opts) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts })
  .formatToParts(new Date(t)).map(p => [p.type, p.value]));

// 'YYYY-MM-DD' of the India day a moment falls in.
export function dayOf(t = Date.now()) {
  const p = parts(t, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}
// The India hour (0–23) of a moment — for "after 7 am".
export function hourOf(t = Date.now()) {
  return Number(parts(t, { hour: '2-digit', hour12: false }).hour) % 24;
}
// The day before / after a 'YYYY-MM-DD' (calendar arithmetic, no time zone involved).
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}
export const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && addDays(String(s), 0) === String(s);
// Every day from `from` to `to`, both included (capped).
export function daysBetween(from, to, cap = MAX_RANGE_DAYS) {
  const out = [];
  for (let d = from; d <= to && out.length < cap; d = addDays(d, 1)) out.push(d);
  return out;
}
export const docId = (tenantId, uid, day) => `${tenantId}__${uid}__${day}`;

// "9:42 am" in India time.
export function clock(t) {
  if (!t) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(t)).replace(/\s?([ap])\.?m\.?/i, ' $1m');
}
// "Sat 22 Nov" for a 'YYYY-MM-DD'.
export function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(y, m - 1, d)));
}
// "7h 05m", "45m", "0m".
export function hm(ms) {
  const mins = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${pad(m)}m` : `${m}m`;
}

// The sessions and totals a day's events add up to. An 'in' while already in, or an 'out' while out,
// is ignored (the server refuses both; this keeps a hand-edited record sane). A session left open
// stays open: it counts towards "worked so far" only for the day it is still today (liveMs), and a
// session closed with `missedOut` (they never signed out; the next sign-in closed it) counts nothing.
export function summarise(events = []) {
  const sessions = [];
  let cur = null;
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.type === 'in' && !cur) { cur = { in: e.at, out: null }; sessions.push(cur); }
    else if (e.type === 'out' && cur) { cur.out = e.at; if (e.missedOut) cur.missedOut = true; cur = null; }
  }
  const workedMs = sessions.reduce((a, s) => a + (s.out && !s.missedOut ? s.out - s.in : 0), 0);
  const ins = events.filter(e => e.type === 'in').map(e => e.at);
  const outs = events.filter(e => e.type === 'out' && !e.missedOut).map(e => e.at);
  return {
    sessions,
    workedMs,
    open: !!cur,
    openSince: cur ? cur.in : null,
    firstIn: ins.length ? Math.min(...ins) : null,
    lastOut: outs.length ? Math.max(...outs) : null,
  };
}
// Worked time including a session still open now (for today's figure).
export const liveMs = (rec, now = Date.now()) => (Number(rec && rec.workedMs) || 0) + (rec && rec.open && rec.openSince != null ? Math.max(0, now - rec.openSince) : 0);

// Who an attendance admin is: the list saved in attendanceConfig, else Thirumal and Swami.
export function adminsOf(cfg) {
  const list = Array.isArray(cfg && cfg.admins) && cfg.admins.length ? cfg.admins : DEFAULT_ADMINS;
  return [...new Set(list.map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
}
// Whether a person's attendance is kept: everyone on the team except agents (outside brokers), unless
// an admin switched that person on or off (attendanceConfig.tracked[email] = true | false).
export function isTracked(cfg, email, role) {
  const o = cfg && cfg.tracked && cfg.tracked[String(email || '').toLowerCase()];
  if (o === true || o === false) return o;
  return role !== 'agent';
}

// The plain words of an alert, used by the e-mail and the in-app list alike.
export function alertLine(ev, rec = {}) {
  const who = ev.name || ev.email || 'Someone';
  const verb = ev.type === 'in' ? 'signed in' : 'signed out';
  const tail = ev.type === 'out' && rec.workedMs != null ? ` — ${hm(rec.workedMs)} today` : '';
  return `${who} ${verb} at ${clock(ev.at)}${tail}`;
}
