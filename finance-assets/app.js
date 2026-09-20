// ═══════ 3 PIN REALTY — FINANCE APP ═══════
//
// Page shell, routing, and the three views that carry the daily work: Overview, Record and
// Transactions. The rest live in views-*.js and are imported below.
//
// Every view is a pure function of the cached state that returns an HTML string, which is
// dropped into <main>. Actions are wired through window.fin.* so views can use plain inline
// onclick handlers — the same approach crm.html and dashboard.html already use — and so the
// view modules never need to import app.js back (which would be a cycle).

import {
  isUndone,
  A, getState, fmt, esc, num, today, ym, addMonths, mlabel,
  pl, cashPosition, serviceRunRate, dname, pname, complianceCalendar, upcomingCash,
  bal, openBills, openInvoices, billOutstanding, invoiceOutstanding, allocate, vendorAdvance,
  setDisplayCurrency, displayCurrency, setScope, scopeMode, scopeLabel, scopedTxns, scoped, methodLabel, movesMoney, moneyMoved,
  settlementOf, explain, INCOME_ACCS, EXPENSE_ACCS,
} from './finance-core.js';
import { EV, CHOOSER, fieldsFor, validateEvent, dirOf } from './finance-events.js';
import * as SY from './finance-sync.js';
import {
  toast, modal, closeModal, confirmDialog, stat, signed, empty, note, tag,
  table, picker, downloadCsv, monthOptions, seg,
} from './ui.js';

import { renderOwed } from './views-owed.js';
import { renderServices, renderLoans, renderAssets } from './views-services.js';
import { renderPetty, renderBudget, renderMonth } from './views-money.js';
import { renderInvoices, mountInvoices } from './views-invoices.js';
import { renderBank, mountBank } from './views-bank.js';
import { renderReports, renderBooks } from './views-reports.js';
import { renderSettings, mountSettings, renderProfile, mountProfile, renderOpening, mountOpening } from './views-admin.js';
import { renderGuide } from './views-guide.js';
import { renderDeals } from './views-deals.js';
import { renderGst } from './views-gst.js';
import { renderAnalytics } from './views-analytics.js';

// ═══════ NAVIGATION ═══════
//
// Five tabs fit across the bottom bar on a phone; everything else lives behind "More".

// Grouped the way the work is done. The side nav on a desktop is text only — a considered
// interface does not need a glyph beside every word — and the groups carry the structure.
// The phone tab bar keeps icons, because at that size they are the label.
// Grouped by what each thing IS. View keys never change, so every bookmark and every
// fin.go() in the views keeps working; only where a thing sits in the menu moves.
const NAV = [
  ['overview', 'Overview', 'fa-solid fa-gauge-high', 'Daily'],
  ['record', 'Record', 'fa-solid fa-plus', 'Daily'],
  ['month', 'This month', 'fa-regular fa-calendar-check', 'Daily'],
  ['txns', 'Transactions', 'fa-solid fa-list', 'Daily'],
  ['owed', 'Owed', 'fa-solid fa-right-left', 'Daily'],
  ['deals', 'Deals & invoices', 'fa-regular fa-handshake', 'Business'],
  ['services', 'Recurring', 'fa-solid fa-rotate', 'Business'],
  ['budget', 'Budget', 'fa-regular fa-calendar', 'Business'],
  ['bank', 'Bank & card statements', 'fa-solid fa-building-columns', 'Money'],
  ['petty', 'Petty cash', 'fa-solid fa-coins', 'Money'],
  ['loans', 'Loans', 'fa-solid fa-percent', 'Money'],
  ['assets', 'Assets', 'fa-regular fa-square', 'Money'],
  ['gst', 'GST', 'fa-solid fa-stamp', 'Tax & reports'],
  ['reports', 'Reports', 'fa-regular fa-chart-bar', 'Tax & reports'],
  ['analytics', 'Analytics', 'fa-solid fa-chart-column', 'Tax & reports'],
  ['books', 'Books', 'fa-solid fa-book', 'Tax & reports'],
  ['profile', 'Profile', 'fa-regular fa-id-badge', 'Setup'],
  ['settings', 'Settings', 'fa-solid fa-sliders', 'Setup'],
  ['guide', 'Guide', 'fa-regular fa-circle-question', 'Setup'],
];
// Invoices live inside Deals now; the old route still lands somewhere sensible.
const ALIASES = { invoices: 'deals' };

const BOTTOM = ['overview', 'txns', 'record', 'owed', 'more'];

// Which screens follow the Record switch. Everything else always shows both records.
// Everything that reads entries back honours it, the dashboard included — the owner asked
// for one switch across the app. The statements inside Books are the only exception: they
// force both records themselves, so a trial balance is always of the whole firm.
const SCOPED_VIEWS = new Set(['overview', 'month', 'txns', 'reports', 'books', 'analytics']);

// ═══════ NAVIGATION MODULES ═══════
//
// The five modules that used to be rendered here now live in the app rail
// (shared-assets/appnav.js), which draws them on every console rather than only on this
// page. NAV above stays the authority on routing — which keys exist, what each is called
// and which group it belongs to — and tests/appnav.test.mjs fails if the rail ever
// disagrees with it.

let view = 'overview';
let ready = false;

const entryNo = t => t?.no ? '#' + String(t.no).padStart(4, '0') : '—';

// Event keys that earlier builds posted under, so an old entry still reads as what it was.
const LEGACY_EVENT = { billdiscount: 'Discount on a bill' };

// ═══════ BOOT ═══════

// The rail is the menu for all four consoles. Here it hands finance keys straight to go(),
// so moving between finance screens never reloads the page; anything else on it is a link.
window.AppNav.boot({
  console: 'finance',
  select: key => go(key),
  signOut: () => window.financeLogout(),
});

window.onFinanceAuthChange = (user, tenantId) => {
  const login = document.getElementById('loginScreen');
  const app = document.getElementById('appRoot');
  if (user) {
    login.classList.remove('open');
    app.style.display = '';
    document.getElementById('whoami').textContent = user.email || '';
    window.AppNav?.setUser(user.email || '');
    if (!tenantId) {
      document.getElementById('main').innerHTML = note(
        '<b>This account is not set up for the finance module yet.</b><br>It has no tenant assigned, so there is no data to show. Ask whoever provisioned your login to finish onboarding.');
      return;
    }
    if (!ready) {
      ready = true;
      routeFromHash();
      // Restore the last-used display currency without blocking the first paint.
      let saved = null;
      try { saved = localStorage.getItem('fin.cur'); } catch { }
      if (saved === 'USD') window.fin.setCurrency('USD'); else paintCurrency();
      let sc = null;
      try { sc = sessionStorage.getItem('fin.scope'); } catch { }
      setScope(sc || 'with'); paintScope();
    }
  } else {
    ready = false;
    app.style.display = 'none';
    login.classList.add('open');
  }
};

// A data change repaints every view except Record, where a snapshot echo mid-typing would
// throw away the form. The preview there reads live state on its next keystroke anyway. A
// change of boot phase repaints whatever the view: nothing is mounted on Record until the
// books are in, so there is no form to lose.
window.onFinanceData = what => { if (ready && (view !== 'record' || what === 'phase')) repaint(); };

window.financeAttemptLogin = e => {
  e.preventDefault();
  const err = document.getElementById('loginErr');
  err.classList.remove('show');
  window.financeAuth
    .login(document.getElementById('loginUser').value.trim(), document.getElementById('loginPass').value)
    .catch(() => {
      err.textContent = 'Invalid email or password.';
      err.classList.add('show');
    });
  return false;
};

// ═══════ DISPLAY CURRENCY ═══════
//
// A reading aid, not a setting: the books stay in rupees and nothing converted is written
// back. The rate is fetched once a day from a free, key-less endpoint and cached, so the
// toggle is instant and still works offline on the last known rate.

const FX_KEY = 'fin.usdInr';
// Only reached if both providers are unreachable AND nothing was ever cached. Roughly the
// rate at the time of writing, so a first-ever offline toggle is in the right region rather
// than wildly wrong.
const FX_FALLBACK = 94.5;

// Two key-less providers. The first is the primary; the second covers it being down. Note
// the .dev host: api.frankfurter.app now 301s here, and a cross-origin redirect is a good
// way to fail a CORS preflight, so it is addressed directly.
const FX_SOURCES = [
  { url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR', pick: d => ({ rate: d?.rates?.INR, at: d?.date }) },
  { url: 'https://open.er-api.com/v6/latest/USD', pick: d => ({ rate: d?.rates?.INR, at: (d?.time_last_update_utc || '').slice(5, 16) }) },
];

function cachedRate() {
  try { return JSON.parse(localStorage.getItem(FX_KEY) || 'null'); } catch { return null; }
}

async function usdRate() {
  const hit = cachedRate();
  if (hit?.rate && hit.day === today()) return hit;
  for (const src of FX_SOURCES) {
    try {
      const r = await fetch(src.url, { cache: 'no-store' });
      if (!r.ok) continue;
      const got = src.pick(await r.json());
      const rate = num(got.rate);
      if (rate > 0) {
        const fresh = { rate, at: got.at || today(), day: today() };
        try { localStorage.setItem(FX_KEY, JSON.stringify(fresh)); } catch { }
        return fresh;
      }
    } catch { /* offline, or this provider is down — try the next */ }
  }
  // Yesterday's cached rate beats a constant, so it is preferred over the fallback.
  return hit || { rate: FX_FALLBACK, at: null, day: today() };
}

// The scope is a filter on entries — with, without, or only those that touch the cash box.
// It is deliberately NOT persisted: a filter silently left on is how a CA ends up with a
// P&L that is missing the cash expenses. It lasts for this tab, and every affected page
// says so in a banner while it is on.
function paintScope() {
  const mode = scopeMode();
  document.querySelectorAll('#scopeTog button').forEach(b => {
    const on = b.dataset.scope === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const tog = document.getElementById('scopeTog');
  if (tog) tog.classList.toggle('active', mode !== 'with');
}

function scopeBanner() {
  const mode = scopeMode();
  if (!SCOPED_VIEWS.has(view)) return '';
  // The same three choices as the header, for screens where the header cannot hold them.
  const inline = `<div class="scope-inline"><span class="lbl">Record</span><div class="seg" role="tablist">
    ${[['with', 'Both'], ['without', 'Bank'], ['only', 'Cash']].map(([m, l]) =>
      `<button type="button" role="tab" class="${mode === m ? 'on' : ''}" aria-selected="${mode === m}" onclick="fin.setScope('${m}')">${l}</button>`).join('')}
  </div></div>`;
  if (mode === 'with') return inline;
  return inline + `<div class="scope-banner" role="status">
    <b>${esc(scopeLabel(mode))}</b> — ${mode === 'only'
      ? 'the cash box kept as its own record: everything it earned, spent and is owed. Deals settled in cash live here in full — invoice, income and money.'
      : 'your banked record on its own. Anything settled through the cash box is a cash-book deal and is not counted here.'}
    ${view === 'books' ? 'The trial balance and balance sheet always show both records together.' : ''}
    <button type="button" class="btn ghost sm" onclick="fin.setScope('with')">Show both records</button>
  </div>`;
}

function paintCurrency() {
  const c = displayCurrency();
  document.querySelectorAll('#curTog button').forEach(b => {
    const on = b.dataset.cur === c.code;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const tog = document.getElementById('curTog');
  if (tog) {
    tog.title = c.code === 'USD'
      ? `Showing US dollars at ₹${c.rate.toFixed(2)} to $1${c.at ? ' (rate of ' + c.at + ')' : ''}. The books stay in rupees.`
      : 'Showing rupees. Switch to USD to read the same figures in dollars.';
  }
}

window.financeLogout = () => window.financeAuth.logout();
window.financeCloseModal = closeModal;

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); window.fin?.closePreview?.(); }
});

window.addEventListener('hashchange', routeFromHash);

function routeFromHash() {
  const h = location.hash.replace(/^#/, '');
  view = NAV.some(([k]) => k === h) ? h : (ALIASES[h] || 'overview');
  repaint();
}

// ═══════ RENDER ═══════

function go(next) {
  view = next;
  window.AppNav?.close();
  if (location.hash.replace(/^#/, '') !== next) location.hash = next;
  else repaint();
  document.getElementById('main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function repaint() {
  const s = getState();

  window.AppNav?.setActive(view);

  // The phone tab bar: the four screens used all day, with Record as the one that creates
  // something. "More" is the rail — the same menu the desktop shows down the left — rather
  // than a second sheet listing the same pages in a different order.
  document.getElementById('bottomnav').innerHTML = BOTTOM.map(k => {
    if (k === 'more') {
      const on = !BOTTOM.includes(view);
      return `<button type="button" class="${on ? 'on' : ''}" onclick="fin.openSheet()">
                <i class="ic fa-solid fa-bars" aria-hidden="true"></i>More</button>`;
    }
    const [, label, ic] = NAV.find(n => n[0] === k);
    const isRec = k === 'record';
    return `<button type="button" class="${view === k ? 'on' : ''} ${isRec ? 'rec' : ''}" onclick="fin.go('${k}')">
              <i class="ic ${ic}" aria-hidden="true"></i>${esc(label)}</button>`;
  }).join('');

  const main = document.getElementById('main');

  // Nothing is drawn until the books are in. Not the first-run page — a slow phone used to
  // reach it simply because nothing had arrived yet, and it offered to seed books that already
  // existed — and not a ledger with one entry in it.
  const boot = booting();
  if (boot) {
    main.innerHTML = loadingScreen(boot);
    return;
  }

  // The books are in, and there is genuinely nothing in them.
  if (!s.settingsExists && !s.txns.length && view !== 'settings') {
    main.innerHTML = firstRun();
    return;
  }

  const views = {
    overview, record, txns,
    owed: renderOwed,
    services: renderServices, loans: renderLoans, assets: renderAssets,
    invoices: renderInvoices, bank: renderBank, petty: renderPetty, budget: renderBudget,
    reports: renderReports, books: renderBooks, month: renderMonth,
    profile: renderProfile, settings: renderSettings, guide: renderGuide, opening: renderOpening,
    deals: renderDeals, gst: renderGst, analytics: renderAnalytics,
  };
  // Views that honour the scope render inside it, so every figure they show agrees.
  const render = views[view] || overview;
  main.innerHTML = scopeBanner() + (SCOPED_VIEWS.has(view) ? scoped(render) : render());

  // Views that need real event listeners rather than inline handlers wire up here.
  ({
    record: mountRecord, invoices: mountInvoices, bank: mountBank,
    settings: mountSettings, profile: mountProfile, opening: mountOpening,
  })[view]?.();
}

// ═══════ FIRST RUN ═══════

// The security rules read booksStartDate off the settings document before allowing any
// transaction, so seeding is genuinely the first thing that has to happen.
// ═══════ OPENING THE BOOKS ═══════

// Null once the books are in; otherwise where the boot has got to. The preview harness seeds
// state directly with no Firebase behind it and says so.
function booting() {
  if (window.__financeBoot) return window.__financeBoot;   // design review: a phase to draw
  if (window.__financePreview) return null;
  const st = SY.syncStatus();
  return st.phase === 'ready' ? null : st;
}

// The shapes the overview will take, with nothing in them yet, and one line saying what is
// happening. A returning device is on this for the time it takes to read its own disk; a new
// one for the one full read it will ever do; a phone without signal for as long as that lasts,
// told so, with a way to try again.
function loadingScreen(st) {
  const total = st.total || 0, done = st.done || 0;
  const pct = total ? Math.round(6 + 94 * done / total) : 0;
  const err = st.phase === 'error';
  const title = err ? (st.fatal ? 'This account is not set up' : 'Can\u2019t reach the server')
    : st.phase === 'auth' ? 'Signing you in'
      : st.phase === 'bootstrapping' ? 'Reading your books' : 'Opening your books';
  const sub = err ? ''
    : st.phase === 'bootstrapping' ? `First time on this device \u00b7 ${done} of ${total} read`
      : st.phase === 'auth' ? 'Checking the account' : 'From this device';
  const stat = () => `<div class="card stat sk-stat"><span class="sk l"></span><span class="sk v"></span><span class="sk s"></span></div>`;
  const row = () => `<div class="sk-row"><span class="sk d"></span><span class="sk t"></span><span class="sk a"></span></div>`;
  return `
    <div class="boot${err ? ' err' : ''}" role="status" aria-live="polite" aria-busy="${err ? 'false' : 'true'}">
      <div class="boot-head">
        <div class="boot-ring" aria-hidden="true"></div>
        <div><div class="boot-t">${esc(title)}</div>${sub ? `<div class="boot-s">${esc(sub)}</div>` : ''}</div>
      </div>
      ${err
      ? `<div class="boot-err"><span>${esc(st.error || 'Something went wrong.')}${st.retryIn ? ` Trying again in ${Math.round(st.retryIn / 1000)} s.` : ''}</span>${st.fatal ? '' : `<button class="btn sm" type="button" onclick="fin.retryBoot()">Try again now</button>`}</div>`
      : `<div class="boot-bar${total ? '' : ' idle'}" aria-hidden="true"><i style="width:${pct}%"></i></div>`}
      <div class="grid two-up" aria-hidden="true">${stat()}${stat()}${stat()}${stat()}</div>
      <div class="card pad0 sk-rows" aria-hidden="true">${row()}${row()}${row()}${row()}${row()}${row()}</div>
    </div>`;
}

function firstRun() {
  return `
    <h1>Set up the finance module</h1>
    <p class="lead">Nothing has been created yet. Seeding writes the chart of accounts and your
    settings — it is safe to run more than once and never overwrites anything that already exists.</p>
    ${note('The ledger will not accept a single entry until this is done, because the security rules check your books-start date before allowing a transaction.', 'info')}
    <button class="btn primary" type="button" onclick="fin.seed()">Seed the chart of accounts</button>`;
}

// ═══════ OVERVIEW ═══════

function overview() {
  const s = getState();
  const m = ym(today());
  const p = pl(m);
  const cash = cashPosition();
  const svc = serviceRunRate();
  const done = Object.keys(s.monthEnds).sort().reverse();
  const prev = addMonths(m, -1);

  if (!s.txns.length) {
    return `<h1>Overview</h1>
      ${empty('<b>No entries yet.</b><br>Everything here is worked out from what you record, so start with your opening balances or just record what happened today.',
      `<div class="actions" style="justify-content:center;margin-top:14px">
           <button class="btn primary" type="button" onclick="fin.go('opening')">Enter opening balances</button>
           <button class="btn" type="button" onclick="fin.go('record')">Record something</button>
         </div>`)}`;
  }

  const booksNote = s.settings.booksStartDate
    ? `<p class="small faint">Books start ${new Date(s.settings.booksStartDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>`
    : '';

  return `
    <h1>Overview</h1>
    <p class="lead">${mlabel(m)} so far. Every figure below is worked out from your entries — nothing is typed in twice.</p>
    ${booksNote}

    <div class="grid g3">
      ${stat('Income', fmt(p.ti), { drill: { accs: INCOME_ACCS, month: m, flip: true } })}
      ${stat('Expenses', fmt(p.te), { drill: { accs: EXPENSE_ACCS, month: m } })}
      ${stat('Profit', signed(p.profit), { raw: true, hero: true, drill: { profit: true, month: m, note: 'Income counts up, costs count down. Together they make the month.' } })}
      ${stat('Free to use', fmt(cash.free), { sub: 'Cash after vendor dues and client tokens' })}
    </div>

    <h2 class="h2row">Where the money is <a class="more" href="#month">This month — paid, invoiced, due ›</a></h2>
    <div class="grid g3">
      ${stat('Bank', fmt(cash.bank), { drill: { accs: '1000', note: 'Every movement through the bank since the books began.' } })}
      ${stat('Petty cash', fmt(cash.petty), { drill: { accs: '1010' } })}
      ${stat('Credit card', fmt(cash.card), { cls: cash.card > 0 ? 'neg' : '', sub: 'Owed', drill: { accs: '2300', flip: true } })}
      ${stat('Loans', fmt(cash.loans), { sub: 'Outstanding', drill: { accs: '2400', flip: true } })}
    </div>

    <h2>Who owes whom</h2>
    <div class="grid g3">
      ${stat('Clients owe you', fmt(cash.receivable), { drill: { accs: '1100', note: 'Invoices raised, less what has been collected against them.' } })}
      ${stat('You owe vendors', fmt(cash.vendorDues), { drill: { accs: '2000', flip: true, note: 'Bills received, less what has been paid against them.' } })}
      ${stat('Tokens held', fmt(cash.tokens), { sub: 'Not yours until the deal registers', drill: { accs: '2100', flip: true } })}
      ${stat('GST due', fmt(cash.gstDue), { cls: cash.gstDue > 0 ? 'neg' : '', sub: 'Net of input credit' })}
    </div>
    <h2 class="h2row">Services <a class="more" href="#owed">Owed, both ways ›</a></h2>
    <div class="grid g3">
      ${stat('Recurring costs', fmt(svc.monthly) + '/mo', { sub: 'Expected vs actual on the Budget tab' })}
      ${stat('Prepaid', fmt(svc.prepaidUnused), { sub: 'Sitting with vendors', drill: { accs: '1200' } })}
      ${stat('Active', String(svc.active.length), { sub: 'Services running' })}
    </div>

    <h2>Coming up</h2>
    <div class="grid two-up">
      <div class="card">
        <h3>Compliance dates</h3>
        <ul class="checklist">
          ${complianceCalendar(today(), { tdsEnabled: s.settings.tdsEnabled, limit: 5 }).map(c => `
            <li class="todo"><span class="mark" aria-hidden="true">${esc(c.date.slice(8))}<span class="small faint">/${esc(c.date.slice(5, 7))}</span></span>
              <span><b>${esc(c.what)}</b><br><span class="small muted">${esc(c.note)}</span></span></li>`).join('')}
        </ul>
      </div>
      <div class="card">
        <h3>Cash needed soon</h3>
        ${(() => { const u = upcomingCash(today()); return u.items.length ? `
          <ul class="checklist">${u.items.map(i => `<li class="todo"><span class="mark" aria-hidden="true">₹</span>
            <span style="flex:1">${esc(i.what)}<br><span class="small muted">${esc(mlabel(i.when))}</span></span><span class="n">${fmt(i.amt)}</span></li>`).join('')}
          </ul>
          <p class="small ${u.total > u.cash ? 'neg' : 'muted'}" style="margin:10px 0 0"><b>${fmt(u.total)}</b> against ${fmt(u.cash)} in bank and box${u.total > u.cash ? ' — short' : ''}.</p>`
          : '<p class="small faint" style="margin:0">Nothing known is due in the next month.</p>'; })()}
      </div>
    </div>

    <h2>Month-end</h2>
    <div class="card">
      <p class="small muted">Month-end posts the automatic entries — depreciation, and the monthly
      slice of anything you paid for upfront. Running it twice is harmless: the second run posts nothing.</p>
      <div class="actions" style="margin-bottom:0">
        <input type="month" id="meMonth" value="${prev}" style="max-width:180px" aria-label="Month to close">
        <button class="btn" type="button" onclick="fin.monthEnd()">Run month-end</button>
      </div>
      ${done.length
      ? `<p class="small muted" style="margin-top:12px">Completed: ${done.map(x => `${esc(mlabel(x))}${s.monthEnds[x].reconciled ? ' ✓' : ''}`).join(' · ')}</p>`
      : '<p class="small faint" style="margin-top:12px">No month has been closed yet.</p>'}
    </div>`;
}

// ═══════ RECORD ═══════
//
// One screen for everything that happens. It opens on a search box and "your usual" — the
// handful of things this owner records most — with each group's everyday actions laid out
// beneath and the rare ones folded away by name. The form leads with the amount, keeps the
// detail questions one fold down, and stays quiet until it is touched. The preview is a live
// dry run of what saving will do — the only thing standing between the user and a wrong
// entry — beside the form on a desk and one tap from Save on a phone. Save stays disabled
// until the journal balances, is disabled again the instant it is pressed, and is replaced by
// an unmistakable result panel afterwards.
//
// The old first question — "money in, or money out?" — is gone. A third of what gets recorded
// moves no cash at all, and several things that do point the wrong way for what the owner
// means. The groups now answer "what is this about?", which is the question every accounting
// package asks first; direction survives as the colour on each card.

let evKey = null, evLabel = null, evId = null;
let groupPick = '';           // '' = every group
let findQ = '';
let evPreset = {};
let vals = {};
let pendingFiles = [];
let saving = false;
let result = null;
let saveErr = null;           // a failed save keeps the form and says so above the bar
let touched = new Set();      // fields the user has been to — errors show only where earned
let moreOpen = false;
let rebuilding = false;

// ── the chooser's data ──
// CHOOSER is plain data: seven categories, each with its actions. An item's id is its key plus
// its preset, so the two invoice buttons are two things to the history. A key listed in two
// categories is one thing. Each category carries the direction its colour comes from and the
// one line under its name.
const GROUP_META = {
  'Money in': { dir: 'in', hint: 'Client payments, tokens, other income, capital, loans' },
  'Money out': { dir: 'out', hint: 'Expenses, petty cash, bills paid, salaries, EMIs, taxes, transfers' },
  'Bills': { dir: 'out', hint: 'Vendor bills to pay later, bills that arrived, vendor refunds' },
  'Invoices': { dir: 'in', hint: 'Billing a client — brokerage, other income, credit notes' },
  'Service costs': { dir: 'out', hint: 'Rent, subscriptions, retainers — this month, and setting them up' },
  'Deals': { dir: 'setup', hint: 'Open a deal, mark it registered, tokens, costs, settling' },
  'Fix something': { dir: 'fix', hint: 'Write-offs, absorbed costs, asset disposals, card to EMI' },
};
const GROUPS = CHOOSER.map(([label, items]) => {
  const meta = GROUP_META[label] || {};
  const g = { id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label, hint: meta.hint || '', items: [] };
  g.items = items.filter(it => EV[it.key]).map(it => ({
    ...it,
    id: it.key + (it.preset ? ':' + Object.values(it.preset).join('-') : ''),
    label: it.label || EV[it.key].title,
    dir: dirOf(it.key), group: g,
  }));
  g.dir = meta.dir || g.items[0]?.dir || 'setup';
  return g;
});
const ITEMS = GROUPS.flatMap(g => g.items);
const itemById = id => ITEMS.find(it => it.id === id) || null;
const dedupe = list => { const seen = new Set(); return list.filter(it => !seen.has(it.id) && seen.add(it.id)); };
// Zero feature loss is checked, not hoped for.
{
  const listed = new Set(ITEMS.map(it => it.key));
  const missing = Object.keys(EV).filter(k => !listed.has(k));
  if (missing.length) console.error('Record: events with no button —', missing.join(', '));
}

// ── recent ──
// This device's own history: what was recorded, how often, how recently. Shown as a short row
// above the categories once there is any — nothing before that.
const USE_KEY = 'fin.rec.usage.v1';
function usage() { try { return JSON.parse(localStorage.getItem(USE_KEY) || '{}'); } catch { return {}; } }
function noteUse(id) {
  if (!id) return;
  const u = usage(), r = u[id] || { n: 0, last: 0 };
  r.n += 1; r.last = Date.now(); u[id] = r;
  try { localStorage.setItem(USE_KEY, JSON.stringify(u)); } catch { /* private window */ }
}
function recent(n) {
  const u = usage(), now = Date.now();
  // Frequency decays over a month; anything saved today gets a bump, so the second coffee of
  // the day is first.
  const score = it => { const r = u[it.id]; if (!r) return 0; const d = (now - r.last) / 864e5; return r.n * Math.exp(-d / 30) + (d < 1 ? 2 : 0); };
  return dedupe(ITEMS).filter(it => u[it.id]).sort((a, b) => score(b) - score(a)).slice(0, n);
}

// ── search ──
const words = q => String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
function matchScore(it, ws) {
  const hay = [it.label, it.sub, EV[it.key].title, it.group.label, ...(it.kw || [])].join(' ').toLowerCase();
  if (!ws.every(w => hay.includes(w))) return 0;
  const label = it.label.toLowerCase();
  if (label.startsWith(ws[0])) return 4;
  if (label.split(/\W+/).some(t => t.startsWith(ws[0]))) return 3;
  // A keyword is what the owner actually types — "rent" for the recurring cost, "EB" for an
  // expense — and outranks a word that merely happens to appear in a sub-line.
  if ((it.kw || []).some(k => k.startsWith(ws[0]) || ws.every(w => k.includes(w)))) return 2;
  return 1;
}
function searchItems(q) {
  const ws = words(q);
  if (!ws.length) return null;
  return dedupe(ITEMS.map(it => [it, matchScore(it, ws)]).filter(([, sc]) => sc > 0)
    .sort((a, b) => b[1] - a[1]).map(([it]) => it));
}
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function hl(text, ws) {
  let h = esc(text);
  for (const w of ws || []) h = h.replace(new RegExp('(' + reEsc(esc(w)) + ')', 'ig'), '<mark>$1</mark>');
  return h;
}

function actCard(it, { compact = false, ws = null, showGroup = false } = {}) {
  return `<button type="button" class="act${compact ? ' compact' : ''} dir-${it.dir}" data-id="${esc(it.id)}" onclick="fin.pickId('${esc(it.id)}')">
      <b>${hl(it.label, ws)}</b>${it.sub && !compact ? `<span class="sub">${hl(it.sub, ws)}</span>` : ''}${showGroup ? `<span class="grp">${esc(it.group.label)}</span>` : ''}</button>`;
}

// The list under the search box: search results as one flat list, or the groups with their
// everyday actions open and the rest folded behind a row that names what is hidden.
function chooserBody() {
  const ws = words(findQ);
  if (ws.length) {
    const hits = searchItems(findQ);
    return hits.length
      ? `<div class="rec-list rec-hits">${hits.map(it => actCard(it, { ws, showGroup: true })).join('')}</div>`
      : empty(`Nothing called "<b>${esc(findQ.trim())}</b>". Try a plainer word — rent, salary, token — or pick a category above.`,
        `<button class="btn" type="button" onclick="fin.findAction('', true)">Clear search</button>`);
  }
  // Level one: the seven categories. Level two: the actions inside the one that was chosen.
  const g = groupPick ? GROUPS.find(x => x.id === groupPick) : null;
  if (!g) {
    return `<div class="cat-tiles">${GROUPS.map(x => `
      <button type="button" class="cat dir-${x.dir}" data-g="${esc(x.id)}" onclick="fin.pickGroup('${esc(x.id)}')">
        <b>${esc(x.label)}</b><span class="sub">${esc(x.hint)}</span><span class="cnt">${x.items.length}</span></button>`).join('')}
    </div>`;
  }
  return `
    <div class="cat-head">
      <button class="btn ghost sm" type="button" onclick="fin.pickGroup('')"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> All categories</button>
    </div>
    <section class="rec-group dir-${g.dir}" data-g="${esc(g.id)}">
      <div class="eh">${esc(g.label)} <span class="cnt">${g.items.length}</span></div>
      ${g.hint ? `<p class="small muted" style="margin:0 0 var(--s3)">${esc(g.hint)}</p>` : ''}
      <div class="rec-list">${g.items.map(it => actCard(it)).join('')}</div>
    </section>`;
}

function chooser() {
  const recents = (!findQ.trim() && !groupPick) ? recent(window.innerWidth >= 1100 ? 6 : 4) : [];
  return `
    <div class="rec-head">
      <h1>Record what happened</h1>
      <div class="rec-find">
        <input type="search" id="actFind" placeholder="Or find it — rent, token, EMI…" aria-label="Find what to record"
          autocomplete="off" enterkeyhint="search" value="${esc(findQ)}" oninput="fin.findAction(this.value)" onkeydown="fin.findKey(event)">
        <button type="button" class="clr" id="actClear" aria-label="Clear search" ${findQ ? '' : 'hidden'} onclick="fin.findAction('', true)"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
    </div>
    <p class="sr-only" id="actCount" aria-live="polite"></p>
    <section class="rec-usual" id="recUsual" ${recents.length ? '' : 'hidden'}>
      <div class="eh">Recent</div>
      <div class="rec-usual-grid">${recents.map(it => actCard(it, { compact: true })).join('')}</div>
    </section>
    <div id="chooser">${chooserBody()}</div>`;
}

// Redraws the list without touching the search box, so typing never loses focus.
function redrawChooser() {
  const el = document.getElementById('chooser');
  if (!el) return;
  el.innerHTML = chooserBody();
  const usualEl = document.getElementById('recUsual');
  if (usualEl) usualEl.hidden = !!(findQ.trim() || groupPick) || !usualEl.querySelector('.act');
  const clr = document.getElementById('actClear');
  if (clr) clr.hidden = !findQ;
  const count = document.getElementById('actCount');
  if (count) { const hits = findQ.trim() ? searchItems(findQ) : null; count.textContent = hits ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : ''; }
}

const ABOUT_KEY = 'fin.rec.about';
function aboutOpen() { try { return localStorage.getItem(ABOUT_KEY) !== 'closed'; } catch { return true; } }

function saveErrBlock() {
  return `<div class="result err" role="alert">
    <h3>Not saved</h3>
    <p style="margin:6px 0 0">${esc(saveErr)}</p>
    <p class="small muted" style="margin:6px 0 0">Nothing was written — your entries are still here.</p>
    <div class="actions"><button class="btn primary" type="button" onclick="fin.retrySave()">Try again</button></div>
  </div>`;
}

function record() {
  if (result) return resultPanel();
  if (!evKey) return chooser();

  const ev = EV[evKey];
  return `
    <div class="rec-bar">
      <button class="btn ghost sm" type="button" onclick="fin.pick(null)"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> All actions</button>
      ${dirBadge(evKey)}
    </div>
    <h1 class="rec-title">${esc(evLabel || ev.title)}</h1>
    <div class="record-split dir-${dirOf(evKey)}">
      <div class="form-col">
        <form id="evForm" autocomplete="off" onsubmit="return false" novalidate></form>
        <div id="formProblems"></div>
        <div class="field attach">
          <label>Bill photo <span class="faint">(optional)</span></label>
          <div class="row">
            <label class="btn"><i class="fa-solid fa-camera" aria-hidden="true"></i> Add photo
              <input type="file" class="js-attach" accept="image/*" capture="environment" hidden></label>
            <label class="btn ghost">File
              <input type="file" class="js-attach" accept="image/*,application/pdf" multiple hidden></label>
            <ul class="stage" id="stageList"></ul>
          </div>
          <div class="hint">Photos are shrunk before upload, so a phone photo of a bill is fine.</div>
        </div>
        <div id="pvDup" class="dup"></div>
        <div id="saveErr">${saveErr ? saveErrBlock() : ''}</div>
        <div class="save-bar">
          <div class="sum" id="barSum"><span class="todo">Enter the amount</span></div>
          <button type="button" class="btn ghost sm pv-open" aria-haspopup="dialog" onclick="fin.openPreview()">Preview</button>
          <button class="btn primary js-save" type="button" onclick="fin.save()" disabled>Save</button>
        </div>
      </div>

      <div class="preview" id="preview">
        <div class="card">
          <h3>What saving this does</h3>
          <p class="pv-empty small faint" id="pvEmpty">Enter the amount to see what this does.</p>
          <ul class="effects" id="pvEffects"></ul>
          <div id="pvPosting"></div>
          <details class="journal" id="pvJournalWrap">
            <summary>Show the double entry this creates</summary>
            <div id="pvJournal"></div>
          </details>
          <details class="journal about" id="pvAbout" ${aboutOpen() ? 'open' : ''}>
            <summary>About this action</summary>
            <div class="when">${ev.when}</div>
          </details>
        </div>
      </div>
    </div>`;
}

const DIR_LABEL = { in: 'Money in', out: 'Money out', move: 'Move money', fix: 'Corrections', setup: 'Set up' };
const dirBadge = key => `<span class="dirtag dir-${dirOf(key)}">${DIR_LABEL[dirOf(key)] || ''}</span>`;

function mountRecord() {
  if (result) { mountResult(); return; }
  if (!evKey) {
    redrawChooser();
    // Auto-focus only on a desk: on a phone it would raise the keyboard over the list.
    if (window.innerWidth >= 860) document.getElementById('actFind')?.focus({ preventScroll: true });
    return;
  }
  buildForm();
  document.querySelectorAll('.js-attach').forEach(input => {
    input.addEventListener('change', e => {
      for (const f of e.target.files) pendingFiles.push(f);
      e.target.value = '';
      drawStage();
      updatePreview();
    });
  });
  document.getElementById('pvAbout')?.addEventListener('toggle', e => {
    try { localStorage.setItem(ABOUT_KEY, e.target.open ? 'open' : 'closed'); } catch { /* private window */ }
  });
  drawStage();
}

// The files waiting to go up with this entry. Nothing is uploaded until Save, so an abandoned
// form leaves no orphaned files in Drive.
function drawStage() {
  const el = document.getElementById('stageList');
  if (!el) return;
  el.innerHTML = pendingFiles.map((f, i) => `
    <li>
      <div class="pv">${f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt="">` : 'PDF'}</div>
      <div class="nm">${esc(f.name)}<br><span class="small faint">${(f.size / 1024).toFixed(0)} KB</span></div>
      <span class="st ok">Ready</span>
      <button type="button" class="rm" data-rm="${i}" aria-label="Remove ${esc(f.name)}">✕</button>
    </li>`).join('');
  el.querySelectorAll('[data-rm]').forEach(b => {
    b.onclick = () => { pendingFiles.splice(+b.dataset.rm, 1); drawStage(); updatePreview(); };
  });
}

// Which fields sit above the fold for each event. Everything else — category, bill number,
// GST, note — waits under "More details", which names what it holds so nothing feels removed.
// An event not listed here shows its first four fields. A field the form arrived with already
// filled (a preset from Owed or a statement line) is always shown, whatever this says; so is
// anything required, and any field the event marks tier:'core'.
const CORE = {
  expense: ['amt', 'desc', 'via', 'date'],
  dealpay: ['party', 'amt', 'tds', 'short', 'alloc', 'via', 'date'],
  paybill: ['party', 'amt', 'short', 'useAdvance', 'alloc', 'via', 'date'],
  billclose: ['party', 'bill', 'amt', 'why', 'tdsSection', 'date'],
  bill: ['vendor', 'desc', 'amt', 'dueDate', 'date'],
  billarrived: ['sub', 'month', 'amt', 'date'],
  confirmcharge: ['sub', 'month', 'result', 'amt', 'via', 'date'],
  invoice: ['deal', 'from', 'amt', 'gst', 'gstRate', 'adv', 'recv', 'date'],
  dealfee: ['deal', 'from', 'kind', 'amt', 'gst', 'gstRate', 'adv', 'recv', 'date'],
  token: ['deal', 'from', 'amt', 'via', 'date'],
  dealcost: ['deal', 'what', 'amt', 'bear', 'how', 'date'],
  petty: ['date', 'a1', 'c1', 'd1', 'a2', 'c2', 'd2', 'a3', 'c3', 'd3'],
  salary: ['emp', 'gross', 'kind', 'date'],
  emi: ['loan', 'date', 'via'],
  transfer: ['kind', 'amt', 'date'],
  statutory: ['kind', 'amt', 'date'],
  otherinc: ['party', 'desc', 'amt', 'via', 'date'],
  newdeal: ['nickname', 'seller', 'buyer', 'expSeller', 'expBuyer', 'date'],
  register: ['deal', 'date', 'note'],
  settle: ['deal', 'from', 'apply', 'refund', 'keep', 'date'],
  funding: ['kind', 'who', 'amt', 'date'],
  director: ['desc', 'amt', 'acc', 'date'],
};
// The one figure the owner knows for certain when he opens the screen. It goes first and big.
const AMOUNT_KEYS = new Set(['amt', 'gross']);

const fmtIN = v => { const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) && String(v).trim() !== '' ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(v ?? ''); };
const rawIN = v => String(v ?? '').replace(/,/g, '');

// Core first (amount leading), the rest in the engine's order inside the fold.
function splitFields(fields) {
  const wanted = CORE[evKey];
  const isCore = f => f.tier === 'core' || f.required || evPreset[f.k] !== undefined || f.type === 'alloc'
    || (wanted ? wanted.includes(f.k) : false);
  let core = fields.filter(f => f.tier !== 'detail' && isCore(f));
  if (!wanted) core = [...new Set([...fields.slice(0, 4), ...core])];
  const order = f => AMOUNT_KEYS.has(f.k) ? -1 : (wanted ? (wanted.indexOf(f.k) === -1 ? 99 : wanted.indexOf(f.k)) : fields.indexOf(f));
  core.sort((a, b) => order(a) - order(b) || fields.indexOf(a) - fields.indexOf(b));
  const detail = fields.filter(f => !core.includes(f));
  return { core, detail };
}

function renderField(f) {
  const id = 'f_' + f.k;
  const hint = typeof f.hint === 'function' ? f.hint(vals) : f.hint;
  const hintHtml = hint ? `<div class="hint">${hint}</div>` : '';
  const label = `<label for="${id}">${esc(f.label)}</label>`;
  const errSlot = `<div class="ferr" id="err_${f.k}" hidden></div>`;
  if (f.type === 'party' || f.type === 'property' || f.type === 'deal') {
    return `<div class="field" data-field="${f.k}">${label}<div id="pick_${f.k}"></div>${hintHtml}${errSlot}</div>`;
  }
  if (f.type === 'alloc') {
    return `<div class="field" data-field="${f.k}">${label}<div id="alloc_${f.k}"></div>${hintHtml}${errSlot}</div>`;
  }
  if (f.type === 'select') {
    const opts = typeof f.opts === 'function' ? f.opts(vals) : (f.opts || []);
    const cur = vals[f.k] ?? f.def ?? (opts[0] ? opts[0][0] : '');
    return `<div class="field" data-field="${f.k}">${label}
      <select id="${id}" data-k="${f.k}">
        ${opts.length ? '' : '<option value="">— nothing available —</option>'}
        ${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>${hintHtml}${errSlot}</div>`;
  }
  const val = vals[f.k] ?? f.def ?? '';
  if (f.type === 'number' && AMOUNT_KEYS.has(f.k)) {
    return `<div class="field amt" data-field="${f.k}">${label}
      <input type="text" inputmode="decimal" enterkeyhint="next" id="${id}" data-k="${f.k}" data-money="1" value="${esc(fmtIN(val))}" ${f.required ? 'required' : ''}><span class="cur" aria-hidden="true">₹</span>
      ${hintHtml}${errSlot}</div>`;
  }
  const type = f.type === 'number' ? 'number' : f.type;
  return `<div class="field" data-field="${f.k}">${label}
    <input type="${type}" id="${id}" data-k="${f.k}" value="${esc(val)}"
      ${f.type === 'number' ? 'inputmode="decimal" step="0.01" min="0"' : ''} ${f.required ? 'required' : ''}>
    ${hintHtml}${errSlot}</div>`;
}

function buildForm() {
  const form = document.getElementById('evForm');
  if (!form) return;
  const fields = fieldsFor(evKey, vals);

  const { core, detail } = splitFields(fields);
  const names = detail.map(f => f.label.toLowerCase()).slice(0, 4).join(', ') + (detail.length > 4 ? '…' : '');
  form.innerHTML = core.map(renderField).join('') + (detail.length ? `
    <details class="more" id="moreDetails" ${moreOpen ? 'open' : ''}>
      <summary><span class="lbl">More details</span><span class="n">(${detail.length}) — ${esc(names)}</span><span class="flag" id="moreFlag"></span></summary>
      <div class="body">${detail.map(renderField).join('')}</div>
    </details>` : '');
  document.getElementById('moreDetails')?.addEventListener('toggle', e => { moreOpen = e.target.open; });

  // Seed any defaults that have not been typed yet, so the preview reflects the visible form.
  // A field that only just appeared (the GST rate, once GST is switched on) gets its default
  // here — AFTER the select's onchange already ran without it — so the event's onchange is
  // run again for each seeded key and the inputs are refreshed, otherwise the tax and total
  // would sit at zero until the user touched the rate by hand.
  const seeded = [];
  for (const f of fields) {
    if (vals[f.k] === undefined) {
      if (f.type === 'select') {
        const opts = typeof f.opts === 'function' ? f.opts(vals) : (f.opts || []);
        vals[f.k] = f.def ?? (opts[0] ? opts[0][0] : '');
      } else if (f.def !== undefined) {
        vals[f.k] = f.def;
      } else {
        continue;
      }
      seeded.push(f.k);
    }
  }
  if (seeded.length && EV[evKey].onchange) {
    for (const k of seeded) EV[evKey].onchange(k, vals);
    syncInputs(null);
  }
  // A default can reveal a field — GST switched on shows the GST rate. Rebuild once so it is
  // on the form from the first paint, not after the next keystroke; without this the form
  // could say "GST % must be above zero" with no GST % box anywhere to type into.
  const nowKeys = fieldsFor(evKey, vals).map(f => f.k).join('|');
  if (nowKeys !== fields.map(f => f.k).join('|') && !rebuilding) {
    rebuilding = true;
    try { buildForm(); } finally { rebuilding = false; }
    return;
  }

  // Text and number fields never rebuild the form, so typing never loses focus: the event's
  // onchange runs (that is where the GST maths lives) and any OTHER input whose value it
  // changed is updated in place. Selects rebuild, because they can change which fields show.
  // Some fields appear because of a NUMBER, not a select: the "why it differs" reason once
  // the amount is not the expected one, the over-payment choice once the amount exceeds what
  // is owed, the second petty-cash row once the first has a figure. So after every keystroke
  // the visible set is compared and the form is rebuilt only when it changed — with focus
  // put back where it was, so typing is never interrupted.
  const visibleKeys = () => fieldsFor(evKey, vals).map(f => f.k).join('|');
  let shown = visibleKeys();
  form.querySelectorAll('input[data-k]').forEach(el => {
    // The amount shows Indian grouping when it is not being edited, and never stores it.
    if (el.dataset.money) {
      el.addEventListener('focus', () => { el.value = rawIN(el.value); });
      el.addEventListener('blur', () => { el.value = fmtIN(el.value); });
    }
    el.addEventListener('blur', () => { if (String(el.value).trim() !== '' || touched.has(el.dataset.k)) { touched.add(el.dataset.k); updatePreview(); } });
    el.oninput = () => {
      vals[el.dataset.k] = el.dataset.money ? rawIN(el.value) : el.value;
      EV[evKey].onchange?.(el.dataset.k, vals);
      syncInputs(el);
      const now = visibleKeys();
      if (now !== shown) {
        const id = el.id, pos = el.selectionStart;
        buildForm();
        const again = document.getElementById(id);
        if (again) { again.focus(); try { if (pos !== null && pos !== undefined) again.setSelectionRange(pos, pos); } catch { /* number inputs */ } }
        return;
      }
      const allocField = fields.find(f => f.type === 'alloc');
      if (allocField && el.dataset.k === 'amt') mountAlloc(allocField);
      updatePreview();
    };
  });
  form.querySelectorAll('select[data-k]').forEach(el => {
    el.onchange = () => {
      touched.add(el.dataset.k);
      vals[el.dataset.k] = el.value;
      EV[evKey].onchange?.(el.dataset.k, vals);
      buildForm();
    };
  });

  for (const f of fields) {
    if (f.type === 'party') mountPartyPicker(f);
    if (f.type === 'property') mountPropertyPicker(f);
    if (f.type === 'deal') mountDealPicker(f);
    if (f.type === 'alloc') mountAlloc(f);
  }

  updatePreview();
}

// ═══════ ALLOCATION TABLE ═══════
//
// A payment is applied to the open documents of the party — bills when paying a vendor,
// invoices when a client pays. The split is proposed oldest-first and every row can be
// edited, so a client who says "this is for the October invoice" can be recorded that way.
// The rows live in vals.alloc as [{id, amt, due}] and go to the ledger as allocations.

function allocDocs(f) {
  const pid = vals[f.partyKey];
  if (!pid) return [];
  return f.source === 'bills' ? openBills(pid) : openInvoices(pid);
}

function mountAlloc(f) {
  const box = document.getElementById('alloc_' + f.k);
  if (!box) return;
  const docs = allocDocs(f);
  const isBill = f.source === 'bills';
  const outstanding = isBill ? billOutstanding : invoiceOutstanding;
  if (!docs.length) {
    box.innerHTML = `<p class="small faint" style="margin:0">No open ${isBill ? 'bills' : 'invoices'} on record for them — the payment will reduce their balance as a whole.</p>`;
    return;
  }
  const rows = vals[f.k] || [];
  const amtFor = id => num(rows.find(r => r.id === id)?.amt);
  const applied = rows.reduce((a, r) => a + num(r.amt), 0);
  const paying = num(vals.amt) + (isBill && vals.useAdvance !== 'no' ? Math.min(vendorAdvance(vals[f.partyKey]), bal('2000', { party: vals[f.partyKey] })) : 0);
  box.innerHTML = `
    <div class="tbl-wrap alloc"><table>
      <thead><tr><th>${isBill ? 'Bill' : 'Invoice'}</th><th>Due</th><th class="n">Open</th><th class="n">Apply</th></tr></thead>
      <tbody>${docs.map(d => `<tr>
        <td>${isBill ? esc(d.desc) : `<span class="eno">${esc(d.invoiceNo)}</span>`}<br><span class="small faint">${esc(d.date)}${isBill && d.billNo ? ' · ' + esc(d.billNo) : ''}</span></td>
        <td class="small ${d.dueDate && d.dueDate < today() ? 'neg' : ''}">${esc(d.dueDate || '—')}</td>
        <td class="n">${fmt(outstanding(d))}</td>
        <td class="n"><input type="number" inputmode="decimal" step="0.01" min="0" max="${outstanding(d)}" data-alloc="${esc(d.id)}" value="${amtFor(d.id) || ''}" aria-label="Apply to ${esc(isBill ? d.desc : d.invoiceNo)}"></td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2">Applied</td><td class="n small faint">of ${fmt(paying)}</td><td class="n ${applied > paying + 0.005 ? 'neg' : ''}">${fmt(applied)}</td></tr></tfoot>
    </table></div>
    <div class="actions" style="margin:8px 0 0">
      <button class="btn ghost sm" type="button" data-autoalloc>Oldest first</button>
    </div>`;
  box.querySelectorAll('input[data-alloc]').forEach(el => {
    el.oninput = () => {
      const id = el.dataset.alloc;
      const d = docs.find(x => x.id === id);
      const next = (vals[f.k] || []).filter(r => r.id !== id);
      const amt = Math.max(0, Math.min(num(el.value), outstanding(d)));
      if (amt > 0) next.push({ id, amt, due: outstanding(d) });
      vals[f.k] = docs.map(x => next.find(r => r.id === x.id)).filter(Boolean);
      // Keep the footer honest without rebuilding the inputs under the user's fingers.
      const tot = vals[f.k].reduce((a, r) => a + num(r.amt), 0);
      const foot = box.querySelector('tfoot td:last-child');
      if (foot) { foot.textContent = fmt(tot); foot.classList.toggle('neg', tot > paying + 0.005); }
      updatePreview();
    };
  });
  box.querySelector('[data-autoalloc]').onclick = () => {
    vals[f.k] = allocate(paying, docs, outstanding).rows;
    mountAlloc(f);
    updatePreview();
  };
}

// Field-level problems, painted under the fields they belong to. Warnings advise in amber;
// errors block in red. The first error is also what the save bar says.
function paintProblems(problems) {
  document.querySelectorAll('#evForm .ferr').forEach(el => { el.hidden = true; el.textContent = ''; el.className = 'ferr'; });
  document.querySelectorAll('#evForm .field').forEach(el => el.classList.remove('has-err', 'has-warn'));
  const general = [];
  let inFold = 0;
  for (const p of problems) {
    const slot = p.k ? document.getElementById('err_' + p.k) : null;
    if (!slot) { general.push(p); continue; }
    if (slot.textContent) continue;
    const foldedAway = !!slot.closest('details.more');
    // An error is shown under a field only once the user has been to it — a fresh form is not
    // wrong, it is empty. The save bar says what is still needed. Warnings are advice, and
    // show at once.
    if (!p.warn) {
      if (foldedAway) inFold++;
      if (!touched.has(p.k)) continue;
    }
    slot.textContent = p.msg;
    slot.hidden = false;
    slot.classList.add(p.warn ? 'warn' : 'err');
    slot.closest('.field')?.classList.add(p.warn ? 'has-warn' : 'has-err');
  }
  const gen = document.getElementById('formProblems');
  if (gen) gen.innerHTML = general.filter(p => p.warn || touched.size).map(p => `<div class="ferr ${p.warn ? 'warn' : 'err'}" style="margin-bottom:10px">${esc(p.msg)}</div>`).join('');
  const flag = document.getElementById('moreFlag');
  if (flag) flag.textContent = inFold ? `${inFold} to fill` : '';
}

function syncInputs(except) {
  document.querySelectorAll('#evForm input[data-k]').forEach(el => {
    if (el === except) return;
    const want = vals[el.dataset.k];
    if (want === undefined || want === null) return;
    const shown = el.dataset.money && document.activeElement !== el ? fmtIN(want) : String(want);
    if (String(el.value) !== shown) el.value = shown;
  });
}

function mountPartyPicker(f) {
  const box = document.getElementById('pick_' + f.k);
  if (!box) return;
  picker(box, {
    value: vals[f.k] && typeof vals[f.k] === 'string'
      ? getState().parties.find(p => p.id === vals[f.k]) : vals[f.k],
    placeholder: 'Search or add a name',
    allowNew: true,
    newLabel: 'Add',
    describe: p => p.__new ? `${p.name} (new)` : `${p.name}${p.phone ? ' · ' + p.phone : ''}`,
    search: async q => getState().parties
      .filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 12),
    onChange: v => {
      vals[f.k] = v && v.__new ? { __new: true, name: v.name, type: f.partyType || 'other' } : (v ? v.id : null);
      EV[evKey].onchange?.(f.k, vals);
      // A party can change which fields show (an allocation table appears once a vendor is
      // known), so the form is rebuilt; the picker takes its value back from vals.
      if (fieldsFor(evKey, vals).some(x => x.type === 'alloc')) buildForm(); else updatePreview();
    },
  });
}

function mountPropertyPicker(f) {
  const box = document.getElementById('pick_' + f.k);
  if (!box) return;
  picker(box, {
    value: vals[f.k] || null,
    placeholder: 'Search by code or name',
    allowNew: false,
    describe: p => `${p.propertyCode ? p.propertyCode + ' — ' : ''}${p.name}${p.location ? ' · ' + p.location : ''}`,
    search: q => SY.searchProperties(q),
    onChange: v => { vals[f.k] = v; updatePreview(); },
  });
}

function mountDealPicker(f) {
  const box = document.getElementById('pick_' + f.k);
  if (!box) return;
  const opts = (typeof f.opts === 'function' ? f.opts(vals) : f.opts) || [];
  const allowed = new Set(opts.map(o => o[0]));
  picker(box, {
    value: vals[f.k] ? getState().deals.find(d => d.id === vals[f.k]) : null,
    placeholder: opts.length ? 'Search deals' : 'No deals available — add one first',
    allowNew: false,
    // Cancelled deals are offered now — money still moves on them — so the picker has to say
    // which ones are dead, or a cancellation fee and a live brokerage look identical here.
    describe: d => (d.nickname || d.propertyName || d.id) + (d.status === 'cancelled' ? ' · cancelled' : ''),
    search: async q => getState().deals
      .filter(d => allowed.has(d.id))
      .filter(d => !q || (d.nickname + ' ' + (d.propertyName || '') + ' ' + (d.propertyCode || ''))
        .toLowerCase().includes(q.toLowerCase()))
      .slice(0, 12),
    onChange: v => {
      vals[f.k] = v ? v.id : null;
      EV[evKey].onchange?.(f.k, vals);
      buildForm();
    },
  });
}

// Where the money lands, said plainly, with the account code where an accountant can see it:
// "₹5,000 out of Bank (1000) → Rent (5000) · profit −₹5,000". The full debit/credit table
// stays available underneath for anyone who wants it.
const TYPE_WORD = { asset: 'what you own', liability: 'what you owe', equity: 'your capital', income: 'income', expense: 'a cost' };
function postingStrip(lines, out) {
  if (!lines.length) return '';
  const name = a => `${esc(A[a]?.name || a)} <span class="code">${esc(a)}</span>`;
  const froms = lines.filter(l => num(l.cr) > 0).map(l => ({ acc: l.acc, amt: num(l.cr), method: l.method }));
  const tos = lines.filter(l => num(l.dr) > 0).map(l => ({ acc: l.acc, amt: num(l.dr) }));
  const pe = lines.reduce((sum, l) => {
    const a = A[l.acc]; if (!a) return sum;
    if (a.type === 'income') return sum + num(l.cr) - num(l.dr);
    if (a.type === 'expense') return sum - num(l.dr) + num(l.cr);
    return sum;
  }, 0);
  const side = list => list.map(x => `<span class="post-acc">${fmt(x.amt)} ${name(x.acc)}<span class="small faint"> · ${TYPE_WORD[A[x.acc]?.type] || ''}${x.method ? ' · ' + esc(methodLabel(x.method)) : ''}</span></span>`).join('');
  return `<div class="posting">
    <div class="post-row"><span class="post-lbl">From</span>${side(froms)}</div>
    <div class="post-row"><span class="post-lbl">To</span>${side(tos)}</div>
    <div class="post-row"><span class="post-lbl">Profit</span><span class="${pe > 0.5 ? 'pos' : pe < -0.5 ? 'neg' : 'faint'}">${Math.abs(pe) > 0.5 ? (pe > 0 ? '+' : '−') + fmt(Math.abs(pe)) : 'unchanged'}</span></div>
  </div>`;
}

// The preview is a genuine dry run: it calls the same build() that Save will call, so what is
// shown is exactly what will be posted. It creates nothing.
function updatePreview() {
  const effectsEl = document.getElementById('pvEffects');
  const journalEl = document.getElementById('pvJournal');
  if (!effectsEl) return;

  let out;
  try { out = EV[evKey].build({ ...vals }); }
  catch (e) { console.error(e); out = { desc: '', lines: [], effects: ['Fill in the form.'], incomplete: true }; }

  const problems = validateEvent(evKey, vals);
  const blocking = problems.filter(p => !p.warn);
  const warned = problems.some(p => p.warn);
  paintProblems(problems);

  const lines = (out.lines || []).filter(l => num(l.dr) || num(l.cr));
  const dr = lines.reduce((sum, l) => sum + num(l.dr), 0);
  const cr = lines.reduce((sum, l) => sum + num(l.cr), 0);
  const balanced = Math.abs(dr - cr) < 0.5;
  const createsOnly = !lines.length && ((out.docs || []).length || (out.updates || []).length);
  const nothingYet = !!out.incomplete && !lines.length;

  // Nothing typed yet: one quiet line, not an arrow pointing at "enter the amount".
  const emptyEl = document.getElementById('pvEmpty');
  if (emptyEl) emptyEl.hidden = !nothingYet;
  effectsEl.hidden = nothingYet;
  effectsEl.innerHTML = nothingYet ? '' : (out.effects || []).map(e => `<li>${e}</li>`).join('');

  // The same event, the same total, the same date, saved in the last day — almost always the
  // second press of a button rather than the same thing happening twice.
  const twin = lines.length ? getState().txns.find(t =>
    t.event === evKey && !t.reversedBy && t.date === (vals.date || today()) &&
    Math.abs(num(t.totals?.dr) - dr) < 0.5 && Date.now() - num(t.createdAt) < 86400000) : null;
  const dupEl = document.getElementById('pvDup');
  if (dupEl) dupEl.innerHTML = twin ? note(`<b>Looks like a duplicate.</b> Entry ${entryNo(twin)} — ${esc(twin.desc)}, ${fmt(twin.totals.dr)} — was saved ${Math.max(1, Math.round((Date.now() - twin.createdAt) / 60000))} min ago. Save only if it really happened twice.`) : '';

  const stripEl = document.getElementById('pvPosting');
  if (stripEl) stripEl.innerHTML = nothingYet ? '' : postingStrip(lines, out);

  const jw = document.getElementById('pvJournalWrap');
  if (jw) jw.hidden = nothingYet;
  journalEl.innerHTML = lines.length ? `
    <div class="tbl-wrap"><table>
      <thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead>
      <tbody>${lines.map(l => `<tr>
        <td>${esc(A[l.acc]?.name || l.acc)}${l.party ? `<br><span class="small faint">${esc(pname(l.party))}</span>` : ''}</td>
        <td class="n">${l.dr ? fmt(l.dr) : ''}</td>
        <td class="n">${l.cr ? fmt(l.cr) : ''}</td></tr>`).join('')}
      </tbody>
      <tfoot><tr><td class="${balanced ? 'balanced ok' : 'balanced no'}">
        ${balanced ? 'Balanced ✓' : 'Does not balance'}</td>
        <td class="n">${fmt(dr)}</td><td class="n">${fmt(cr)}</td></tr></tfoot>
    </table></div>`
    : '<p class="small faint">This does not move any money — it only sets something up.</p>';

  const canSave = !out.incomplete && !blocking.length && (balanced || createsOnly) && (lines.length || createsOnly) && !saving;
  document.querySelectorAll('.js-save').forEach(b => { b.disabled = !canSave; if (!saving) b.textContent = twin ? 'Save anyway' : 'Save'; });

  const bar = document.getElementById('barSum');
  if (bar) {
    const files = pendingFiles.length ? ` · ${pendingFiles.length} ${pendingFiles.length === 1 ? 'photo' : 'files'}` : '';
    const chips = (warned ? '<span class="chip">check</span>' : '') + (twin ? '<span class="chip">possible duplicate</span>' : '');
    const fields = fieldsFor(evKey, vals);
    const nameOf = k => fields.find(f => f.k === k)?.label?.toLowerCase() || k;
    if (saving) {
      bar.innerHTML = '<span class="todo">Saving…</span>';
    } else if (blocking.length) {
      // Neutral until the user has been to the field; the bar names what is still needed.
      const shown = blocking.filter(p => touched.has(p.k));
      bar.innerHTML = shown.length ? `<span class="neg">${esc(shown[0].msg)}</span>`
        : blocking.length === 1 ? `<span class="todo">${esc(blocking[0].msg)}</span>`
          : `<span class="todo">${blocking.length} to fill — ${esc([...new Set(blocking.map(p => nameOf(p.k)))].slice(0, 3).join(', '))}</span>`;
    } else if (out.incomplete) {
      bar.innerHTML = `<span class="todo">${esc(String(out.effects?.[0] || 'Fill in the form').replace(/<[^>]+>/g, ''))}</span>`;
    } else if (lines.length) {
      const to = lines.find(l => num(l.dr) > 0);
      const from = lines.find(l => num(l.cr) > 0);
      const where = to ? ` → ${A[to.acc]?.name || to.acc}${from ? ' · from ' + (A[from.acc]?.name || from.acc) : ''}` : '';
      bar.innerHTML = `<b>${fmt(dr)}</b>${esc((out.desc || '').slice(0, 48))}${esc(where)}${chips}${files}`;
    } else {
      bar.innerHTML = `<b>Ready</b>${esc(String(out.effects?.[0] || 'Nothing posts').replace(/<[^>]+>/g, '').slice(0, 80))}${chips}${files}`;
    }
  }
}

// ═══════ SAVE RESULT ═══════
//
// After Save the form is replaced by a panel that says exactly what happened. An entry that
// committed but whose attachments failed is reported as that — saved, with a retry for the
// files — because the alternative (an error toast over a still-filled form) is how the same
// ₹684 coffee got saved seven times on the first day.

function resultPanel() {
  const r = result;
  if (r.kind === 'err') {
    return `
      <div class="result err" role="alert">
        <h3>Not saved</h3>
        <p style="margin:6px 0 0">${esc(r.message)}</p>
        <p class="small muted" style="margin:6px 0 0">Nothing was written. Your entries are still in the form.</p>
        <div class="actions">
          <button class="btn primary" type="button" onclick="fin.retryForm()">Back to the form</button>
          <button class="btn" type="button" onclick="fin.pick(null)">Start over</button>
        </div>
      </div>`;
  }

  const title = r.label || EV[r.key]?.title || 'Entry';
  const uploads = r.uploads || [];
  const failed = uploads.filter(u => u.status === 'err').length;
  const busy = uploads.some(u => u.status === 'busy' || u.status === 'pending');
  // "Record another expense" — the daily loop is one tap, and it says what it repeats.
  const noun = String(title).split(/ — | \/ | \(/)[0].toLowerCase().split(' ').slice(0, 3).join(' ');
  // A stale undo is a trap: after half an hour on this panel it is gone; View entry stays.
  const stale = Date.now() - num(r.savedAt) > 30 * 60 * 1000;

  return `
    <div class="result ${failed ? 'warn' : 'ok'} dir-${dirOf(r.key)}" role="status">
      <h3><svg class="tick" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${failed ? 'Saved — but a file did not upload' : 'Saved'} ${dirBadge(r.key)}</h3>
      ${r.total ? `<div class="big">${fmt(r.total)}</div>` : ''}
      <div>${esc(r.desc || title)}</div>
      ${r.no ? `<div class="eno" style="margin-top:4px">Entry ${entryNo(r)}${r.invoiceNo ? ` · Invoice ${esc(r.invoiceNo)}` : ''}</div>` : ''}

      ${uploads.length ? `<ul class="stage" id="uplList">${uploads.map(uploadRow).join('')}</ul>` : ''}

      <div class="actions">
        <button class="btn primary" type="button" id="againBtn" onclick="fin.again()">Record another ${esc(noun)}</button>
        <button class="btn" type="button" onclick="fin.pick(null)">Something else</button>
        ${r.txnId ? `<button class="btn ghost" type="button" onclick="fin.openTxn('${r.txnId}')">View entry</button>` : ''}
        ${r.txnId && !busy && !stale ? `<button class="btn ghost" type="button" onclick="fin.reverse('${r.txnId}')">Undo</button>` : ''}
      </div>
    </div>`;
}

function uploadRow(u, i) {
  const st = u.status === 'ok' ? '<span class="st ok">Attached ✓</span>'
    : u.status === 'err' ? `<span class="st err">Failed</span> <button class="btn sm" type="button" onclick="fin.retryUpload(${i})">Retry</button>`
      : `<span class="st busy">${esc(u.note || 'Waiting…')}</span>`;
  return `<li>
    <div class="pv">${u.preview ? `<img src="${u.preview}" alt="">` : 'PDF'}</div>
    <div class="nm">${esc(u.file.name)}${u.error ? `<br><span class="small neg">${esc(u.error)}</span>` : ''}</div>
    ${st}
  </li>`;
}

function mountResult() {
  const r = result;
  if (r?.kind === 'ok' && (r.uploads || []).some(u => u.status === 'pending')) runUploads();
  document.getElementById('againBtn')?.focus({ preventScroll: true });
}

function refreshUploads() {
  const el = document.getElementById('uplList');
  if (el && result?.uploads) el.innerHTML = result.uploads.map(uploadRow).join('');
  // The heading and the Undo button depend on upload state, so redraw once nothing is moving.
  if (!result?.uploads?.some(u => u.status === 'busy' || u.status === 'pending')) repaint();
}

async function runUploads() {
  const r = result;
  for (const u of r.uploads) {
    if (u.status !== 'pending') continue;
    u.status = 'busy';
    refreshUploads();
    try {
      const att = await SY.uploadAttachment(u.file, r.txnId, msg => { u.note = msg; refreshUploads(); });
      await SY.addAttachments(r.txnId, [att]);
      u.status = 'ok';
      u.error = null;
    } catch (e) {
      u.status = 'err';
      u.error = e.message || 'Upload failed';
    }
    if (result !== r) return;
    refreshUploads();
  }
}

// ═══════ TRANSACTIONS ═══════

let txnFilters = { month: '', event: '', party: '', q: '', channel: '', min: '', max: '', hideReversed: false, moved: 'all' };

const undone = isUndone;

function txns() {
  const s = getState();
  if (!s.txns.length) {
    return `<h1>Transactions</h1>
      ${empty('<b>Nothing recorded yet.</b><br>Every entry you save shows up here, newest first.',
      '<button class="btn primary" type="button" onclick="fin.go(\'record\')">Record something</button>')}`;
  }

  const months = monthOptions(s.txns);
  const events = [...new Set(s.txns.map(t => t.event))].sort();

  const rows = s.txns
    .filter(t => !txnFilters.month || ym(t.date) === txnFilters.month)
    .filter(t => !txnFilters.event || t.event === txnFilters.event)
    .filter(t => !txnFilters.party || t.lines.some(l => l.party === txnFilters.party))
    .filter(t => !txnFilters.q || (t.desc || '').toLowerCase().includes(txnFilters.q.toLowerCase()))
    .filter(t => !txnFilters.channel || t.lines.some(l => l.acc === txnFilters.channel))
    .filter(t => txnFilters.min === '' || num(t.totals?.dr) >= num(txnFilters.min))
    .filter(t => txnFilters.max === '' || num(t.totals?.dr) <= num(txnFilters.max))
    .filter(t => !txnFilters.hideReversed || !undone(t))
    // A reversed entry and its reversal are history, not money: the bank never moved for
    // either. "Every entry" keeps them on the record; the two money views leave them out.
    .filter(t => txnFilters.moved === 'all' || (!undone(t) && (txnFilters.moved === 'cash' ? movesMoney(t) : !movesMoney(t))))
    .sort((a, b) => b.date.localeCompare(a.date) || num(b.no) - num(a.no) || String(b.createdAt).localeCompare(String(a.createdAt)));

  const profitEffect = t => t.lines.reduce((sum, l) => {
    const a = A[l.acc];
    if (!a) return sum;
    if (a.type === 'income') return sum + num(l.cr) - num(l.dr);
    if (a.type === 'expense') return sum - num(l.dr) + num(l.cr);
    return sum;
  }, 0);

  // The In / Out figures count real movements only. A mistaken ₹5,000 payment that was
  // reversed used to show as ₹5,000 out AND ₹5,000 in — two movements that never happened.
  const moved = rows.filter(t => !undone(t))
    .reduce((a, t) => { const m = moneyMoved(t); a.in += m.in; a.out += m.out; return a; }, { in: 0, out: 0 });

  return `
    <h1>Transactions</h1>
    <p class="lead">${rows.length} of ${s.txns.length} entries. Tap any row for the full journal and its attachments.</p>
    <div class="actions" style="align-items:center;gap:14px">
      ${seg([['all', 'Every entry'], ['cash', 'Money moved'], ['accrual', 'Not paid yet']], txnFilters.moved, 'fin.filterMoved')}
      ${txnFilters.moved !== 'accrual' ? `<span class="small muted">In <b class="pos">${fmt(moved.in)}</b> · Out <b class="neg">${fmt(moved.out)}</b></span>` : '<span class="small muted">Bills received and invoices raised — the cost or income is real, the money has not moved yet.</span>'}
    </div>
    <div class="filters">
      <select onchange="fin.filter('month',this.value)" aria-label="Filter by month">
        <option value="">All months</option>
        ${months.map(m => `<option value="${m}" ${txnFilters.month === m ? 'selected' : ''}>${esc(mlabel(m))}</option>`).join('')}
      </select>
      <select onchange="fin.filter('event',this.value)" aria-label="Filter by type">
        <option value="">All types</option>
        ${events.map(e => `<option value="${esc(e)}" ${txnFilters.event === e ? 'selected' : ''}>${esc(EV[e]?.title || (e === 'reverse' ? 'Reversal' : e))}</option>`).join('')}
      </select>
      <input type="search" placeholder="Search description" value="${esc(txnFilters.q)}"
        oninput="fin.filter('q',this.value)" aria-label="Search descriptions">
    </div>
    ${(() => { const on = ['party', 'channel', 'min', 'max', 'hideReversed'].filter(k => txnFilters[k] !== '' && txnFilters[k] !== false).length; return `
    <details class="more filters-more" ${on ? 'open' : ''}>
      <summary><span class="lbl">More filters</span><span class="n">${on ? on + ' on' : 'party, channel, amount'}</span></summary>
      <div class="body filters">`; })()}
      <select onchange="fin.filter('party',this.value)" aria-label="Filter by party">
        <option value="">All parties</option>
        ${s.parties.map(p => `<option value="${p.id}" ${txnFilters.party === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <select onchange="fin.filter('channel',this.value)" aria-label="Paid through">
        <option value="">Any channel</option>
        <option value="1000" ${txnFilters.channel === '1000' ? 'selected' : ''}>Bank / UPI</option>
        <option value="1010" ${txnFilters.channel === '1010' ? 'selected' : ''}>Petty cash</option>
        <option value="2300" ${txnFilters.channel === '2300' ? 'selected' : ''}>Credit card</option>
      </select>
      <input type="number" placeholder="Min ₹" value="${esc(txnFilters.min)}" onchange="fin.filter('min',this.value)" aria-label="Minimum amount">
      <input type="number" placeholder="Max ₹" value="${esc(txnFilters.max)}" onchange="fin.filter('max',this.value)" aria-label="Maximum amount">
      <label class="small" style="display:flex;align-items:center;gap:6px;min-height:44px">
        <input type="checkbox" ${txnFilters.hideReversed ? 'checked' : ''} onchange="fin.filter('hideReversed',this.checked)" style="width:auto;min-height:0"> Hide undone entries</label>
      </div>
    </details>

    ${rows.length ? table(
    `<th>Description</th><th class="desk">#</th><th class="desk">Date</th><th class="n desk">Profit</th><th class="n desk">Money in</th><th class="n desk">Money out</th><th class="phone"></th><th class="phone"></th>`,
    rows.map(t => {
      const pe = profitEffect(t), mm = moneyMoved(t), gone = undone(t);
      const partner = gone ? s.txns.find(x => x.id === (t.reversedBy || t.reversalOf)) : null;
      // An undone pair stays on the list — the record of a mistake is part of the books. The
      // ORIGINAL keeps its figures, struck through: that is what the owner got wrong. The
      // reversal carries nothing but the link back, so it shows dashes.
      const struck = n => n ? `<s class="faint">${fmt(Math.abs(n))}</s>` : '<span class="faint">—</span>';
      const dash = '<span class="faint">—</span>';
      return `<tr class="click${gone ? ' undone' : ''}" onclick="fin.openTxn('${t.id}')">
          <td class="lead">${esc(t.desc)}
            ${t.auto ? tag('auto', 'auto') : ''}
            ${t.reversalOf ? tag('reversal of ' + entryNo(partner), 'rev') : ''}
            ${t.reversedBy ? tag('reversed by ' + entryNo(partner), 'rev') : ''}
            ${(t.attachments || []).length ? tag('📎 ' + t.attachments.length) : ''}</td>
          <td class="eno nowrap desk">${entryNo(t)}</td>
          <td class="nowrap desk">${esc(t.date)}${(() => { const m = t.lines.find(l => l.method)?.method || t.meta?.method; return m ? `<br><span class="small faint">${esc(methodLabel(m))}</span>` : ''; })()}</td>
          <td class="n desk">${t.reversalOf ? dash : t.reversedBy ? struck(pe) : (pe ? signed(pe) : '—')}</td>
          <td class="n desk">${t.reversalOf ? dash : t.reversedBy ? struck(mm.in) : mm.in ? fmt(mm.in) : dash}</td>
          <td class="n desk">${t.reversalOf ? dash : t.reversedBy ? struck(mm.out) : mm.out ? fmt(mm.out) : (movesMoney(t) ? dash : docChip(t))}</td>
          <td class="amt phone">${gone ? '<span class="faint">—</span>' : mm.in && !mm.out ? `<span class="pos">+${fmt(mm.in)}</span>` : mm.out && !mm.in ? `<span>−${fmt(mm.out)}</span>` : mm.in || mm.out ? `<span class="muted">${fmt(Math.max(mm.in, mm.out))}</span>` : (pe ? signed(pe) : docChip(t))}</td>
          <td class="meta phone">${entryNo(t)} · ${esc(t.date.slice(5))}${(() => { const m = t.lines.find(l => l.method)?.method || t.meta?.method; return m ? ' · ' + esc(methodLabel(m)) : ''; })()}</td>
        </tr>`;
    }).join(''), '', { cls: 'ledger' })
      : empty('Nothing matches those filters.')}`;
}

// A bill entry moves no money, and saying "not yet paid" about it for ever is how an owner
// comes to believe a settled bill is still open. The chip reports the document's state now.
function docChip(t) {
  const s = settlementOf(t.id);
  if (!s.state) return '<span class="faint">—</span>';
  if (s.state === 'void') return tag('reversed', 'rev');
  if (s.state === 'settled') return tag('settled ✓', 'ok');
  return `<span class="tag warn">${fmt(s.open)} left</span>`;
}

// The two questions a row cannot answer on its own: what is still open on what this entry
// raised, and which entry settled it.
function settlementBlock(t) {
  const s = settlementOf(t.id);
  if (!s.made.length && !s.settled.length) return '';
  const line = (label, right) => `<tr><td>${label}</td><td class="n">${right}</td></tr>`;
  const docLink = d => d.doc.billNo || d.doc.invoiceNo
    ? `${esc(d.doc.desc || '')} <span class="small faint">${esc(d.doc.billNo || d.doc.invoiceNo)}</span>`
    : esc(d.doc.desc || '');

  const made = s.made.map(m => `
    <div class="docrow" style="display:block">
      <div><b>${esc(m.who || 'Party')}</b> — ${docLink(m)}
        ${m.status === 'void' ? tag('reversed', 'rev') : m.outstanding <= 0.5 ? tag('settled ✓', 'ok') : tag(fmt(m.outstanding) + ' still open', 'warn')}</div>
      <div class="small muted">${fmt(m.total)} ${m.coll === 'bills' ? 'owed' : 'invoiced'}${m.doc.dueDate ? ', due ' + esc(m.doc.dueDate) : ''}${m.doc.period && m.doc.period !== ym(m.doc.date) ? `, counted as ${esc(mlabel(m.doc.period))}` : ''}</div>
      ${m.payments.length ? `<div class="tbl-wrap" style="margin-top:6px"><table><tbody>
        ${m.payments.map(p => `<tr class="click" onclick="fin.openTxn('${esc(p.txnId)}')">
          <td class="small">${p.reversal ? 'Reversed' : p.writtenOff ? 'Written off' : p.creditNote ? 'Credit note' : 'Paid'}
            ${p.no ? `<span class="eno">#${String(p.no).padStart(4, '0')}</span>` : ''}
            <span class="faint">${esc(p.date || '')}</span></td>
          <td class="n">${fmt(p.amt)}</td></tr>`).join('')}
      </tbody></table></div>`
      : `<div class="small faint" style="margin-top:4px">Nothing has been ${m.coll === 'bills' ? 'paid against this yet' : 'received against this yet'}.</div>`}
      ${m.outstanding > 0.5 && m.status !== 'void' && m.coll === 'invoices' && m.payments.some(p => !p.reversal) && m.outstanding < m.total * 0.25
      ? `<p class="small muted" style="margin:6px 0 0">Part-paid, with ${fmt(m.outstanding)} left. If the client short-paid that, record a payment of <b>0</b> with ${fmt(m.outstanding)} in "Discount you gave them" — the invoice closes and the difference is booked properly.</p>` : ''}
      ${m.outstanding > 0.5 && m.status !== 'void' ? `<div class="actions" style="margin:8px 0 0">
        ${m.coll === 'bills'
      ? `<button class="btn sm out" type="button" onclick="fin.closeModal();fin.record('paybill',{party:'${esc(m.doc.partyId)}'})">Pay this</button>
             <button class="btn ghost sm" type="button" onclick="fin.closeModal();fin.record('billclose',{party:'${esc(m.doc.partyId)}',bill:'${esc(m.doc.id)}'})">Close the ${fmt(m.outstanding)}</button>
             ${!m.doc.billNo ? `<button class="btn ghost sm" type="button" onclick="fin.closeModal();fin.record('billarrived',{billId:'${esc(m.doc.id)}'})">Bill arrived</button>` : ''}`
      : `<button class="btn sm in" type="button" onclick="fin.closeModal();fin.record('dealpay',{party:'${esc(m.doc.partyId)}'})">Record payment</button>`}
      </div>` : ''}
    </div>`).join('');

  const settled = s.settled.map(x => `
    <div class="docrow" style="display:block">
      <div><b>${esc(x.who || 'Party')}</b> — ${docLink(x)} <span class="small">${fmt(x.amt)} of ${fmt(x.total)}</span></div>
      <div class="small muted">${x.outstanding <= 0.5 ? 'Closed in full.' : `${fmt(x.outstanding)} still open on it.`}
        ${x.madeNo ? `Raised by <a href="#" onclick="event.preventDefault();fin.openTxn('${esc(x.madeBy)}')">#${String(x.madeNo).padStart(4, '0')}</a>.` : ''}</div>
    </div>`).join('');

  return `
    <h3 style="margin-top:16px">Where this stands</h3>
    ${s.made.length ? `<p class="small muted" style="margin:0 0 6px">This entry raised ${s.made.length === 1 ? 'a document' : 'documents'}. No money moved on this entry — the payment is its own entry.</p>${made}` : ''}
    ${s.settled.length ? `<p class="small muted" style="margin:${s.made.length ? '12px' : '0'} 0 6px">This entry settled:</p>${settled}` : ''}`;
}

function attachmentGrid(t) {
  const atts = t.attachments || [];
  if (!atts.length) return '<p class="small faint">Nothing attached.</p>';
  return `<div class="att-grid">${atts.map((a, i) => `
    <div class="att">
      <a href="${esc(a.url)}" target="_blank" rel="noopener" title="Open ${esc(a.name)}">
        <div class="img">${a.thumb || a.type?.startsWith('image/')
      ? `<img src="${esc(a.thumb || a.url)}" alt="${esc(a.name)}" loading="lazy" data-kind="${a.type?.includes('pdf') ? 'PDF' : 'Open'}">`
      : (a.type?.includes('pdf') ? 'PDF' : 'Open')}</div>
        <div class="cap">${esc(a.name)}</div>
      </a>
      <button type="button" class="del" data-del="${i}" aria-label="Remove ${esc(a.name)}">✕</button>
    </div>`).join('')}</div>`;
}

// ═══════ WHAT IS BEHIND A FIGURE ═══════
//
// Any total on any page can be opened. The drawer lists the entries the figure is made of,
// each one clickable through to the full journal, with the same total at the bottom so it is
// obvious nothing has been left out. "Show these in Transactions" hands the same filter to the
// list, so the drill-down is a way in rather than a dead end.
function explainFigure(json) {
  let spec;
  try { spec = typeof json === 'string' ? JSON.parse(json) : json; } catch { return; }
  const title = spec.title || 'This figure';
  const when = spec.month ? mlabel(spec.month)
    : spec.fy ? 'FY ' + spec.fy
      : spec.from || spec.to ? `${spec.from || 'the start'} to ${spec.to || 'today'}` : 'all time';
  // Read inside the same record the page was rendered in, or the parts would not add up to
  // the total that was clicked. Balances follow the record like everything else, because a
  // record is whole: what clients owe in the cash book is what the cash book's own clients owe.
  const res = SCOPED_VIEWS.has(view) ? scoped(() => explain(spec)) : explain(spec);

  modal({
    title: `${title} — ${fmt(res.total)}`,
    body: `
      <p class="small muted" style="margin:0 0 10px">${res.count} ${res.count === 1 ? 'entry' : 'entries'} · ${esc(when)}${spec.party ? ' · ' + esc(pname(spec.party)) : ''}${spec.moved ? ' · money that actually moved' : ''}.
      ${spec.note ? esc(spec.note) : 'Tap any row for the full entry.'}</p>
      ${res.rows.length ? table(
      `<th>Entry</th><th>Date</th><th class="n">Amount</th>`,
      res.rows.map(r => `<tr class="click" onclick="fin.closeModal();fin.openTxn('${esc(r.txnId)}')">
          <td class="lead">${esc(r.desc)}
            ${r.auto ? tag('auto', 'auto') : ''}${r.reversed ? tag('reversed', 'rev') : ''}${r.reversal ? tag('reversal', 'rev') : ''}
            ${r.party ? `<br><span class="small faint">${esc(pname(r.party))}</span>` : ''}</td>
          <td class="nowrap small" data-label="Date">${esc(r.date)}${r.no ? `<br><span class="eno">#${String(r.no).padStart(4, '0')}</span>` : ''}</td>
          <td class="n" data-label="Amount">${fmt(r.amt)}</td>
        </tr>`).join(''),
      `<tr><td colspan="2">Total</td><td class="n">${fmt(res.total)}</td></tr>`, { stack: true })
      : empty('No entries make up this figure. It comes from a document, a commitment or a schedule rather than from the ledger — the page it sits on says which.')}`,
    foot: res.rows.length
      ? `<button class="btn" type="button" onclick="fin.showInTxns('${esc(JSON.stringify(spec))}')">Show these in Transactions</button>`
      : '',
  });
}

// Hand the same filter to the Transactions list, so a drill-down leads somewhere.
function showInTxns(json) {
  let spec;
  try { spec = typeof json === 'string' ? JSON.parse(json) : json; } catch { return; }
  closeModal();
  txnFilters.month = spec.month || '';
  txnFilters.event = spec.event || '';
  txnFilters.party = spec.party || '';
  txnFilters.moved = spec.moved ? 'moved' : 'all';
  txnFilters.q = '';
  go('txns');
}

function openTxn(id) {
  const t = getState().txns.find(x => x.id === id);
  if (!t) return;
  const partner = getState().txns.find(x => x.id === (t.reversedBy || t.reversalOf));
  modal({
    title: t.desc || 'Transaction',
    body: `
      <p class="small muted" style="margin:0 0 10px">
        <span class="eno">${entryNo(t)}</span> · ${esc(t.date)} · ${esc(EV[t.event]?.title || LEGACY_EVENT[t.event] || t.event)}
        ${(() => { const m = t.lines.find(l => l.method)?.method || t.meta?.method; return m ? ' · ' + esc(methodLabel(m)) : ''; })()}
        ${t.meta?.ref ? ' · ref ' + esc(t.meta.ref) : ''}${t.selfInvoiceNo ? ' · self-invoice ' + esc(t.selfInvoiceNo) : ''}
        · by ${esc(t.createdBy || '—')}
        ${t.reversedBy ? ` · <b>reversed by ${entryNo(partner)}</b>` : ''}${t.reversalOf ? ` · reversal of ${entryNo(partner)}` : ''}</p>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead>
        <tbody>${t.lines.map(l => `<tr>
          <td>${esc(A[l.acc]?.name || l.acc)}
            ${l.party ? `<br><span class="small faint">${esc(pname(l.party))}</span>` : ''}
            ${l.deal ? `<br><span class="small faint">${esc(dname(l.deal))}</span>` : ''}</td>
          <td class="n">${l.dr ? fmt(l.dr) : ''}</td>
          <td class="n">${l.cr ? fmt(l.cr) : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td class="n">${fmt(t.totals?.dr)}</td><td class="n">${fmt(t.totals?.cr)}</td></tr></tfoot>
      </table></div>

      ${settlementBlock(t)}

      <h3 style="margin-top:16px">Attachments</h3>
      <div id="drawerAtts">${attachmentGrid(t)}</div>
      <div class="actions" style="margin-top:10px">
        <label class="btn sm" style="cursor:pointer"><i class="fa-solid fa-camera" aria-hidden="true"></i> Add photo
          <input type="file" class="js-late" accept="image/*" capture="environment" hidden></label>
        <label class="btn sm" style="cursor:pointer">Add file
          <input type="file" class="js-late" accept="image/*,application/pdf" multiple hidden></label>
      </div>
      <p class="small faint" style="margin:8px 0 0">Ref ${esc(t.id)}</p>`,
    foot: t.reversalOf ? `<button class="btn" type="button" onclick="fin.openTxn('${esc(t.reversalOf)}')">This is the reversal of ${entryNo(partner)} — open it</button>`
      : t.reversedBy ? `<span class="small muted">Reversed by ${entryNo(partner)}.</span> <button class="btn sm" type="button" onclick="fin.openTxn('${esc(t.reversedBy)}')">Open it</button>`
        : `<button class="btn danger" type="button" onclick="fin.reverse('${t.id}')">Reverse this entry</button>`,
  });
  wireDrawer(t);
}

function wireDrawer(t) {
  const ov = document.getElementById('ov');

  // A preview that will not load (a file removed from Drive by hand) falls back to a label.
  ov.querySelectorAll('img[data-kind]').forEach(img => {
    img.onerror = () => { img.replaceWith(Object.assign(document.createElement('span'), { textContent: img.dataset.kind })); };
  });

  ov.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      const att = (t.attachments || [])[+b.dataset.del];
      if (!att) return;
      const ok = await confirmDialog({ title: 'Remove this attachment?', message: `<b>${esc(att.name)}</b> is deleted from Drive and unlinked from this entry.`, confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      try {
        await SY.removeAttachment(t.id, att);
        toast('Removed');
        setTimeout(() => openTxn(t.id), 300);
      } catch (e) { toast(e.message || 'Could not remove'); }
    };
  });

  ov.querySelectorAll('.js-late').forEach(input => {
    input.onchange = async e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      let done = 0;
      for (const f of files) {
        try {
          toast(`Uploading ${f.name}…`);
          const att = await SY.uploadAttachment(f, t.id, msg => toast(`${f.name}: ${msg}`));
          await SY.addAttachments(t.id, [att]);
          done++;
        } catch (err) {
          toast(`${f.name}: ${err.message || 'upload failed'}`);
        }
      }
      if (done) { toast(`Attached ${done} file${done === 1 ? '' : 's'}`); setTimeout(() => openTxn(t.id), 300); }
    };
  });
}

// ═══════ ACTIONS EXPOSED TO INLINE HANDLERS ═══════

function startEvent(key, preset = {}, label = null, id = null) {
  evKey = key;
  evLabel = label;
  evId = id || ITEMS.find(it => it.key === key && !it.preset)?.id || key;
  evPreset = { ...preset };
  vals = { ...preset };
  pendingFiles = [];
  result = null;
  saveErr = null;
  touched = new Set();
  moreOpen = false;
  if (EV[key]?.onchange) for (const k of Object.keys(preset)) EV[key].onchange(k, vals);
  // A preset picks the party; the amount default lands during buildForm's seeding, so the
  // amount onchange runs again then. Nothing else to do here.
}

window.fin = {
  go, repaint,
  explain: explainFigure, showInTxns,

  retryBoot: () => SY.retryBoot(),
  openSheet: () => window.AppNav?.open(),

  findAction(q, refocus) {
    findQ = String(q || '');
    if (refocus) { const inp = document.getElementById('actFind'); if (inp) { inp.value = ''; inp.focus(); } }
    redrawChooser();
  },
  findKey(e) {
    if (e.key === 'Enter') { const hits = searchItems(findQ); if (hits && hits[0]) { e.preventDefault(); window.fin.pickId(hits[0].id); } }
    if (e.key === 'Escape') { e.preventDefault(); window.fin.findAction('', true); }
  },
  // Opening a category, or going back to all of them. Opening one scrolls its actions into
  // view so a tap at the bottom of the tiles on a phone lands on the list, not on nothing.
  pickGroup(g) {
    groupPick = g || '';
    redrawChooser();
    if (groupPick) document.getElementById('chooser')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    else window.scrollTo(0, 0);
  },
  // The phone's preview: the same card, moved into a sheet one tap from Save, with its own
  // Save so "check, then save" is a single gesture.
  openPreview() {
    const sheet = document.getElementById('pvSheet'), host = document.getElementById('pvHost'), pv = document.getElementById('preview');
    if (!sheet || !host || !pv) return;
    host.appendChild(pv);
    sheet.classList.add('open');
    sheet.querySelector('h3')?.focus({ preventScroll: true });
  },
  closePreview() {
    const sheet = document.getElementById('pvSheet');
    const pv = document.getElementById('pvHost')?.querySelector('#preview');
    if (!sheet || !sheet.classList.contains('open')) return;
    sheet.classList.remove('open');
    if (pv) document.querySelector('.record-split')?.appendChild(pv);
    document.querySelector('.save-bar .pv-open')?.focus({ preventScroll: true });
  },
  setScope(mode) {
    setScope(mode);
    try { sessionStorage.setItem('fin.scope', mode); } catch { }
    paintScope();
    repaint();
  },

  pick(k) {
    window.fin.closePreview();
    if (k) startEvent(k);
    else { evKey = null; evLabel = null; evId = null; evPreset = {}; vals = {}; pendingFiles = []; result = null; saveErr = null; touched = new Set(); }
    repaint();
  },

  pickId(id) {
    const it = itemById(id);
    if (!it) return;
    startEvent(it.key, it.preset || {}, it.label || null, it.id);
    repaint();
  },

  // Open the Record screen on a specific event with some fields already filled — used by the
  // "Pay", "Record payment" and similar buttons on the other views.
  record(k, preset = {}) {
    startEvent(k, preset);
    go('record');
  },

  // "Record another" keeps the same event and the pre-filled fields it started with.
  again() {
    const r = result;
    startEvent(r.key, r.preset || {}, r.label || null, r.id || null);
    repaint();
  },

  retryForm() {
    const r = result;
    vals = { ...(r.vals || {}) };
    pendingFiles = r.files || [];
    result = null;
    saveErr = null;
    repaint();
  },

  retrySave() {
    saveErr = null;
    const el = document.getElementById('saveErr');
    if (el) el.innerHTML = '';
    updatePreview();
  },

  filterMoved(v) { txnFilters.moved = v; repaint(); },
  filter(k, v) {
    txnFilters[k] = v;
    const main = document.getElementById('main');
    const scroll = window.scrollY;
    main.innerHTML = txns();
    window.scrollTo(0, scroll);
  },

  openTxn,

  async save() {
    if (saving) return;
    saving = true;
    saveErr = null;
    document.getElementById('evForm')?.setAttribute('aria-busy', 'true');
    document.querySelectorAll('.js-save').forEach(b => { b.disabled = true; b.setAttribute('aria-busy', 'true'); });
    const barEl = document.getElementById('barSum');
    if (barEl) barEl.innerHTML = '<span class="todo">Saving…</span>';

    const key = evKey, label = evLabel, preset = { ...evPreset }, id = evId;
    const snapshotVals = { ...vals };
    const files = [...pendingFiles];

    try {
      const r = await SY.save(key, vals);
      // From here the entry is committed. Whatever happens to the files next must never be
      // presented as "not saved".
      // A save that began on a statement line goes back to match that line.
      if (window.finBank?.onSaved) window.finBank.onSaved(r.txnId, key, snapshotVals);
      noteUse(id);
      result = {
        kind: 'ok', key, label, preset, id, savedAt: Date.now(), ...r,
        uploads: files.map(f => ({
          file: f, status: 'pending',
          preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
        })),
      };
      vals = {};
      pendingFiles = [];
      touched = new Set();
    } catch (e) {
      // The form stays exactly as it was, with the reason above the bar. Nobody loses their
      // place, or their figures, to a dropped connection.
      saveErr = e.message || 'Could not save';
      result = null;
    } finally {
      saving = false;
    }
    window.fin.closePreview();
    repaint();
    if (result) window.scrollTo(0, 0);
    else document.getElementById('saveErr')?.scrollIntoView({ block: 'center' });
  },

  async retryUpload(i) {
    const r = result;
    const u = r?.uploads?.[i];
    if (!u || u.status === 'busy') return;
    u.status = 'pending';
    runUploads();
  },

  async reverse(id, silent) {
    if (!silent) {
      const t0 = getState().txns.find(x => x.id === id);
      const closed = t0 && getState().monthEnds[ym(t0.date)];
      const ok = await confirmDialog({
        title: 'Reverse this entry?',
        message: 'A matching opposite entry is posted so the two cancel out. <b>Both stay on the record</b> — nothing is deleted, which is what keeps the books auditable. '
          + (closed ? `<b>${esc(mlabel(ym(t0.date)))} is closed</b>, so the correction is dated today: that month's figures stand and this month carries the fix.`
            : 'It is dated on the original\'s day, so the mistake leaves that month entirely.'),
        confirmLabel: 'Reverse it',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const r = await SY.reverse(id);
      closeModal();
      if (result?.txnId === id) result = null;
      toast(`Reversed with entry ${entryNo(r)} — both stay on record`);
      if (view === 'record') repaint();
    } catch (e) { toast(e.message || 'Could not reverse'); }
  },

  async monthEnd() {
    const month = document.getElementById('meMonth').value;
    if (!month) return toast('Pick a month');
    const s = getState();

    // The bank statement is the only external check on the books, so month-end is gated on it.
    const me = s.monthEnds[month];
    if (!me?.reconciled) {
      const ok = await confirmDialog({
        title: `${mlabel(month)} is not reconciled`,
        message: 'This month has not been matched against a bank statement yet, so the books have not been checked against anything external. You can override, and the override is recorded against your name.',
        confirmLabel: 'Run anyway',
      });
      if (!ok) return;
      try {
        const n = await SY.runMonthEnd(month, { overrodeReconciliation: true });
        toast(`Month-end ${mlabel(month)}: ${n} automatic ${n === 1 ? 'entry' : 'entries'}`);
      } catch (e) { toast(e.message || 'Month-end failed'); }
      return;
    }
    try {
      const n = await SY.runMonthEnd(month);
      toast(`Month-end ${mlabel(month)}: ${n} automatic ${n === 1 ? 'entry' : 'entries'}`);
    } catch (e) { toast(e.message || 'Month-end failed'); }
  },

  async setCurrency(code) {
    if (code === 'USD') {
      const { rate, at } = await usdRate();
      setDisplayCurrency('USD', rate, at);
      toast(`Showing US dollars at ₹${rate.toFixed(2)} to $1 — the books stay in rupees`);
    } else {
      setDisplayCurrency('INR');
    }
    try { localStorage.setItem('fin.cur', displayCurrency().code); } catch { }
    paintCurrency();
    repaint();
  },

  async seed() {
    try {
      await SY.seedFinance();
      toast('Chart of accounts created');
      go('opening');
    } catch (e) { toast(e.message || 'Could not seed'); }
  },

  toast, modal, closeModal, confirmDialog, downloadCsv,
  sync: SY,
};
