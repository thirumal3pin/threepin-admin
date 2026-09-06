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
  A, getState, fmt, esc, num, today, ym, addMonths, mlabel,
  pl, cashPosition, serviceRunRate, dname, pname, complianceCalendar, upcomingCash,
  setDisplayCurrency, displayCurrency,
} from './finance-core.js';
import { EV, CHOOSER, fieldsFor } from './finance-events.js';
import * as SY from './finance-sync.js';
import {
  toast, modal, closeModal, confirmDialog, stat, signed, empty, note, tag,
  table, picker, downloadCsv, monthOptions,
} from './ui.js';

import { renderOwed } from './views-owed.js';
import { renderServices, renderLoans, renderAssets } from './views-services.js';
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
const NAV = [
  ['overview', 'Overview', 'fa-solid fa-gauge-high', 'Daily'],
  ['record', 'Record', 'fa-solid fa-plus', 'Daily'],
  ['txns', 'Transactions', 'fa-solid fa-list', 'Daily'],
  ['deals', 'Deals', 'fa-regular fa-handshake', 'Daily'],
  ['owed', 'Owed', 'fa-solid fa-right-left', 'Daily'],
  ['services', 'Services', 'fa-solid fa-rotate', 'Running'],
  ['loans', 'Loans', 'fa-solid fa-percent', 'Running'],
  ['assets', 'Assets', 'fa-regular fa-square', 'Running'],
  ['invoices', 'Invoices', 'fa-regular fa-file-lines', 'Running'],
  ['bank', 'Bank', 'fa-solid fa-building-columns', 'Running'],
  ['gst', 'GST', 'fa-solid fa-stamp', 'Insight'],
  ['analytics', 'Analytics', 'fa-solid fa-chart-column', 'Insight'],
  ['reports', 'Reports', 'fa-regular fa-chart-bar', 'Insight'],
  ['books', 'Books', 'fa-solid fa-book', 'Insight'],
  ['profile', 'Profile', 'fa-regular fa-id-badge', 'Setup'],
  ['settings', 'Settings', 'fa-solid fa-sliders', 'Setup'],
  ['guide', 'Guide', 'fa-regular fa-circle-question', 'Setup'],
];

const BOTTOM = ['overview', 'txns', 'record', 'deals', 'more'];

let view = 'overview';
let ready = false;

const entryNo = t => t?.no ? '#' + String(t.no).padStart(4, '0') : '—';

// ═══════ BOOT ═══════

window.onFinanceAuthChange = (user, tenantId) => {
  const login = document.getElementById('loginScreen');
  const app = document.getElementById('appRoot');
  if (user) {
    login.classList.remove('open');
    app.style.display = '';
    document.getElementById('whoami').textContent = user.email || '';
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
    }
  } else {
    ready = false;
    app.style.display = 'none';
    login.classList.add('open');
  }
};

// A data change repaints every view except Record, where a snapshot echo mid-typing would
// throw away the form. The preview there reads live state on its next keystroke anyway.
window.onFinanceData = () => { if (ready && view !== 'record') repaint(); };

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
window.financeCloseSheet = () => document.getElementById('moreSheet').classList.remove('open');

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); window.financeCloseSheet(); }
});

window.addEventListener('hashchange', routeFromHash);

function routeFromHash() {
  const h = location.hash.replace(/^#/, '');
  view = NAV.some(([k]) => k === h) ? h : 'overview';
  repaint();
}

// ═══════ RENDER ═══════

function go(next) {
  view = next;
  window.financeCloseSheet();
  if (location.hash.replace(/^#/, '') !== next) location.hash = next;
  else repaint();
  document.getElementById('main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function repaint() {
  const s = getState();

  const groups = [...new Set(NAV.map(n => n[3]))];
  document.getElementById('sidenav').innerHTML = groups.map(g => `
    <div class="eh">${esc(g)}</div>
    ${NAV.filter(n => n[3] === g).map(([k, label]) =>
      `<button type="button" class="${view === k ? 'on' : ''}" ${view === k ? 'aria-current="page"' : ''} onclick="fin.go('${k}')">${esc(label)}</button>`).join('')}`).join('');

  document.getElementById('bottomnav').innerHTML = BOTTOM.map(k => {
    if (k === 'more') {
      const on = !BOTTOM.includes(view);
      return `<button type="button" class="${on ? 'on' : ''}" onclick="fin.openSheet()">
                <i class="ic fa-solid fa-ellipsis" aria-hidden="true"></i>More</button>`;
    }
    const [, label, ic] = NAV.find(n => n[0] === k);
    const isRec = k === 'record';
    return `<button type="button" class="${view === k ? 'on' : ''} ${isRec ? 'rec' : ''}" onclick="fin.go('${k}')">
              <i class="ic ${ic}" aria-hidden="true"></i>${esc(label)}</button>`;
  }).join('');

  document.getElementById('sheetGrid').innerHTML = NAV.map(([k, label, ic]) =>
    `<button type="button" class="${view === k ? 'on' : ''}" onclick="fin.go('${k}')">
       <i class="${ic}" aria-hidden="true" style="font-size:16px"></i>${esc(label)}</button>`).join('');

  const main = document.getElementById('main');

  // Before the first snapshot lands there is genuinely nothing to draw.
  if (!s.settingsExists && !s.txns.length && view !== 'settings') {
    main.innerHTML = firstRun();
    return;
  }

  const views = {
    overview, record, txns,
    owed: renderOwed,
    services: renderServices, loans: renderLoans, assets: renderAssets,
    invoices: renderInvoices, bank: renderBank,
    reports: renderReports, books: renderBooks,
    profile: renderProfile, settings: renderSettings, guide: renderGuide, opening: renderOpening,
    deals: renderDeals, gst: renderGst, analytics: renderAnalytics,
  };
  main.innerHTML = (views[view] || overview)();

  // Views that need real event listeners rather than inline handlers wire up here.
  ({
    record: mountRecord, invoices: mountInvoices, bank: mountBank,
    settings: mountSettings, profile: mountProfile, opening: mountOpening,
  })[view]?.();
}

// ═══════ FIRST RUN ═══════

// The security rules read booksStartDate off the settings document before allowing any
// transaction, so seeding is genuinely the first thing that has to happen.
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
      ${stat('Income', fmt(p.ti))}
      ${stat('Expenses', fmt(p.te))}
      ${stat('Profit', signed(p.profit), { raw: true, hero: true })}
      ${stat('Free to use', fmt(cash.free), { sub: 'Cash after vendor dues and client tokens' })}
    </div>

    <h2>Where the money is</h2>
    <div class="grid g3">
      ${stat('Bank', fmt(cash.bank))}
      ${stat('Petty cash', fmt(cash.petty))}
      ${stat('Credit card', fmt(cash.card), { cls: cash.card > 0 ? 'neg' : '', sub: 'Owed' })}
      ${stat('Loans', fmt(cash.loans), { sub: 'Outstanding' })}
    </div>

    <h2>Who owes whom</h2>
    <div class="grid g3">
      ${stat('Clients owe you', fmt(cash.receivable))}
      ${stat('You owe vendors', fmt(cash.vendorDues))}
      ${stat('Tokens held', fmt(cash.tokens), { sub: 'Not yours until the deal registers' })}
      ${stat('GST due', fmt(cash.gstDue), { cls: cash.gstDue > 0 ? 'neg' : '', sub: 'Net of input credit' })}
    </div>
    <div class="actions"><button class="btn" type="button" onclick="fin.go('owed')">Open Owed both ways</button></div>

    <h2>Services</h2>
    <div class="grid g3">
      ${stat('Run rate', fmt(svc.monthly) + '/mo')}
      ${stat('Annual commitment', fmt(svc.annual))}
      ${stat('Prepaid', fmt(svc.prepaidUnused), { sub: 'Sitting with vendors' })}
      ${stat('Active', String(svc.active.length), { sub: 'Services running' })}
    </div>

    <h2>Coming up</h2>
    <div class="grid g1" style="grid-template-columns:1fr 1fr">
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
        <button class="btn primary" type="button" onclick="fin.monthEnd()">Run month-end</button>
      </div>
      ${done.length
      ? `<p class="small muted" style="margin-top:12px">Completed: ${done.map(x => `${esc(mlabel(x))}${s.monthEnds[x].reconciled ? ' ✓' : ''}`).join(' · ')}</p>`
      : '<p class="small faint" style="margin-top:12px">No month has been closed yet.</p>'}
    </div>`;
}

// ═══════ RECORD ═══════
//
// One screen for everything that happens. The chooser picks the event; the form fills it; the
// preview is a live dry run of what saving will do — the only thing standing between the
// user and a wrong entry. Save stays disabled until the journal balances, is disabled again
// the instant it is pressed, and is replaced by an unmistakable result panel afterwards.

let evKey = null;
let evLabel = null;
let evPreset = {};
let vals = {};
let pendingFiles = [];
let saving = false;
let result = null;

function record() {
  if (result) return resultPanel();

  if (!evKey) {
    return `
      <h1>Record what happened</h1>
      <p class="lead">Pick the thing that actually happened. The bookkeeping underneath is worked out for you,
      and you will see exactly what it does before anything is saved.</p>
      <div class="field" style="max-width:420px">
        <input type="search" id="actFind" placeholder="Find an action — rent, token, EMI…" aria-label="Find an action"
          oninput="fin.findAction(this.value)" autocomplete="off">
      </div>
      <div id="chooser">
      ${CHOOSER.map(([group, items], gi) => `
        <div class="chooser-group">
          <div class="eh">${esc(group)}</div>
          <div class="chooser-grid">
            ${items.filter(it => EV[it.key]).map((it, ii) =>
        `<button type="button" onclick="fin.pickAt(${gi},${ii})">
                <b>${esc(it.label || EV[it.key].title)}</b>
                ${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}
              </button>`).join('')}
          </div>
        </div>`).join('')}
      </div>
      <p id="actNone" class="small faint" hidden>Nothing matches — try another word, or clear the box.</p>`;
  }

  const ev = EV[evKey];
  return `
    <div class="actions">
      <button class="btn ghost sm" type="button" onclick="fin.pick(null)">← All actions</button>
    </div>
    <h1>${esc(evLabel || ev.title)}</h1>
    <div class="record-split">
      <div>
        <form id="evForm" autocomplete="off" onsubmit="return false"></form>

        <div class="card" style="margin-top:4px">
          <h3>Attach the bill or receipt</h3>
          <div class="actions" style="margin-bottom:0">
            <label class="btn" style="cursor:pointer">📷 Take photo
              <input type="file" class="js-attach" accept="image/*" capture="environment" hidden></label>
            <label class="btn" style="cursor:pointer">Choose file
              <input type="file" class="js-attach" accept="image/*,application/pdf" multiple hidden></label>
          </div>
          <ul class="stage" id="stageList"></ul>
          <p class="small faint" style="margin:8px 0 0">Photos are shrunk before upload, so a bill from your phone camera is fine. Add as many as you like.</p>
        </div>

        <div class="save-bar">
          <div class="sum" id="barSum">Fill in the form</div>
          <button class="btn primary js-save" type="button" onclick="fin.save()" disabled>Save</button>
        </div>
      </div>

      <div class="preview">
        <div class="card">
          <div class="when">${ev.when}</div>
          <div id="pvDup"></div>
          <h3>What saving this does</h3>
          <ul class="effects" id="pvEffects"></ul>
          <details class="journal">
            <summary>Show the double entry this creates</summary>
            <div id="pvJournal"></div>
          </details>
        </div>
        <div class="actions desk-only">
          <button class="btn primary js-save" type="button" onclick="fin.save()" disabled>Save</button>
        </div>
      </div>
    </div>`;
}

function mountRecord() {
  if (result) { mountResult(); return; }
  if (!evKey) return;
  buildForm();
  document.querySelectorAll('.js-attach').forEach(input => {
    input.addEventListener('change', e => {
      for (const f of e.target.files) pendingFiles.push(f);
      e.target.value = '';
      drawStage();
      updatePreview();
    });
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

function buildForm() {
  const form = document.getElementById('evForm');
  if (!form) return;
  const fields = fieldsFor(evKey, vals);

  form.innerHTML = fields.map(f => {
    const id = 'f_' + f.k;
    const hint = typeof f.hint === 'function' ? f.hint(vals) : f.hint;
    const hintHtml = hint ? `<div class="hint">${hint}</div>` : '';
    const label = `<label for="${id}">${esc(f.label)}</label>`;

    if (f.type === 'party' || f.type === 'property' || f.type === 'deal') {
      return `<div class="field">${label}<div id="pick_${f.k}"></div>${hintHtml}</div>`;
    }
    if (f.type === 'select') {
      const opts = typeof f.opts === 'function' ? f.opts(vals) : (f.opts || []);
      const cur = vals[f.k] ?? f.def ?? (opts[0] ? opts[0][0] : '');
      return `<div class="field">${label}
        <select id="${id}" data-k="${f.k}">
          ${opts.length ? '' : '<option value="">— nothing available —</option>'}
          ${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>${hintHtml}</div>`;
    }
    const val = vals[f.k] ?? f.def ?? '';
    const type = f.type === 'number' ? 'number' : f.type;
    return `<div class="field">${label}
      <input type="${type}" id="${id}" data-k="${f.k}" value="${esc(val)}"
        ${f.type === 'number' ? 'inputmode="decimal" step="0.01"' : ''} ${f.required ? 'required' : ''}>
      ${hintHtml}</div>`;
  }).join('');

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

  // Text and number fields never rebuild the form, so typing never loses focus: the event's
  // onchange runs (that is where the GST maths lives) and any OTHER input whose value it
  // changed is updated in place. Selects rebuild, because they can change which fields show.
  form.querySelectorAll('input[data-k]').forEach(el => {
    el.oninput = () => {
      vals[el.dataset.k] = el.value;
      EV[evKey].onchange?.(el.dataset.k, vals);
      syncInputs(el);
      updatePreview();
    };
  });
  form.querySelectorAll('select[data-k]').forEach(el => {
    el.onchange = () => {
      vals[el.dataset.k] = el.value;
      EV[evKey].onchange?.(el.dataset.k, vals);
      buildForm();
    };
  });

  for (const f of fields) {
    if (f.type === 'party') mountPartyPicker(f);
    if (f.type === 'property') mountPropertyPicker(f);
    if (f.type === 'deal') mountDealPicker(f);
  }

  updatePreview();
}

function syncInputs(except) {
  document.querySelectorAll('#evForm input[data-k]').forEach(el => {
    if (el === except) return;
    const want = vals[el.dataset.k];
    if (want === undefined || want === null) return;
    if (String(el.value) !== String(want)) el.value = want;
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
      updatePreview();
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
    describe: d => d.nickname || d.propertyName || d.id,
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

// The preview is a genuine dry run: it calls the same build() that Save will call, so what is
// shown is exactly what will be posted. It creates nothing.
function updatePreview() {
  const effectsEl = document.getElementById('pvEffects');
  const journalEl = document.getElementById('pvJournal');
  if (!effectsEl) return;

  let out;
  try { out = EV[evKey].build({ ...vals }); }
  catch (e) { out = { desc: '', lines: [], effects: ['Fill in the form.'], incomplete: true }; }

  const lines = (out.lines || []).filter(l => num(l.dr) || num(l.cr));
  const dr = lines.reduce((s, l) => s + num(l.dr), 0);
  const cr = lines.reduce((s, l) => s + num(l.cr), 0);
  const balanced = Math.abs(dr - cr) < 0.5;
  const createsOnly = !lines.length && ((out.docs || []).length || (out.updates || []).length);

  effectsEl.innerHTML = (out.effects || []).map(e => `<li>${e}</li>`).join('');

  // The same event, the same total, the same date, saved in the last day — almost always the
  // second press of a button rather than the same thing happening twice.
  const dupEl = document.getElementById('pvDup');
  if (dupEl) {
    const twin = lines.length ? getState().txns.find(t =>
      t.event === evKey && !t.reversedBy && t.date === (vals.date || today()) &&
      Math.abs(num(t.totals?.dr) - dr) < 0.5 && Date.now() - num(t.createdAt) < 86400000) : null;
    dupEl.innerHTML = twin ? note(`<b>Looks like a duplicate.</b> Entry ${entryNo(twin)} — ${esc(twin.desc)}, ${fmt(twin.totals.dr)} — was saved ${Math.max(1, Math.round((Date.now() - twin.createdAt) / 60000))} min ago. Save only if it really happened twice.`) : '';
  }

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
    : '<p class="small faint">This action does not move money — nothing is posted to the ledger.</p>';

  const canSave = !out.incomplete && (balanced || createsOnly) && (lines.length || createsOnly) && !saving;
  document.querySelectorAll('.js-save').forEach(b => { b.disabled = !canSave; });

  const bar = document.getElementById('barSum');
  if (bar) {
    const files = pendingFiles.length ? ` · ${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'}` : '';
    bar.innerHTML = out.incomplete ? esc(out.effects?.[0] || 'Fill in the form')
      : lines.length ? `<b>${fmt(dr)}</b> · ${balanced ? 'Balanced ✓' : 'Does not balance'}${files}`
        : 'Ready — nothing posts to the ledger' + files;
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
      <div class="result err">
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

  return `
    <div class="result ${failed ? 'warn' : 'ok'}">
      <h3>${failed ? 'Saved — but a file did not upload' : 'Saved ✓'}</h3>
      ${r.no ? `<div class="eno">Entry ${entryNo(r)}${r.invoiceNo ? ` · Invoice ${esc(r.invoiceNo)}` : ''}</div>` : ''}
      ${r.total ? `<div class="big">${fmt(r.total)}</div>` : ''}
      <div>${esc(r.desc || title)}</div>

      ${uploads.length ? `<ul class="stage" id="uplList">${uploads.map(uploadRow).join('')}</ul>` : ''}

      <div class="actions">
        <button class="btn primary" type="button" onclick="fin.again()">Record another</button>
        <button class="btn" type="button" onclick="fin.pick(null)">Something else</button>
        ${r.txnId ? `<button class="btn" type="button" onclick="fin.openTxn('${r.txnId}')">View entry</button>` : ''}
        ${r.txnId && !busy ? `<button class="btn ghost" type="button" onclick="fin.reverse('${r.txnId}')">Undo</button>` : ''}
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

let txnFilters = { month: '', event: '', party: '', q: '', channel: '', min: '', max: '', hideReversed: false };

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
    .filter(t => !txnFilters.hideReversed || !(t.reversedBy || t.reversalOf))
    .sort((a, b) => b.date.localeCompare(a.date) || num(b.no) - num(a.no) || String(b.createdAt).localeCompare(String(a.createdAt)));

  const profitEffect = t => t.lines.reduce((sum, l) => {
    const a = A[l.acc];
    if (!a) return sum;
    if (a.type === 'income') return sum + num(l.cr) - num(l.dr);
    if (a.type === 'expense') return sum - num(l.dr) + num(l.cr);
    return sum;
  }, 0);

  const cashEffect = t => t.lines.reduce((sum, l) =>
    ['1000', '1010'].includes(l.acc) ? sum + num(l.dr) - num(l.cr) : sum, 0);

  return `
    <h1>Transactions</h1>
    <p class="lead">${rows.length} of ${s.txns.length} entries. Tap any row for the full journal and its attachments.</p>
    <div class="filters">
      <select onchange="fin.filter('month',this.value)" aria-label="Filter by month">
        <option value="">All months</option>
        ${months.map(m => `<option value="${m}" ${txnFilters.month === m ? 'selected' : ''}>${esc(mlabel(m))}</option>`).join('')}
      </select>
      <select onchange="fin.filter('event',this.value)" aria-label="Filter by type">
        <option value="">All types</option>
        ${events.map(e => `<option value="${esc(e)}" ${txnFilters.event === e ? 'selected' : ''}>${esc(EV[e]?.title || e)}</option>`).join('')}
      </select>
      <select onchange="fin.filter('party',this.value)" aria-label="Filter by party">
        <option value="">All parties</option>
        ${s.parties.map(p => `<option value="${p.id}" ${txnFilters.party === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <input type="search" placeholder="Search description" value="${esc(txnFilters.q)}"
        oninput="fin.filter('q',this.value)" aria-label="Search descriptions">
      <select onchange="fin.filter('channel',this.value)" aria-label="Paid through">
        <option value="">Any channel</option>
        <option value="1000" ${txnFilters.channel === '1000' ? 'selected' : ''}>Bank / UPI</option>
        <option value="1010" ${txnFilters.channel === '1010' ? 'selected' : ''}>Petty cash</option>
        <option value="2300" ${txnFilters.channel === '2300' ? 'selected' : ''}>Credit card</option>
      </select>
      <input type="number" placeholder="Min ₹" value="${esc(txnFilters.min)}" onchange="fin.filter('min',this.value)" aria-label="Minimum amount">
      <input type="number" placeholder="Max ₹" value="${esc(txnFilters.max)}" onchange="fin.filter('max',this.value)" aria-label="Maximum amount">
      <label class="small" style="display:flex;align-items:center;gap:6px;min-height:44px">
        <input type="checkbox" ${txnFilters.hideReversed ? 'checked' : ''} onchange="fin.filter('hideReversed',this.checked)" style="width:auto;min-height:0"> hide reversed</label>
    </div>

    ${rows.length ? table(
    `<th>#</th><th>Date</th><th>Description</th><th class="n">Profit</th><th class="n">Cash</th><th></th>`,
    rows.map(t => {
      const pe = profitEffect(t), ce = cashEffect(t);
      return `<tr class="click" onclick="fin.openTxn('${t.id}')">
          <td class="eno nowrap">${entryNo(t)}</td>
          <td class="nowrap">${esc(t.date)}</td>
          <td>${esc(t.desc)}
            ${t.auto ? tag('auto', 'auto') : ''}
            ${t.reversalOf ? tag('reversal', 'rev') : ''}
            ${t.reversedBy ? tag('reversed', 'rev') : ''}
            ${(t.attachments || []).length ? tag('📎 ' + t.attachments.length) : ''}</td>
          <td class="n">${pe ? signed(pe) : '—'}</td>
          <td class="n">${ce ? signed(ce) : '—'}</td>
          <td class="n">${t.reversedBy ? '' : `<button class="btn ghost sm" type="button" onclick="event.stopPropagation();fin.reverse('${t.id}')">Reverse</button>`}</td>
        </tr>`;
    }).join(''))
      : empty('Nothing matches those filters.')}`;
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

function openTxn(id) {
  const t = getState().txns.find(x => x.id === id);
  if (!t) return;
  modal({
    title: t.desc || 'Transaction',
    body: `
      <p class="small muted" style="margin:0 0 10px">
        <span class="eno">${entryNo(t)}</span> · ${esc(t.date)} · ${esc(EV[t.event]?.title || t.event)}
        · by ${esc(t.createdBy || '—')}
        ${t.reversedBy ? ' · <b>reversed</b>' : ''}${t.reversalOf ? ' · this is a reversal' : ''}</p>
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

      <h3 style="margin-top:16px">Attachments</h3>
      <div id="drawerAtts">${attachmentGrid(t)}</div>
      <div class="actions" style="margin-top:10px">
        <label class="btn sm" style="cursor:pointer">📷 Add photo
          <input type="file" class="js-late" accept="image/*" capture="environment" hidden></label>
        <label class="btn sm" style="cursor:pointer">Add file
          <input type="file" class="js-late" accept="image/*,application/pdf" multiple hidden></label>
      </div>
      <p class="small faint" style="margin:8px 0 0">Ref ${esc(t.id)}</p>`,
    foot: t.reversedBy ? '<span class="small muted">Already reversed.</span>'
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

function startEvent(key, preset = {}, label = null) {
  evKey = key;
  evLabel = label;
  evPreset = { ...preset };
  vals = { ...preset };
  pendingFiles = [];
  result = null;
  if (EV[key]?.onchange) for (const k of Object.keys(preset)) EV[key].onchange(k, vals);
}

window.fin = {
  go, repaint,

  openSheet: () => document.getElementById('moreSheet').classList.add('open'),

  findAction(q) {
    const needle = String(q || '').trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll('#chooser .chooser-group').forEach(g => {
      let any = false;
      g.querySelectorAll('button').forEach(b => {
        const hit = !needle || b.textContent.toLowerCase().includes(needle);
        b.hidden = !hit;
        if (hit) any = true;
      });
      g.hidden = !any;
      if (any) shown++;
    });
    const none = document.getElementById('actNone');
    if (none) none.hidden = shown > 0;
  },

  pick(k) {
    if (k) startEvent(k);
    else { evKey = null; evLabel = null; evPreset = {}; vals = {}; pendingFiles = []; result = null; }
    repaint();
  },

  pickAt(gi, ii) {
    const it = CHOOSER[gi][1].filter(x => EV[x.key])[ii];
    if (!it) return;
    startEvent(it.key, it.preset || {}, it.label || null);
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
    startEvent(r.key, r.preset || {}, r.label || null);
    repaint();
  },

  retryForm() {
    const r = result;
    vals = { ...(r.vals || {}) };
    pendingFiles = r.files || [];
    result = null;
    repaint();
  },

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
    document.querySelectorAll('.js-save').forEach(b => { b.disabled = true; b.textContent = 'Saving…'; });

    const key = evKey, label = evLabel, preset = { ...evPreset };
    const snapshotVals = { ...vals };
    const files = [...pendingFiles];

    try {
      const r = await SY.save(key, vals);
      // From here the entry is committed. Whatever happens to the files next must never be
      // presented as "not saved".
      result = {
        kind: 'ok', key, label, preset, ...r,
        uploads: files.map(f => ({
          file: f, status: 'pending',
          preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
        })),
      };
      vals = {};
      pendingFiles = [];
    } catch (e) {
      result = { kind: 'err', key, label, preset, message: e.message || 'Could not save', vals: snapshotVals, files };
    } finally {
      saving = false;
    }
    repaint();
    window.scrollTo(0, 0);
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
      const ok = await confirmDialog({
        title: 'Reverse this entry?',
        message: 'A matching opposite entry is posted so the two cancel out. <b>Both stay on the record</b> — nothing is deleted, which is what keeps the books auditable.',
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
