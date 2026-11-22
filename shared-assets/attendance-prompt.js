// ═══════ ATTENDANCE — the morning sign-in pop-up ═══════
//
// shared-assets/access.js calls maybePrompt() on every console page once the person is signed in.
// From 7 am (India time), every page they open offers a one-tap sign-in until they have signed in
// that day. "Not now" closes it on that page only — the next page asks again. Once signed in (here,
// on the Attendance page, or on another device) it stops for the day; signing out later in the day
// does not bring it back. The Attendance page (menu → Attendance) signs in and out any number of times.
//
// Cost: the day's state is remembered on the device (localStorage { day, s: 'in' | 'out' | 'off', at }).
// 'in' and 'off' (attendance not kept) end the asking for the day with no server call; 'out' shows
// the pop-up straight from memory and re-checks the server at most every 20 minutes, in case they
// signed in on another device. So a few /api/attendance 'status' calls (2 reads each) a day per
// person at most. Nothing polls.
//
// Modern Web Guidance (ui-components/dialog): a native <dialog> opened with showModal() — the browser
// gives the inert page, focus, Esc and the back gesture; no role/aria-modal, no focus trap here.
import { dayOf, hourOf, clock, PROMPT_HOUR } from './attendance-core.js';

const greeting = h => (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');

const KEY = uid => 'pin.att.state.' + uid;
const RECHECK_MS = 20 * 60 * 1000;
const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } };
// The Attendance page and the pop-up both record a sign-in here, so no other page asks again today.
export const rememberSignedIn = uid => write(KEY(uid), { day: dayOf(), s: 'in', at: Date.now() });

async function call(user, action, body = {}) {
  const token = await user.getIdToken();
  const r = await fetch('/api/attendance', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || 'Couldn’t reach the server');
  return j;
}

const CSS = `
dialog.att-pop{border:0;border-radius:16px;padding:0;width:min(92vw,380px);background:var(--card,#fff);color:var(--ink,#171717);
  box-shadow:0 18px 60px rgba(0,0,0,.28);font:15px/1.5 var(--sans,system-ui,-apple-system,sans-serif)}
dialog.att-pop:modal{overscroll-behavior:contain}
dialog.att-pop::backdrop{background:rgba(0,0,0,.45);overflow:hidden;overscroll-behavior:contain}
.att-pop .ap-body{padding:22px 22px 8px;text-align:center}
.att-pop .ap-ic{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;margin:0 auto 10px;background:var(--brand-soft,#FFF1DF);color:var(--brand-ink,#9A5200);font-size:22px}
.att-pop h2{font-size:19px;margin:0 0 4px}
.att-pop .ap-time{font-size:30px;font-weight:700;letter-spacing:-.01em;margin:6px 0 2px;font-variant-numeric:tabular-nums}
.att-pop p{margin:0;color:var(--ink3,#5C5C5C);font-size:14px}
.att-pop .ap-err{color:var(--danger,#C5221F);min-height:1.5em;margin-top:6px;font-size:13px}
.att-pop form{display:flex;flex-direction:column;gap:8px;padding:10px 22px 22px}
.att-pop button{font:inherit;font-weight:600;min-height:44px;border-radius:10px;cursor:pointer;border:1px solid var(--border2,#D4D4D4);background:transparent;color:var(--ink,#171717)}
.att-pop button.primary{background:var(--brand,#FF8A00);border-color:var(--brand,#FF8A00);color:var(--on-brand,#1A1206)}
.att-pop button:disabled{opacity:.6;cursor:progress}
.att-pop button:focus-visible{outline:3px solid var(--focus,#2563EB);outline-offset:2px}
.att-pop .ap-done{color:var(--ok,#1E8E3E);font-weight:600}
.att-pop .ap-later{margin:2px 0 0;text-align:center;font-size:12.5px;color:var(--ink3,#5C5C5C)}
`;

function firstName(email) {
  const n = String(email || '').split('@')[0].split(/[._-]/)[0] || '';
  return n ? n[0].toUpperCase() + n.slice(1) : '';
}

function show(user, email, uid) {
  if (!document.getElementById('attPopCss')) {
    const st = document.createElement('style'); st.id = 'attPopCss'; st.textContent = CSS; document.head.append(st);
  }
  const dlg = document.createElement('dialog');
  dlg.className = 'att-pop';
  dlg.setAttribute('aria-labelledby', 'attPopTitle');
  dlg.setAttribute('aria-describedby', 'attPopNote');
  const name = firstName(email);
  dlg.innerHTML = `
    <div class="ap-body">
      <div class="ap-ic" aria-hidden="true"><i class="fa-regular fa-clock"></i></div>
      <h2 id="attPopTitle">${greeting(hourOf(Date.now()))}${name ? ', ' + name.replace(/[<>&"]/g, '') : ''}</h2>
      <div class="ap-time" id="attPopTime">${clock(Date.now())}</div>
      <p id="attPopNote">Sign in to start today’s attendance. You can sign in and out any time from <b>Attendance</b> in the menu.</p>
      <div class="ap-err" role="alert" id="attPopErr"></div>
    </div>
    <form method="dialog">
      <button type="button" class="primary" id="attPopIn" autofocus>Sign in now</button>
      <button value="later">Not now</button>
      <p class="ap-later">This will ask again on the next page until you sign in.</p>
    </form>`;
  document.body.append(dlg);
  const tick = setInterval(() => { const t = dlg.querySelector('#attPopTime'); if (t && !dlg.dataset.done) t.textContent = clock(Date.now()); }, 15000);
  dlg.addEventListener('close', () => { clearInterval(tick); dlg.remove(); });
  dlg.querySelector('#attPopIn').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Signing in…';
    dlg.querySelector('#attPopErr').textContent = '';
    try {
      const r = await call(user, 'sign-in', { source: 'popup' });
      rememberSignedIn(uid);
      const at = r.today && r.today.openSince;
      dlg.dataset.done = '1';
      dlg.querySelector('#attPopTime').textContent = clock(at || Date.now());
      dlg.querySelector('#attPopNote').innerHTML = `<span class="ap-done">✓ ${r.already ? 'You were already signed in' : 'Signed in'}${at ? ' at ' + clock(at) : ''}.</span> Sign out from Attendance when you finish.`;
      btn.remove();
      const later = dlg.querySelector('button[value=later]'); later.textContent = 'Done'; later.focus();
      document.dispatchEvent(new CustomEvent('pin-attendance', { detail: r.today }));
      setTimeout(() => { if (dlg.open) dlg.close(); }, 2500);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Try again';
      dlg.querySelector('#attPopErr').textContent = err.message || 'Couldn’t sign in';
    }
  });
  dlg.showModal();
}

// a: { user, uid, email, role } from access.js.
export async function maybePrompt(a, { page = '' } = {}) {
  if (!a || !a.user || !a.uid) return;
  if (page === 'attendance') return;              // that page has its own big button
  const now = Date.now();
  if (hourOf(now) < PROMPT_HOUR) return;
  const day = dayOf(now);
  const known = read(KEY(a.uid));
  const today = known && known.day === day ? known : null;
  if (today && (today.s === 'in' || today.s === 'off')) return;   // signed in, or not kept — done for today
  if (!today || now - (today.at || 0) > RECHECK_MS) {
    let st;
    try { st = await call(a.user, 'status'); } catch (e) { if (!today) return; st = null; }   // offline: use what we knew
    if (st) {
      const s = !st.tracked ? 'off' : st.today && st.today.sessions && st.today.sessions.length ? 'in' : 'out';
      write(KEY(a.uid), { day, s, at: now });
      if (s !== 'out') return;
    }
  }
  if (document.querySelector('dialog.att-pop')) return;
  show(a.user, a.email, a.uid);
}
