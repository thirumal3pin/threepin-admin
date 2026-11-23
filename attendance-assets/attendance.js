// ═══════ ATTENDANCE (attendance.html) ═══════
// Everyone: sign in and out (as many times a day as needed), today's sessions and hours, the last
// 7 days. The attendance admins (Thirumal and Swami): everyone's day, the sign-in / sign-out alerts
// to clear, one person's history, and whose attendance is kept. Everything goes through the server
// (api/_attendance.js), which keeps the time — the phone's clock is never trusted.
//
// No polling: the page asks when opened, when tapped, and when it comes back into view (at most every
// 2 minutes). The "worked today" figure ticks on the device between asks.
//
// Modern Web Guidance applied: state on the row ("In since 9:42 am"), everything in place (clearing an
// alert, switching someone's attendance) with no pop-up, secondary content in <details>, real buttons
// with 44px targets on touch screens, a list that adapts to its container rather than the window.
import { $, esc, whenSignedIn, toast, openSheet, busy, auth } from '../shared-assets/agent-client.js';
import { dayOf, clock, dayLabel, hm, addDays, liveMs } from '../shared-assets/attendance-core.js';
import { rememberSignedIn } from '../shared-assets/attendance-prompt.js';

const me = await whenSignedIn();
window.AppNav.boot({ console: 'attendance', select: () => {}, signOut: () => import('../shared-assets/agent-client.js').then(m => m.signOutHere()) });
window.AppNav.setUser(me.email);
window.AppNav.setActive('attendance');

async function att(action, body = {}) {
  const token = await auth.currentUser.getIdToken();
  const r = await fetch('/api/attendance', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) { const e = new Error(j.error || 'Something went wrong — try again'); e.status = r.status; throw e; }
  return j;
}

let S = null;          // my status
let B = null;          // the admins' board
let statusAt = 0, boardAt = 0;
const skew = () => (S ? S.now - S.fetchedAt : 0);
const now = () => Date.now() + skew();   // the server's clock, as near as we can tell

// ── me ──
function sessionRows(sessions, open) {
  if (!sessions.length) return '';
  return `<ol class="at-sess">${sessions.map(s => {
    const end = s.out ? clock(s.out) : 'now';
    const dur = s.missedOut ? 'no sign-out' : hm((s.out || now()) - s.in);
    return `<li${!s.out ? ' class="live"' : ''}><span>${clock(s.in)} – ${end}</span><b>${dur}</b></li>`;
  }).join('')}</ol>`;
}

function drawMe() {
  $('meDate').textContent = dayLabel(dayOf(now()));
  if (!S) return;
  const t = S.today || {};
  if (!S.tracked) {
    $('meBody').innerHTML = `<p class="note">Attendance isn’t kept for your login. Ask an admin if it should be.</p>`;
    return;
  }
  const worked = hm(liveMs({ workedMs: t.workedMs, open: t.open, openSince: t.openSince }, now()));
  $('meBody').innerHTML = `
    <div class="at-state ${t.open ? 'in' : 'out'}">
      <span class="at-dot" aria-hidden="true"></span>
      <span>${t.open ? `Signed in since <b>${clock(t.openSince)}</b>` : t.sessions && t.sessions.length ? `Signed out${t.lastOut ? ' at <b>' + clock(t.lastOut) + '</b>' : ''}` : 'Not signed in yet today'}</span>
    </div>
    <div class="at-big"><span class="at-worked" id="worked">${worked}</span><span class="at-lbl">worked today</span></div>
    <button type="button" class="btn at-go ${t.open ? 'stop' : 'primary'}" id="go">
      <i class="fa-solid ${t.open ? 'fa-right-from-bracket' : 'fa-right-to-bracket'}" aria-hidden="true"></i> ${t.open ? 'Sign out' : 'Sign in'}
    </button>
    <div class="at-err" role="alert" id="meErr"></div>
    ${sessionRows(t.sessions || [], t.open)}
    <p class="note at-foot">You can sign in and out as many times as you need. Your hours are the time between each sign-in and sign-out.</p>`;
  $('go').addEventListener('click', e => busy(e.currentTarget, toggle));
}

async function toggle() {
  const out = S.today && S.today.open;
  $('meErr').textContent = '';
  try {
    const r = await att(out ? 'sign-out' : 'sign-in', { source: 'page' });
    S.today = r.today; S.now = Date.now(); S.fetchedAt = Date.now();
    if (!out) rememberSignedIn(me.uid);
    drawMe();
    toast(r.already ? 'You were already signed in' : r.notIn ? 'You weren’t signed in' : out ? `Signed out at ${clock(r.today.lastOut || Date.now())}` : `Signed in at ${clock(r.today.openSince || Date.now())}`);
    if ($('hist').open) loadHistory();
    if (S.isAdmin && (!$('day').value || $('day').value === dayOf(now()))) loadBoard(true);
  } catch (e) {
    const el = $('meErr'); if (el) el.textContent = e.message;
  }
}

async function loadStatus() {
  try {
    const r = await att('status');
    S = { ...r, fetchedAt: Date.now() };
    if (r.today && r.today.sessions && r.today.sessions.length) rememberSignedIn(me.uid);
    statusAt = Date.now();
    drawMe();
    if (S.isAdmin) { $('admin').hidden = false; if (!$('day').value) $('day').value = S.day; loadBoard(!!B); }
  } catch (e) {
    $('meBody').innerHTML = `<div class="empty"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>Couldn’t load your attendance — ${esc(e.message)} <button type="button" class="btn sm" id="retry">Try again</button></div>`;
    $('retry').addEventListener('click', loadStatus);
  }
}

// ── my last 7 days ──
function dayRows(days, { person = false } = {}) {
  if (!days.length) return '<p class="note">Nothing yet.</p>';
  return `<ul class="at-days">${days.map(d => {
    const missed = (d.sessions || []).some(s => s.missedOut);
    const none = !(d.sessions || []).length;
    return `<li class="${none ? 'none' : ''}">
      <span class="at-dl">${esc(dayLabel(d.day))}</span>
      <span class="at-io">${none ? '—' : `${clock(d.firstIn)} → ${d.open ? (d.day === dayOf(now()) ? 'now' : '<em>no sign-out</em>') : clock(d.lastOut) || '—'}`}${missed ? ' <span class="tag wait">forgot to sign out</span>' : ''}</span>
      <b class="at-h2">${none ? '' : hm(d.liveMs)}</b>
      ${!none && d.sessions.length > 1 ? `<span class="at-sc">${d.sessions.length} sessions</span>` : ''}
      ${person ? fixRows(d) : ''}
    </li>`;
  }).join('')}</ul>`;
}
// For the attendance admins, in one person's days: each session that lost its sign-out (closed as
// "forgot to sign out", or still open on a past day) gets a time to put it right — its hours then count.
function fixRows(d) {
  const today = dayOf(now());
  const broken = (d.sessions || []).filter(x => x.missedOut || (!x.out && d.day !== today));
  if (!broken.length) return '';
  return `<div class="at-fixes">${broken.map(x => `<form class="at-fix" data-day="${esc(d.day)}" data-in="${x.in}">
      <label>Signed in ${clock(x.in)} — signed out at <input type="time" required aria-label="Sign-out time for the session from ${clock(x.in)}"></label>
      <button type="submit" class="btn sm">Save</button><span class="err" role="alert"></span></form>`).join('')}</div>`;
}
async function loadHistory() {
  $('histBody').innerHTML = '<div class="sk"></div><div class="sk"></div>';
  try {
    const r = await att('history', { from: addDays(dayOf(now()), -6), to: dayOf(now()) });
    const total = r.days.reduce((a, d) => a + (d.liveMs || 0), 0);
    $('histBody').innerHTML = dayRows(r.days) + `<p class="at-total">Total: <b>${hm(total)}</b></p>`;
  } catch (e) { $('histBody').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
$('hist').addEventListener('toggle', () => { if ($('hist').open) loadHistory(); });

// ── admins: the team's day ──
function stateOf(p) {
  if (p.open) return ['in', `In since ${clock(p.openSince)}`];
  if (p.sessions && p.sessions.length) return ['out', p.sessions.some(s => s.missedOut) && !p.lastOut ? 'Didn’t sign out' : `Out at ${clock(p.lastOut)}`];
  return ['none', B && B.day === B.today ? 'Not signed in yet' : 'Absent'];
}
function drawBoard() {
  if (!B) return;
  const isToday = B.day === B.today;
  const counts = { in: 0, out: 0, none: 0 };
  B.people.forEach(p => { counts[stateOf(p)[0]]++; });
  $('sum').innerHTML = `
    <span class="at-pill in"><span class="at-dot" aria-hidden="true"></span>${isToday ? 'In now' : 'Still in'} <b>${counts.in}</b></span>
    <span class="at-pill out"><span class="at-dot" aria-hidden="true"></span>Signed out <b>${counts.out}</b></span>
    <span class="at-pill none"><span class="at-dot" aria-hidden="true"></span>${isToday ? 'Not in yet' : 'Absent'} <b>${counts.none}</b></span>`;
  $('people').innerHTML = B.people.length ? B.people.map(p => {
    const [cls, words] = stateOf(p);
    const worked = p.open && isToday ? liveMs(p, now()) : p.liveMs;
    return `<li class="at-p ${cls}">
      <button type="button" class="at-prow" data-uid="${esc(p.uid)}" aria-label="${esc(p.name)} — ${esc(words)}. Open their days">
        <span class="at-pn"><b>${esc(p.name)}</b><small>${esc(p.email)}</small></span>
        <span class="at-ps"><span class="at-dot" aria-hidden="true"></span>${esc(words)}</span>
        <span class="at-pt">${p.firstIn ? `${clock(p.firstIn)} → ${p.open ? (isToday ? 'now' : '…') : clock(p.lastOut) || '—'}` : '—'}</span>
        <span class="at-pw"><b data-live="${p.open && isToday ? p.uid : ''}">${p.sessions.length ? hm(worked) : '—'}</b>${p.sessions.length > 1 ? `<small>${p.sessions.length} sessions</small>` : ''}</span>
        <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
      </button></li>`;
  }).join('') : '<li class="empty">Nobody’s attendance is kept yet.</li>';
  $('people').querySelectorAll('.at-prow').forEach(b => b.addEventListener('click', () => personSheet(b.dataset.uid)));
  drawAlerts();
  $('adminList').textContent = B.admins.join(' and ');
  $('tracked').innerHTML = B.everyone.map(p => `<li><label class="chk"><input type="checkbox" data-email="${esc(p.email)}" ${p.tracked ? 'checked' : ''}>
      <span class="lb"><b>${esc(p.name)}</b> <small>${esc(p.email)}${p.role === 'agent' ? ' · agent' : p.role === 'admin' ? ' · admin' : ''}</small></span></label></li>`).join('');
  $('tracked').querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', async () => {
    cb.disabled = true;
    try { await att('set-tracked', { email: cb.dataset.email, on: cb.checked }); toast(cb.checked ? 'Attendance kept' : 'Attendance no longer kept'); loadBoard(true); }
    catch (e) { cb.checked = !cb.checked; toast(e.message); }
    finally { cb.disabled = false; }
  }));
}

function drawAlerts() {
  const list = B.alerts || [];
  $('alertN').textContent = list.length;
  $('alertN').classList.toggle('has', list.length > 0);
  $('clearAll').hidden = !list.length;
  $('alerts').innerHTML = list.length ? list.map(a => `<li class="at-a ${a.missedOut ? 'warn' : a.type}">
      <span class="at-aic" aria-hidden="true">${a.missedOut ? '⚠️' : a.type === 'in' ? '🟢' : '🔴'}</span>
      <span class="at-at"><b>${esc(a.text)}</b><small>${esc(a.email)}${a.source === 'popup' ? ' · from the morning pop-up' : ''}</small></span>
      <button type="button" class="at-x" data-id="${esc(a.id)}" aria-label="Clear this alert"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    </li>`).join('') : `<li class="at-none">No new alerts${B.day === B.today ? ' today' : ' for this day'}.</li>`;
  $('alerts').querySelectorAll('.at-x').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.id;
    const keep = B.alerts;
    B.alerts = B.alerts.filter(a => a.id !== id);
    drawAlerts();
    try { await att('clear-alerts', { ids: [id] }); }
    catch (e) { B.alerts = keep; drawAlerts(); toast(e.message); }
  }));
}
$('clearAll').addEventListener('click', e => busy(e.currentTarget, async () => {
  try { await att('clear-alerts', { all: true }); B.alerts = []; drawAlerts(); toast('Alerts cleared'); }
  catch (err) { toast(err.message); }
}));

async function loadBoard(quiet = false) {
  if (!quiet || !B) $('people').innerHTML = '<li><div class="sk"></div><div class="sk"></div><div class="sk"></div></li>';
  try {
    B = await att('board', { day: $('day').value || undefined });
    boardAt = Date.now();
    $('day').max = B.today;
    drawBoard();
  } catch (e) {
    $('people').innerHTML = `<li class="empty">Couldn’t load the team — ${esc(e.message)}</li>`;
  }
}
$('day').addEventListener('change', () => loadBoard());
$('refresh').addEventListener('click', e => busy(e.currentTarget, () => loadBoard(true)));

// One person's days, in a sheet: the last 7 or 30 days, each day's first in, last out and hours.
async function personSheet(uid, span = 7) {
  const p = (B.people || []).find(x => x.uid === uid) || {};
  const close = openSheet(`<div class="at-sh"><div><h3>${esc(p.name || 'Attendance')}</h3><p class="sub">${esc(p.email || '')}</p></div>
      <button type="button" class="btn sm" data-close aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
    <div class="seg at-span" role="group" aria-label="Show">
      <button type="button" data-span="7" aria-pressed="${span === 7}">7 days</button>
      <button type="button" data-span="30" aria-pressed="${span === 30}">30 days</button>
    </div>
    <div id="psBody"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>`, { label: 'Attendance of ' + (p.name || ''), wide: true });
  document.querySelectorAll('.at-span button').forEach(b => b.addEventListener('click', () => { close(); setTimeout(() => personSheet(uid, Number(b.dataset.span)), 50); }));
  try {
    const to = B.today;
    const r = await att('person', { uid, from: addDays(to, -(span - 1)), to });
    const worked = r.days.filter(d => d.sessions.length).length;
    const el = document.getElementById('psBody');
    if (el) el.innerHTML = `<div class="at-psum"><span><b>${hm(r.totalMs)}</b> worked</span><span><b>${worked}</b> of ${r.days.length} days</span><span><b>${worked ? hm(r.totalMs / worked) : '—'}</b> a day on average</span></div>` + dayRows(r.days, { person: true });
    // Putting a missed sign-out right: saved, the sheet shows the day again with its hours.
    if (el) el.querySelectorAll('form.at-fix').forEach(f => f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const btn = f.querySelector('button'), err = f.querySelector('.err'), t = f.querySelector('input').value;
      err.textContent = '';
      await busy(btn, async () => {
        try {
          await att('fix-out', { uid, day: f.dataset.day, inAt: Number(f.dataset.in), time: t });
          toast('Sign-out set to ' + t);
          close(); setTimeout(() => personSheet(uid, span), 50);
          if (B && f.dataset.day === B.day) loadBoard(true);
        } catch (e2) { err.textContent = e2.message; }
      });
    }));
  } catch (e) { const el = document.getElementById('psBody'); if (el) el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

$('testMail').addEventListener('click', e => busy(e.currentTarget, async () => {
  try { const r = await att('test-email'); toast('Test alert sent to ' + r.to.join(', ')); }
  catch (err) { toast(err.message); }
}));

// The morning pop-up (on another page) signed me in: show it if this page is open too.
document.addEventListener('pin-attendance', e => { if (S) { S.today = e.detail; drawMe(); } });

// The clock: worked-today figures move on between server asks.
setInterval(() => {
  if (S && S.today && S.today.open) { const w = $('worked'); if (w) w.textContent = hm(liveMs(S.today, now())); }
  if (B && B.day === B.today) document.querySelectorAll('[data-live]').forEach(el => {
    const p = el.dataset.live && B.people.find(x => x.uid === el.dataset.live);
    if (p) el.textContent = hm(liveMs(p, now()));
  });
}, 30000);

// Back on the page after a while (another tab, the phone unlocked): ask again, at most every 2 minutes.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - statusAt > 120000) loadStatus();
  else if (S && S.isAdmin && Date.now() - boardAt > 120000) loadBoard(true);
});

loadStatus();
