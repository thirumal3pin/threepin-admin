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
  A, ACCOUNTS, EXP, getState, fmt, esc, num, today, ym, addMonths, mlabel,
  pl, bal, cashPosition, serviceRunRate, dname, pname, deal, partySides,
  trialBalance, balanceSheet, prepaidLeft,
} from './finance-core.js';
import { EV, CHOOSER, fieldsFor, PARTY_FIELDS } from './finance-events.js';
import * as SY from './finance-sync.js';
import {
  toast, modal, closeModal, confirmDialog, stat, signed, empty, loading, note, tag,
  table, picker, downloadCsv, monthOptions, daysAgo, attachmentStrip,
} from './ui.js';

import { renderOwed } from './views-owed.js';
import { renderServices, renderLoans, renderAssets } from './views-services.js';
import { renderInvoices, mountInvoices } from './views-invoices.js';
import { renderBank, mountBank } from './views-bank.js';
import { renderReports, renderBooks } from './views-reports.js';
import { renderSettings, mountSettings, renderProfile, mountProfile, renderGuide, renderOpening, mountOpening } from './views-admin.js';

// ═══════ NAVIGATION ═══════
//
// Five tabs fit across the bottom bar on a phone; everything else lives behind "More".

const NAV = [
  ['overview', 'Overview', '◎'],
  ['record', 'Record', '＋'],
  ['txns', 'Transactions', '≡'],
  ['owed', 'Owed', '⇄'],
  ['services', 'Services', '↻'],
  ['loans', 'Loans', '％'],
  ['assets', 'Assets', '▣'],
  ['invoices', 'Invoices', '§'],
  ['bank', 'Bank', '⌸'],
  ['reports', 'Reports', '◫'],
  ['books', 'Books', '⊞'],
  ['profile', 'Profile', '☖'],
  ['settings', 'Settings', '⚙'],
  ['guide', 'Guide', '?'],
];

const BOTTOM = ['overview', 'txns', 'record', 'owed', 'more'];

let view = 'overview';
let ready = false;

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
    if (!ready) { ready = true; routeFromHash(); }
  } else {
    ready = false;
    app.style.display = 'none';
    login.classList.add('open');
  }
};

window.onFinanceData = () => { if (ready) repaint(); };

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

  document.getElementById('sidenav').innerHTML = NAV.map(([k, label, ic]) =>
    `<button type="button" class="${view === k ? 'on' : ''}" ${view === k ? 'aria-current="page"' : ''} onclick="fin.go('${k}')">
       <span class="ic" aria-hidden="true">${ic}</span>${esc(label)}</button>`).join('');

  document.getElementById('bottomnav').innerHTML = BOTTOM.map(k => {
    if (k === 'more') {
      const on = !BOTTOM.includes(view);
      return `<button type="button" class="${on ? 'on' : ''}" onclick="fin.openSheet()">
                <span class="ic" aria-hidden="true">⋯</span>More</button>`;
    }
    const [, label, ic] = NAV.find(n => n[0] === k);
    const isRec = k === 'record';
    return `<button type="button" class="${view === k ? 'on' : ''} ${isRec ? 'rec' : ''}" onclick="fin.go('${k}')">
              <span class="ic" aria-hidden="true">${ic}</span>${esc(label)}</button>`;
  }).join('');

  document.getElementById('sheetGrid').innerHTML = NAV.map(([k, label, ic]) =>
    `<button type="button" class="${view === k ? 'on' : ''}" onclick="fin.go('${k}')">
       <span aria-hidden="true" style="font-size:17px">${ic}</span>${esc(label)}</button>`).join('');

  const main = document.getElementById('main');

  // Before the first snapshot lands there is genuinely nothing to draw.
  if (!s.settingsExists && !s.txns.length && view !== 'settings') {
    main.innerHTML = firstRun();
    return;
  }

  const views = {
    overview: overview,
    record: record,
    txns: txns,
    owed: renderOwed,
    services: renderServices,
    loans: renderLoans,
    assets: renderAssets,
    invoices: renderInvoices,
    bank: renderBank,
    reports: renderReports,
    books: renderBooks,
    profile: renderProfile,
    settings: renderSettings,
    guide: renderGuide,
    opening: renderOpening,
  };
  main.innerHTML = (views[view] || overview)();

  // Views that need real event listeners rather than inline handlers wire up here.
  ({
    record: mountRecord,
    invoices: mountInvoices,
    bank: mountBank,
    settings: mountSettings,
    profile: mountProfile,
    opening: mountOpening,
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
      ${stat('Income this month', fmt(p.ti))}
      ${stat('Expenses this month', fmt(p.te))}
      ${stat('Profit this month', signed(p.profit), { raw: true, hero: true })}
      ${stat('Free to use', fmt(cash.free), {
        sub: 'Cash after vendor dues and client tokens',
      })}
    </div>

    <h2>Where the money is</h2>
    <div class="grid g3">
      ${stat('Bank', fmt(cash.bank))}
      ${stat('Petty cash', fmt(cash.petty))}
      ${stat('Credit card owed', fmt(cash.card), { cls: cash.card > 0 ? 'neg' : '' })}
      ${stat('Loans outstanding', fmt(cash.loans))}
    </div>

    <h2>Who owes whom</h2>
    <div class="grid g3">
      ${stat('Clients owe you', fmt(cash.receivable), { sub: 'Tap to chase', subRaw: false })}
      ${stat('You owe vendors', fmt(cash.vendorDues))}
      ${stat('Client tokens held', fmt(cash.tokens), { sub: 'Not yours until the deal registers' })}
      ${stat('GST due (net)', fmt(cash.gstDue), { cls: cash.gstDue > 0 ? 'neg' : '' })}
    </div>
    <div class="actions"><button class="btn" type="button" onclick="fin.go('owed')">Open Owed both ways</button></div>

    <h2>Services</h2>
    <div class="grid g3">
      ${stat('Run rate', fmt(svc.monthly) + '/mo')}
      ${stat('Annual commitment', fmt(svc.annual))}
      ${stat('Prepaid sitting with vendors', fmt(svc.prepaidUnused))}
      ${stat('Active services', String(svc.active.length))}
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
// One screen for everything that happens. The left side picks the event and fills the form;
// the right side is a live dry run of what saving will do, which is the only thing standing
// between the user and a wrong entry. Save stays disabled until the journal balances.

let evKey = null;
let vals = {};
let pendingFiles = [];

function record() {
  if (!evKey) {
    return `
      <h1>Record what happened</h1>
      <p class="lead">Pick the thing that actually happened. The bookkeeping underneath is worked out for you,
      and you will see exactly what it does before anything is saved.</p>
      ${CHOOSER.map(([group, keys]) => `
        <div class="chooser-group">
          <div class="eh">${esc(group)}</div>
          <div class="chooser-grid">
            ${keys.filter(k => EV[k]).map(k =>
      `<button type="button" onclick="fin.pick('${k}')"><b>${esc(EV[k].title)}</b></button>`).join('')}
          </div>
        </div>`).join('')}`;
  }

  const ev = EV[evKey];
  return `
    <div class="actions">
      <button class="btn ghost sm" type="button" onclick="fin.pick(null)">← All actions</button>
    </div>
    <h1>${esc(ev.title)}</h1>
    <div class="record-split">
      <div><form id="evForm" autocomplete="off"></form></div>
      <div class="preview">
        <div class="card">
          <div class="when">${ev.when}</div>
          <h3>What saving this does</h3>
          <ul class="effects" id="pvEffects"></ul>
          <details class="journal">
            <summary>Show the double entry this creates</summary>
            <div id="pvJournal"></div>
          </details>
        </div>
        <div class="actions">
          <button class="btn primary" type="button" id="saveBtn" onclick="fin.save()">Save</button>
          <label class="btn" style="cursor:pointer">
            Attach
            <input type="file" id="attachInput" accept="image/*,application/pdf" multiple capture="environment" hidden>
          </label>
        </div>
        <div id="attachStrip"></div>
      </div>
    </div>`;
}

function mountRecord() {
  if (!evKey) return;
  buildForm();
  document.getElementById('attachInput')?.addEventListener('change', e => {
    for (const f of e.target.files) {
      if (f.size > 10 * 1024 * 1024) { toast(`${f.name} is larger than 10 MB`); continue; }
      pendingFiles.push(f);
    }
    e.target.value = '';
    drawAttachments();
  });
  drawAttachments();
}

function drawAttachments() {
  const el = document.getElementById('attachStrip');
  if (!el) return;
  const shown = pendingFiles.map(f => ({
    name: f.name, type: f.type,
    url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
  }));
  el.innerHTML = attachmentStrip(shown, { onRemove: true });
  el.querySelectorAll('[data-rm]').forEach(b => {
    b.onclick = () => { pendingFiles.splice(+b.dataset.rm, 1); drawAttachments(); };
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
  for (const f of fields) {
    if (vals[f.k] === undefined) {
      if (f.type === 'select') {
        const opts = typeof f.opts === 'function' ? f.opts(vals) : (f.opts || []);
        vals[f.k] = f.def ?? (opts[0] ? opts[0][0] : '');
      } else if (f.def !== undefined) {
        vals[f.k] = f.def;
      }
    }
  }

  // Text and number fields only refresh the preview, so typing never loses focus. Selects
  // rebuild the form, because they can change which fields are shown and what the options are.
  form.querySelectorAll('input[data-k]').forEach(el => {
    el.oninput = () => { vals[el.dataset.k] = el.value; updatePreview(); };
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
    placeholder: opts.length ? 'Search deals' : 'No deals available',
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
  const saveBtn = document.getElementById('saveBtn');
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

  saveBtn.disabled = out.incomplete || (!balanced && !createsOnly) || (!lines.length && !createsOnly);
}

// ═══════ TRANSACTIONS ═══════

let txnFilters = { month: '', event: '', party: '', q: '' };

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
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));

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
    <p class="lead">${rows.length} of ${s.txns.length} entries. Tap any row for the full journal.</p>
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
    </div>

    ${rows.length ? table(
    `<th>Date</th><th>Description</th><th class="n">Profit</th><th class="n">Cash</th><th></th>`,
    rows.map(t => {
      const pe = profitEffect(t), ce = cashEffect(t);
      return `<tr class="click" onclick="fin.openTxn('${t.id}')">
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

function openTxn(id) {
  const t = getState().txns.find(x => x.id === id);
  if (!t) return;
  const atts = (t.attachments || []);
  modal({
    title: t.desc || 'Transaction',
    body: `
      <p class="small muted">${esc(t.date)} · ${esc(EV[t.event]?.title || t.event)} · recorded by ${esc(t.createdBy || '—')}
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
      ${atts.length ? `<div class="thumbs">${atts.map(a =>
      `<a class="thumb" href="${esc(a.url)}" target="_blank" rel="noopener">${a.type?.startsWith('image/')
        ? `<img src="${esc(a.url)}" alt="${esc(a.name)}">` : 'PDF'}</a>`).join('')}</div>`
      : '<p class="small faint">None attached.</p>'}
      <label class="btn sm" style="cursor:pointer;margin-top:10px">Add attachment
        <input type="file" id="lateAttach" accept="image/*,application/pdf" multiple hidden></label>`,
    foot: t.reversedBy ? '<span class="small muted">Already reversed.</span>'
      : `<button class="btn danger" type="button" onclick="fin.reverse('${t.id}')">Reverse this entry</button>`,
  });

  document.getElementById('lateAttach').onchange = async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    toast('Uploading…');
    try {
      const uploaded = [];
      for (const f of files) uploaded.push(await SY.uploadAttachment(f, t.id));
      await SY.addAttachments(t.id, uploaded);
      toast('Attached');
      closeModal();
    } catch (err) { toast(err.message || 'Upload failed'); }
  };
}

// ═══════ ACTIONS EXPOSED TO INLINE HANDLERS ═══════

window.fin = {
  go, repaint,

  openSheet: () => document.getElementById('moreSheet').classList.add('open'),

  pick(k) {
    evKey = k;
    vals = {};
    pendingFiles = [];
    repaint();
  },

  // Open the Record screen on a specific event with some fields already filled — used by the
  // "Pay", "Record payment" and similar buttons on the other views.
  record(k, preset = {}) {
    evKey = k;
    vals = { ...preset };
    pendingFiles = [];
    if (EV[k]?.onchange) for (const key of Object.keys(preset)) EV[k].onchange(key, vals);
    go('record');
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
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    const key = evKey;
    try {
      const { txnId } = await SY.save(key, vals);

      // Files are uploaded only after the entry exists, so they land under its real id and an
      // abandoned form never leaves orphaned uploads behind.
      if (txnId && pendingFiles.length) {
        const uploaded = [];
        for (const f of pendingFiles) uploaded.push(await SY.uploadAttachment(f, txnId));
        await SY.addAttachments(txnId, uploaded);
      }

      vals = {};
      pendingFiles = [];
      buildForm();
      drawAttachments();

      if (txnId) {
        toast('Saved', { label: 'Undo', run: () => window.fin.reverse(txnId, true) });
      } else {
        toast('Saved');
      }
    } catch (e) {
      toast(e.message || 'Could not save');
      btn.disabled = false;
    }
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
      await SY.reverse(id);
      closeModal();
      toast('Reversed — both entries stay on record');
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
