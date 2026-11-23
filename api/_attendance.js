// ═══════ ATTENDANCE — server side ═══════
//
//   POST /api/attendance   (vercel.json rewrites it to bot-test-message?op=attendance: the Hobby plan
//                          allows 12 functions and all 12 are taken)
//   body { action, ... }, Authorization: Bearer <Firebase ID token>
//
// Actions — anyone on the team (agents included, when an admin switched their attendance on)
//   status         { day?: today } → my day: sessions, worked time, signed in or not, whether I am an
//                  attendance admin. The sign-in pop-up's one call.
//   sign-in        { source: 'popup' | 'page' } → opens a session now; alerts the attendance admins
//   sign-out       { source }                    → closes my open session now (today's, or one left
//                  open since yesterday — past midnight); alerts the admins
//   history        { from, to } → my days in that range (≤ 62)
// Actions — attendance admins (attendanceConfig.admins; Thirumal and Swami until changed)
//   board          { day } → everyone tracked, their day, and the alerts of that day I have not cleared
//   person         { uid, from, to } → one person's days
//   clear-alerts   { ids: [...] } or { all: true } → hides alerts from MY list (each admin clears their own)
//   set-tracked    { email, on } → keep (or stop keeping) a person's attendance
//   test-email     {} → a sample alert to the admins, clearly marked TEST
//   fix-out        { uid, day, inAt, time: 'HH:MM' } → a missed sign-out put right (that session's hours count)
//
// Every time is the server's clock (never the phone's), and the day is India's (attendance-core.js).
// The records live in collections the database rules never open to a browser (default deny):
//   attendance/{tenant}__{uid}__{day}     one person's day (see attendance-core.js for the shape)
//   attendanceConfig/{tenant}             { admins: [emails], tracked: { email: bool } }
//   attendanceSeen/{tenant}__{adminUid}   { day, clearedBefore, ids: [] } — what that admin cleared
//
// Firestore budget (free plan, 50K reads a day for the whole site): a sign-in or sign-out is 3–4
// reads; status 2; an admin's board is one read per person plus 3. No polling anywhere — the pages
// ask when opened or when someone taps.
import { getAuth } from 'firebase-admin/auth';
import { getDb, verifyCrmUser, sendEmail } from './_bot-shared.js';
import {
  dayOf, addDays, isDay, daysBetween, docId, clock, dayLabel, hm, summarise, liveMs,
  adminsOf, isTracked, alertLine, MIN_GAP_MS, MAX_RANGE_DAYS,
} from '../shared-assets/attendance-core.js';

const APP_URL = process.env.APP_URL || 'https://admin.threepin.in';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const lc = s => String(s || '').trim().toLowerCase();
const COL = 'attendance', CFG = 'attendanceConfig', SEEN = 'attendanceSeen';

// ── who is who ──
// The tests hand in their own team and mailer (no Auth emulator, no real e-mail).
let teamSource = null, mailer = sendEmail;
export const __setTeamSource = f => { teamSource = f; };
export const __setMailer = f => { mailer = f || sendEmail; };
async function teamUsers(tenantId) {
  if (teamSource) return (await teamSource()).filter(u => (u.customClaims || {}).tenantId === tenantId && u.email);
  const auth = getAuth();
  const out = [];
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    out.push(...page.users.filter(u => (u.customClaims || {}).tenantId === tenantId && u.email));
    token = page.pageToken;
  } while (token);
  return out;
}
const roleOf = u => (u.customClaims || {}).role || 'none';
const fallbackName = email => { const n = lc(email).split('@')[0] || ''; return n ? n[0].toUpperCase() + n.slice(1) : ''; };

async function loadConfig(db, tenantId) {
  const s = await db.collection(CFG).doc(tenantId).get();
  return s.exists ? s.data() : {};
}
// The name an admin gave this person (users/{uid}); their own account name, then their address, else.
async function nameFor(db, user) {
  try {
    const s = await db.collection('users').doc(user.uid).get();
    if (s.exists && s.data().name) return s.data().name;
  } catch (e) { /* fall through */ }
  return user.name || fallbackName(user.email);
}

// ── the alert e-mail ──
// One message to every attendance admin — Thirumal and Swami get every sign-in and sign-out, their
// own included (the owner asked for exactly that on 22 Nov): a coloured band (green in, red out), the
// sentence, the day's figures, and a button to the Attendance page.
export function alertEmail({ ev, rec, test = false }) {
  const isIn = ev.type === 'in';
  const colour = isIn ? '#1E8E3E' : '#C5221F';
  const tint = isIn ? '#E6F4EA' : '#FCE8E6';
  const icon = isIn ? '🟢' : '🔴';
  const verb = isIn ? 'signed in' : 'signed out';
  const who = ev.name || fallbackName(ev.email);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const subject = `${test ? '[TEST] ' : ''}${icon} ${who} ${verb} · ${clock(ev.at)}`;
  const lines = [
    ['Time', `${clock(ev.at)}, ${dayLabel(dayOf(ev.at))}`],
    rec && rec.firstIn ? ['First sign-in today', clock(rec.firstIn)] : null,
    rec ? [isIn ? 'Worked today before this' : 'Worked today', hm(rec.workedMs)] : null,
    rec && rec.sessions ? ['Sessions today', String(rec.sessions.length)] : null,
  ].filter(Boolean);
  const text = [
    test ? 'THIS IS A TEST MESSAGE FOR ATTENDANCE ALERTS.' : '',
    `${who} (${ev.email}) ${verb} now — ${clock(ev.at)}.`,
    ...lines.map(([k, v]) => `${k}: ${v}`),
    '', `Attendance: ${APP_URL}/attendance.html`,
  ].filter(s => s !== null).join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#F4F4F4;font-family:Arial,Helvetica,sans-serif;color:#212121">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #E0E0E0">
${test ? `<tr><td style="background:#FFF4E5;color:#8A4B00;font-size:13px;font-weight:bold;padding:10px 20px;border-bottom:1px solid #FFD8A8">TEST — this is a test message for attendance alerts</td></tr>` : ''}
<tr><td style="background:${colour};height:6px;line-height:6px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:22px 24px 6px">
  <div style="display:inline-block;background:${tint};color:${colour};font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;padding:4px 10px;border-radius:99px">${icon} Attendance alert · ${isIn ? 'Signed in' : 'Signed out'}</div>
  <h1 style="font-size:20px;line-height:1.35;margin:14px 0 4px;color:#212121">${esc(who)} ${verb} now — ${esc(clock(ev.at))}</h1>
  <div style="font-size:14px;color:#666666">${esc(ev.email)}</div>
</td></tr>
<tr><td style="padding:14px 24px 4px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F7;border-radius:8px">
  ${lines.map(([k, v]) => `<tr><td style="padding:9px 14px;font-size:13px;color:#666666">${esc(k)}</td><td align="right" style="padding:9px 14px;font-size:14px;font-weight:bold;color:#212121">${esc(v)}</td></tr>`).join('')}
  </table>
</td></tr>
<tr><td style="padding:18px 24px 24px">
  <a href="${APP_URL}/attendance.html" style="display:inline-block;background:#212121;color:#FFFFFF;text-decoration:none;font-weight:bold;font-size:14px;padding:11px 18px;border-radius:8px">Open Attendance</a>
</td></tr>
<tr><td style="padding:12px 24px;background:#FAFAFA;border-top:1px solid #EEEEEE;font-size:12px;color:#888888">3 PIN Realty · attendance alerts go to the attendance admins. You can clear alerts on the Attendance page.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

async function alertAdmins(cfg, actorEmail, ev, rec, test = false) {
  const to = adminsOf(cfg);
  if (!to.length) return { ok: true, to: [] };
  const m = alertEmail({ ev, rec, test });
  const r = await mailer(to.join(', '), m.subject, m.text, m.html);
  // Said in the log either way, so "was it sent?" can be answered from Vercel's runtime logs.
  console.log('attendance alert', ev.type, lc(actorEmail || ev.email), '→', to.join(', '), r.ok ? 'sent' : 'FAILED ' + r.error);
  return { ...r, to };
}

// ── my day ──
function present(rec, now = Date.now()) {
  if (!rec) return { sessions: [], workedMs: 0, liveMs: 0, open: false, openSince: null, firstIn: null, lastOut: null, events: [] };
  return {
    sessions: rec.sessions || [], workedMs: rec.workedMs || 0, liveMs: rec.day === dayOf(now) ? liveMs(rec, now) : rec.workedMs || 0,
    open: !!rec.open, openSince: rec.openSince || null, firstIn: rec.firstIn || null, lastOut: rec.lastOut || null,
    // Other event types (site visits, later) ride along for the screens that will show them.
    events: (rec.events || []).map(e => ({ id: e.id, type: e.type, at: e.at, source: e.source || '', missedOut: !!e.missedOut, by: e.by || '' })),
  };
}

async function status(db, user, cfg) {
  const day = dayOf();
  const snap = await db.collection(COL).doc(docId(user.tenantId, user.uid, day)).get();
  const rec = snap.exists ? snap.data() : null;
  return json({
    ok: true, day, now: Date.now(),
    tracked: isTracked(cfg, user.email, user.role || 'none'),
    isAdmin: adminsOf(cfg).includes(lc(user.email)),
    today: present(rec),
  });
}

// One event onto a day record, inside a transaction; the summary is recomputed from the events.
function withEvent(rec, base, ev) {
  const events = [...((rec && rec.events) || []), ev];
  return { ...base, ...(rec || {}), events, ...summarise(events), updatedAt: ev.at };
}

async function signIn(db, user, cfg, body) {
  if (!isTracked(cfg, user.email, user.role || 'none')) return json({ ok: false, error: 'Attendance isn’t kept for your login — ask an admin' }, 403);
  const now = Date.now();
  const day = dayOf(now);
  const name = await nameFor(db, user);
  const ref = db.collection(COL).doc(docId(user.tenantId, user.uid, day));
  const yRef = db.collection(COL).doc(docId(user.tenantId, user.uid, addDays(day, -1)));
  const source = ['popup', 'page'].includes(body.source) ? body.source : 'page';
  const ev = { id: `${user.uid.slice(0, 6)}-${now}`, type: 'in', at: now, source, by: lc(user.email) };
  const base = { tenantId: user.tenantId, uid: user.uid, email: lc(user.email), name, day };
  const out = await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const rec = s.exists ? s.data() : null;
    if (rec && rec.open) return { already: true, rec };
    const last = rec && rec.events && rec.events.length ? rec.events[rec.events.length - 1].at : 0;
    if (now - last < MIN_GAP_MS) return { tooSoon: true, rec };
    // A session left open since yesterday (they never signed out): closed as "no sign-out", so it
    // counts nothing rather than 20-odd hours, and the admins see it flagged.
    if (!rec) {
      const y = await tx.get(yRef);
      if (y.exists && y.data().open) {
        const yr = y.data();
        tx.set(yRef, withEvent(yr, {}, { id: `${user.uid.slice(0, 6)}-${now}-x`, type: 'out', at: now, source: 'auto', missedOut: true, by: 'system' }));
      }
    }
    const next = withEvent(rec, base, ev);
    next.name = name;
    tx.set(ref, next);
    return { rec: next };
  });
  if (out.already) return json({ ok: true, already: true, today: present(out.rec) });
  if (out.tooSoon) return json({ ok: false, error: 'You signed out less than a minute ago — wait a moment and try again' }, 429);
  const mail = await alertAdmins(cfg, user.email, { ...ev, name, email: lc(user.email) }, out.rec);
  return json({ ok: true, today: present(out.rec), emailed: !!mail.ok });
}

async function signOut(db, user, cfg, body) {
  const now = Date.now();
  const day = dayOf(now);
  const name = await nameFor(db, user);
  const refs = [db.collection(COL).doc(docId(user.tenantId, user.uid, day)), db.collection(COL).doc(docId(user.tenantId, user.uid, addDays(day, -1)))];
  const source = ['popup', 'page'].includes(body.source) ? body.source : 'page';
  const ev = { id: `${user.uid.slice(0, 6)}-${now}`, type: 'out', at: now, source, by: lc(user.email) };
  const out = await db.runTransaction(async tx => {
    const [t, y] = await Promise.all(refs.map(r => tx.get(r)));
    // Today's open session; else one still open from yesterday (signing out after midnight).
    const which = t.exists && t.data().open ? 0 : y.exists && y.data().open ? 1 : -1;
    if (which < 0) return { notIn: true, rec: t.exists ? t.data() : null };
    const rec = [t, y][which].data();
    const last = rec.events.length ? rec.events[rec.events.length - 1].at : 0;
    if (now - last < MIN_GAP_MS) return { tooSoon: true, rec };
    const next = withEvent(rec, {}, ev);
    tx.set(refs[which], next);
    return { rec: next, today: which === 0 ? next : (t.exists ? t.data() : null) };
  });
  if (out.notIn) return json({ ok: true, notIn: true, today: present(out.rec) });
  if (out.tooSoon) return json({ ok: false, error: 'You signed in less than a minute ago — wait a moment and try again' }, 429);
  const mail = await alertAdmins(cfg, user.email, { ...ev, name, email: lc(user.email) }, out.rec);
  return json({ ok: true, today: present(out.today), emailed: !!mail.ok });
}

function range(body) {
  const to = isDay(body.to) ? body.to : dayOf();
  const from = isDay(body.from) ? body.from : addDays(to, -6);
  if (from > to) return null;
  return daysBetween(from, to, MAX_RANGE_DAYS);
}
async function daysOf(db, tenantId, uid, days) {
  const snaps = await db.getAll(...days.map(d => db.collection(COL).doc(docId(tenantId, uid, d))));
  return days.map((d, i) => ({ day: d, ...present(snaps[i].exists ? snaps[i].data() : null) })).reverse();
}

async function history(db, user, body) {
  const days = range(body || {});
  if (!days) return json({ ok: false, error: 'Pick a start date before the end date' }, 400);
  return json({ ok: true, days: await daysOf(db, user.tenantId, user.uid, days) });
}

// ── admins ──
async function board(db, user, cfg, body) {
  const day = isDay(body.day) ? body.day : dayOf();
  const users = await teamUsers(user.tenantId);
  const rows = users.filter(u => !u.disabled).map(u => ({ uid: u.uid, email: lc(u.email), role: roleOf(u), tracked: isTracked(cfg, u.email, roleOf(u)), authName: u.displayName || '' }));
  const tracked = rows.filter(r => r.tracked);
  const [recs, profiles, seenSnap] = await Promise.all([
    tracked.length ? db.getAll(...tracked.map(r => db.collection(COL).doc(docId(user.tenantId, r.uid, day)))) : [],
    rows.length ? db.getAll(...rows.map(r => db.collection('users').doc(r.uid))) : [],
    db.collection(SEEN).doc(`${user.tenantId}__${user.uid}`).get(),
  ]);
  const nameOf = {};
  profiles.forEach(p => { if (p.exists && p.data().name) nameOf[p.id] = p.data().name; });
  const seen = seenSnap.exists ? seenSnap.data() : {};
  const clearedIds = new Set(seen.ids || []);
  const clearedBefore = seen.clearedBefore || 0;
  const people = tracked.map((r, i) => {
    const rec = recs[i] && recs[i].exists ? recs[i].data() : null;
    return { uid: r.uid, email: r.email, role: r.role, name: nameOf[r.uid] || (rec && rec.name) || r.authName || fallbackName(r.email), day, ...present(rec) };
  }).sort((a, b) => (b.open - a.open) || ((a.firstIn || 9e15) - (b.firstIn || 9e15)) || a.name.localeCompare(b.name));
  // The alerts: every sign-in and sign-out of that day (the admin's own too), newest first, minus what
  // this admin cleared.
  const alerts = [];
  people.forEach(p => p.events.forEach(e => {
    if (!['in', 'out'].includes(e.type)) return;
    if (e.at <= clearedBefore || clearedIds.has(e.id)) return;
    alerts.push({ id: e.id, type: e.type, at: e.at, uid: p.uid, name: p.name, email: p.email, missedOut: e.missedOut, source: e.source,
      text: e.missedOut ? `${p.name} didn’t sign out — closed when they next signed in` : alertLine({ ...e, name: p.name }, e.type === 'out' ? { workedMs: workedUpTo(p.events, e.at) } : {}) });
  }));
  alerts.sort((a, b) => b.at - a.at);
  return json({
    ok: true, day, today: dayOf(), now: Date.now(), people, alerts,
    everyone: rows.map(r => ({ uid: r.uid, email: r.email, role: r.role, name: nameOf[r.uid] || r.authName || fallbackName(r.email), tracked: r.tracked })).sort((a, b) => a.name.localeCompare(b.name)),
    admins: adminsOf(cfg),
  });
}
// Hours worked by the end of a given sign-out (for "signed out at 6:10 pm — 8h 02m today").
function workedUpTo(events, at) { return summarise(events.filter(e => e.at <= at)).workedMs; }

async function person(db, user, body) {
  const uid = String(body.uid || '');
  const days = range(body || {});
  if (!uid || !days) return json({ ok: false, error: 'Pick a person and a date range' }, 400);
  const target = (await teamUsers(user.tenantId)).find(u => u.uid === uid);
  if (!target) return json({ ok: false, error: 'No such person on this team' }, 404);
  const prof = await db.collection('users').doc(uid).get();
  const name = (prof.exists && prof.data().name) || target.displayName || fallbackName(target.email);
  const list = await daysOf(db, user.tenantId, uid, days);
  return json({ ok: true, uid, email: lc(target.email), name, days: list, totalMs: list.reduce((a, d) => a + (d.liveMs || 0), 0) });
}

async function clearAlerts(db, user, body) {
  const ref = db.collection(SEEN).doc(`${user.tenantId}__${user.uid}`);
  const today = dayOf();
  if (body.all) {
    await ref.set({ day: today, clearedBefore: Date.now(), ids: [] });
    return json({ ok: true });
  }
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(s => /^[\w-]{3,40}$/.test(s)).slice(0, 50);
  if (!ids.length) return json({ ok: false, error: 'Nothing to clear' }, 400);
  await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const cur = s.exists ? s.data() : {};
    // Ids are kept for a few days only; older alerts are cleared by date (clearedBefore) anyway.
    const keep = (cur.ids || []).slice(-400);
    tx.set(ref, { day: today, clearedBefore: cur.clearedBefore || 0, ids: [...new Set([...keep, ...ids])] });
  });
  return json({ ok: true });
}

// An admin puts right a sign-out that was missed: { uid, day, inAt, time: 'HH:MM' } — the session that
// began at inAt on that day ends at that time (India). A session closed as "no sign-out" gets the
// real time (and its hours count); one still open on a past day is closed at it. The change is kept
// on the event (fixedBy, fixedAt, was) so it shows as a correction.
async function fixOut(db, user, body) {
  const uid = String(body.uid || ''), day = String(body.day || ''), inAt = Number(body.inAt);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(body.time || ''));
  if (!uid || !isDay(day) || !inAt || !m) return json({ ok: false, error: 'Say whose day, which session and the time' }, 400);
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return json({ ok: false, error: 'That is not a time' }, 400);
  const [y, mo, d] = day.split('-').map(Number);
  let at = Date.UTC(y, mo - 1, d, hh, mm) - 5.5 * 3600000;
  // Earlier than the sign-in: past midnight only when that makes a shift of 12 hours or less
  // (signed in 8 pm, out "1:00" = 1 am); otherwise it is a time before they came in.
  if (at <= inAt) {
    if (at + 86400000 - inAt <= 12 * 3600000) at += 86400000;
    else return json({ ok: false, error: 'That is before they signed in (' + clock(inAt) + ')' }, 400);
  }
  if (at > Date.now()) return json({ ok: false, error: 'That time has not come yet' }, 400);
  const ref = db.collection(COL).doc(docId(user.tenantId, uid, day));
  const res = await db.runTransaction(async tx => {
    const s0 = await tx.get(ref);
    if (!s0.exists) return { error: 'No attendance that day', status: 404 };
    const rec = s0.data();
    if (rec.tenantId !== user.tenantId) return { error: 'No attendance that day', status: 404 };
    const events = [...(rec.events || [])].sort((a, b) => a.at - b.at);
    const i = events.findIndex(e => e.type === 'in' && e.at === inAt);
    if (i < 0) return { error: 'That session is not there any more — reload', status: 409 };
    const next = events.slice(i + 1).find(e => e.type === 'in');
    if (next && at >= next.at) return { error: 'They signed in again at ' + clock(next.at) + ' — pick a time before that', status: 400 };
    const j = events.findIndex((e, k) => k > i && e.type === 'out' && (!next || e.at < next.at || e.missedOut));
    const fix = { fixedBy: lc(user.email), fixedAt: Date.now() };
    if (j >= 0) {
      const old = events[j];
      if (!old.missedOut && old.source !== 'auto') return { error: 'This session already has a sign-out — it is only for a missed one', status: 409 };
      events[j] = { ...old, at, missedOut: false, source: 'admin', was: old.at, ...fix };
    } else {
      events.push({ id: `${uid.slice(0, 6)}-${at}-f`, type: 'out', at, source: 'admin', by: lc(user.email), ...fix });
    }
    const out = { ...rec, events, ...summarise(events), updatedAt: Date.now() };
    tx.set(ref, out);
    return { rec: out };
  });
  if (res.error) return json({ ok: false, error: res.error }, res.status);
  return json({ ok: true, day: { day, ...present(res.rec) } });
}

async function setTracked(db, user, body) {
  const email = lc(body.email);
  if (!email || typeof body.on !== 'boolean') return json({ ok: false, error: 'Say who, and on or off' }, 400);
  const users = await teamUsers(user.tenantId);
  if (!users.some(u => lc(u.email) === email)) return json({ ok: false, error: 'No such person on this team' }, 404);
  await db.collection(CFG).doc(user.tenantId).set({ tracked: { [email]: body.on }, updatedBy: lc(user.email), updatedAt: Date.now() }, { merge: true });
  return json({ ok: true, email, tracked: body.on });
}

async function testEmail(cfg, body) {
  const now = Date.now();
  const ev = { type: body.type === 'out' ? 'out' : 'in', at: now, name: String(body.name || 'Pradeep').slice(0, 40), email: lc(body.email || 'pradeep@threepin.in') };
  const rec = { firstIn: now, workedMs: 0, sessions: [{ in: now, out: null }] };
  const r = await alertAdmins(cfg, '', ev, rec, true);
  return json({ ok: !!r.ok, to: r.to, error: r.ok ? undefined : r.error }, r.ok ? 200 : 502);
}

const ADMIN = { board: 1, person: 1, 'clear-alerts': 1, 'set-tracked': 1, 'test-email': 1, 'fix-out': 1 };

export async function attendancePost(request) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  const user = await verifyCrmUser(request, { allowAgent: true });
  if (!user || !user.tenantId || !user.email) return json({ ok: false, error: 'Sign in again' }, 401);
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  return attendanceAct(user, body);
}

// user: the verified token ({ uid, email, email_verified, tenantId, role }).
export async function attendanceAct(user, body = {}) {
  const db = getDb();
  const cfg = await loadConfig(db, user.tenantId);
  const action = String(body.action || '');
  try {
    if (action === 'status') return await status(db, user, cfg);
    if (action === 'sign-in') return await signIn(db, user, cfg, body);
    if (action === 'sign-out') return await signOut(db, user, cfg, body);
    if (action === 'history') return await history(db, user, body);
    if (ADMIN[action]) {
      if (!user.email_verified || !adminsOf(cfg).includes(lc(user.email))) return json({ ok: false, error: 'Only the attendance admins can see this' }, 403);
      if (action === 'board') return await board(db, user, cfg, body);
      if (action === 'person') return await person(db, user, body);
      if (action === 'clear-alerts') return await clearAlerts(db, user, body);
      if (action === 'set-tracked') return await setTracked(db, user, body);
      if (action === 'fix-out') return await fixOut(db, user, body);
      if (action === 'test-email') return await testEmail(cfg, body);
    }
    return json({ ok: false, error: 'Unknown action' }, 400);
  } catch (e) {
    console.error('attendance', action, e);
    return json({ ok: false, error: 'Something went wrong — try again' }, 500);
  }
}
export const __test = { present, withEvent };
