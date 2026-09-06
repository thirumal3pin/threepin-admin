// ═══════ REPORTS & BOOKS ═══════
//
// Reports is the owner's view — what came in, what went out, what is left. Books is the
// accountant's view — trial balance, balance sheet, ledgers, and the CSVs the CA actually
// wants. All of it is derived by finance-core.js; nothing is recomputed here.

import {
  ACCOUNTS, A, fmt, esc, num, today, ym, addMonths, mlabel, fyOf,
  pl, bal, ledger, trialBalance, balanceSheet, getState, pname, dname, taxProvision,
} from './finance-core.js';
import {
  stat, signed, empty, note, tag, table, seg, downloadCsv, downloadJson, monthOptions,
} from './ui.js';

// These views own their own picker state. app.js repaints the whole view on any change, which
// is cheap because every figure is derived from a cache that is already in memory.
let repMode = 'month';
let repMonth = ym(today());
let repFy = '';
let ledgerAcc = '1000';
let ledgerParty = '';
let bsDate = today();
let jFrom = '';
let jTo = '';

const st = () => getState();

// ═══════ CASH-FLOW GROUPING ═══════
//
// Grouped by what the money was FOR, not by account — that is the question an owner actually
// asks of a cash-flow summary ("where did it all go?").
const KIND_OF = {
  invoice: 'Income', otherinc: 'Income', settle: 'Income',
  expense: 'Expense', bill: 'Expense', paybill: 'Expense', salary: 'Expense',
  petty: 'Expense', director: 'Expense', confirmcharge: 'Expense', dealcost: 'Expense',
  subnew: 'Expense', subchange: 'Expense', subcancel: 'Expense',
  funding: 'Funding', bankloan: 'Funding',
  emi: 'Repayment', statutory: 'Repayment',
  token: 'Advance', dealpay: 'Advance',
  asset: 'Asset', assetdispose: 'Asset',
  transfer: 'Transfer', card2emi: 'Transfer',
};
const KIND_ORDER = ['Income', 'Expense', 'Advance', 'Funding', 'Repayment', 'Asset', 'Transfer', 'Other'];

// Only accounts 1000 and 1010 are real money; everything else is a promise one way or another.
const cashMoved = t => t.lines.reduce(
  (s, l) => ['1000', '1010'].includes(l.acc) ? s + num(l.dr) - num(l.cr) : s, 0);

// ═══════ REPORTS ═══════

export function renderReports() {
  const s = st();
  if (!s.txns.length) {
    return `<h1>Reports</h1>${empty('<b>Nothing to report yet.</b><br>Record a few entries and the numbers appear here on their own.',
      '<button class="btn primary" type="button" onclick="fin.go(\'record\')">Record something</button>')}`;
  }

  const months = monthOptions(s.txns);
  const fys = [...new Set(s.txns.map(t => fyOf(t.date, s.settings.fyStartMonth)))].sort().reverse();
  if (!months.includes(repMonth) && months.length) repMonth = months[0];
  if (!repFy && fys.length) repFy = fys[0];

  const p = repMode === 'month' ? pl(repMonth) : pl(null, null, repFy);
  const periodLabel = repMode === 'month' ? mlabel(repMonth) : 'FY ' + repFy;

  return `
    <h1>Reports</h1>
    <p class="lead">Profit is income earned minus costs incurred — not money in minus money out.
    The cash-flow summary at the bottom is the other half of the picture.</p>

    <div class="actions">
      ${seg([['month', 'By month'], ['fy', 'By financial year']], repMode, 'finReports.setMode')}
      ${repMode === 'month'
      ? `<select onchange="finReports.setMonth(this.value)" aria-label="Month" style="max-width:190px">
             ${months.map(m => `<option value="${m}" ${m === repMonth ? 'selected' : ''}>${esc(mlabel(m))}</option>`).join('')}
           </select>`
      : `<select onchange="finReports.setFy(this.value)" aria-label="Financial year" style="max-width:190px">
             ${fys.map(f => `<option value="${f}" ${f === repFy ? 'selected' : ''}>FY ${esc(f)}</option>`).join('')}
           </select>`}
    </div>

    <div class="grid g3">
      ${stat('Income', fmt(p.ti), { sub: periodLabel })}
      ${stat('Expenses', fmt(p.te), { sub: periodLabel })}
      ${stat('Profit', signed(p.profit), { raw: true, hero: true, sub: periodLabel })}
      ${stat('Margin', p.ti ? Math.round((p.profit / p.ti) * 100) + '%' : '—')}
    </div>

    ${(() => { const t = taxProvision(p.profit); return `
    <h2>After tax</h2>
    <div class="card">
      <div class="tbl-wrap"><table>
        <tbody>
          <tr><td>Profit before tax</td><td class="n">${signed(t.pbt)}</td></tr>
          <tr><td>Estimated income tax @ ${t.rate}%<br><span class="small faint">s.115BAA rate from Settings — an estimate, not the return</span></td><td class="n">${fmt(t.tax)}</td></tr>
          <tr><td><b>Profit after tax</b></td><td class="n"><b>${signed(t.pat)}</b></td></tr>
        </tbody>
      </table></div>
    </div>`; })()}

    <h2>Last six months</h2>
    ${trendChart()}

    ${categoryTable('Income by category', p.inc, p.ti, 'income')}
    ${categoryTable('Expenses by category', p.exp, p.te, 'expenses')}
    ${cashFlowTable()}`;
}

// A six-month profit trend, drawn as inline SVG because no chart library is available in this
// repo and adding one would mean a build step.
function trendChart() {
  const end = repMode === 'month' ? repMonth : ym(today());
  const months = Array.from({ length: 6 }, (_, i) => addMonths(end, i - 5));
  const data = months.map(m => ({ m, profit: pl(m).profit }));
  const peak = Math.max(1, ...data.map(d => Math.abs(d.profit)));

  const W = 600, H = 190, pad = 26, barW = 62, gap = (W - pad * 2 - barW * 6) / 5;
  const mid = H / 2;
  const summary = `Profit by month: ${data.map(d => `${mlabel(d.m)} ${fmt(d.profit)}`).join(', ')}`;

  return `
    <div class="card">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" preserveAspectRatio="xMidYMid meet">
        <title>${esc(summary)}</title>
        <line x1="${pad}" y1="${mid}" x2="${W - pad}" y2="${mid}" stroke="#E7E1D7" stroke-width="1"/>
        ${data.map((d, i) => {
    const x = pad + i * (barW + gap);
    const h = Math.max(2, (Math.abs(d.profit) / peak) * (mid - 34));
    const up = d.profit >= 0;
    const y = up ? mid - h : mid;
    return `
            <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3"
                  fill="${up ? '#F58A07' : '#B3261E'}"></rect>
            <text x="${x + barW / 2}" y="${up ? y - 7 : y + h + 15}" text-anchor="middle"
                  font-size="11" fill="#5A5348" font-weight="600">${esc(fmt(d.profit))}</text>
            <text x="${x + barW / 2}" y="${H - 6}" text-anchor="middle"
                  font-size="11" fill="#8A8174">${esc(mlabel(d.m).replace(' ', ' '))}</text>`;
  }).join('')}
      </svg>
    </div>`;
}

function categoryTable(title, map, total, slug) {
  const rows = Object.entries(map)
    .filter(([, v]) => Math.abs(v) > 0.5)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    return `<h2>${esc(title)}</h2>${empty('Nothing in this period.')}`;
  }
  return `
    <h2>${esc(title)}</h2>
    <div class="actions">
      <button class="btn sm" type="button" onclick="finReports.csvCategory('${slug}')">Download CSV</button>
    </div>
    ${table(
    `<th>Category</th><th class="n">Amount</th><th class="n">Share</th>`,
    rows.map(([code, v]) => `<tr>
        <td>${esc(A[code]?.name || code)}</td>
        <td class="n">${fmt(v)}</td>
        <td class="n">${total ? Math.round((v / total) * 100) : 0}%</td>
      </tr>`).join(''),
    `<tr><td>Total</td><td class="n">${fmt(total)}</td><td class="n">100%</td></tr>`)}`;
}

function cashFlowRows() {
  const s = st();
  const inPeriod = t => repMode === 'month'
    ? ym(t.date) === repMonth
    : fyOf(t.date, s.settings.fyStartMonth) === repFy;

  const groups = {};
  for (const t of s.txns) {
    if (!inPeriod(t)) continue;
    const moved = cashMoved(t);
    if (!moved) continue;
    const kind = KIND_OF[t.event] || 'Other';
    groups[kind] = groups[kind] || { in: 0, out: 0 };
    if (moved > 0) groups[kind].in += moved; else groups[kind].out += -moved;
  }
  return KIND_ORDER.filter(k => groups[k]).map(k => ({ kind: k, ...groups[k] }));
}

function cashFlowTable() {
  const rows = cashFlowRows();
  if (!rows.length) return `<h2>Cash flow</h2>${empty('No money moved in this period.')}`;
  const tin = rows.reduce((a, r) => a + r.in, 0);
  const tout = rows.reduce((a, r) => a + r.out, 0);
  return `
    <h2>Cash flow</h2>
    <p class="small muted">Money that actually moved through the bank and the cash box, grouped by what it was for.</p>
    <div class="actions">
      <button class="btn sm" type="button" onclick="finReports.csvCategory('cashflow')">Download CSV</button>
    </div>
    ${table(
    `<th>Type</th><th class="n">In</th><th class="n">Out</th><th class="n">Net</th>`,
    rows.map(r => `<tr>
        <td>${esc(r.kind)}</td>
        <td class="n">${r.in ? fmt(r.in) : '—'}</td>
        <td class="n">${r.out ? fmt(r.out) : '—'}</td>
        <td class="n">${signed(r.in - r.out)}</td>
      </tr>`).join(''),
    `<tr><td>Total</td><td class="n">${fmt(tin)}</td><td class="n">${fmt(tout)}</td><td class="n">${signed(tin - tout)}</td></tr>`)}`;
}

// ═══════ BOOKS ═══════

export function renderBooks() {
  const s = st();
  if (!s.txns.length) {
    return `<h1>Books</h1>${empty('<b>Nothing in the books yet.</b><br>This is the accountant\'s view — it fills in as you record.')}`;
  }
  if (!jFrom) jFrom = s.txns.map(t => t.date).sort()[0];
  if (!jTo) jTo = today();

  return `
    <h1>Books</h1>
    <p class="lead">This is the double-entry view your CA will ask for. The journal CSV below is
    the file to send them — it has every entry, both sides, with account names.</p>
    <div class="actions">
      <button class="btn primary" type="button" onclick="finReports.csvJournal()">Download journal CSV</button>
      <button class="btn" type="button" onclick="finReports.csvTally()">Tally-friendly CSV</button>
      <button class="btn" type="button" onclick="finReports.exportAll()">Export everything (JSON)</button>
    </div>

    ${trialBalanceSection()}
    ${balanceSheetSection()}
    ${ledgerSection()}
    ${journalSection()}`;
}

function trialBalanceSection() {
  const tb = trialBalance();
  return `
    <h2>Trial balance
      ${tb.balanced ? tag('balanced ✓', 'ok') : tag('does not balance', 'rev')}</h2>
    ${table(
    `<th>Code</th><th>Account</th><th class="n">Debit</th><th class="n">Credit</th>`,
    tb.rows.map(r => `<tr>
        <td class="small faint">${esc(r.acc.code)}</td>
        <td>${esc(r.acc.name)}</td>
        <td class="n">${r.net > 0 ? fmt(r.net) : ''}</td>
        <td class="n">${r.net < 0 ? fmt(-r.net) : ''}</td>
      </tr>`).join(''),
    `<tr><td colspan="2">Total</td><td class="n">${fmt(tb.totalDr)}</td><td class="n">${fmt(tb.totalCr)}</td></tr>`)}`;
}

function balanceSheetSection() {
  const bs = balanceSheet(bsDate);
  const section = (label, rows, total) => `
    <tr><td colspan="2"><b>${esc(label)}</b></td></tr>
    ${rows.map(r => `<tr><td style="padding-left:22px">${esc(r.acc.name)}</td><td class="n">${fmt(r.amt)}</td></tr>`).join('')}
    <tr><td style="padding-left:22px"><i>Total ${esc(label.toLowerCase())}</i></td><td class="n"><b>${fmt(total)}</b></td></tr>`;

  return `
    <h2>Balance sheet
      ${bs.balanced ? tag('balances ✓', 'ok') : tag('out by ' + fmt(bs.diff), 'rev')}</h2>
    <div class="actions">
      <label class="small muted" for="bsDate">As of</label>
      <input type="date" id="bsDate" value="${esc(bsDate)}" onchange="finReports.setBsDate(this.value)" style="max-width:180px">
    </div>
    ${table(
    `<th>Account</th><th class="n">Amount</th>`,
    section('Assets', bs.assets, bs.totalAssets) +
    section('Liabilities', bs.liabilities, bs.totalLiab) +
    section('Equity', bs.equity, bs.totalEquity) +
    `<tr><td>Retained profit</td><td class="n">${signed(bs.retained)}</td></tr>`,
    `<tr><td>Assets − (liabilities + equity + profit)</td>
       <td class="n ${bs.balanced ? 'pos' : 'neg'}">${fmt(bs.diff)}</td></tr>`)}`;
}

function ledgerSection() {
  const used = ACCOUNTS.filter(a => st().txns.some(t => t.lines.some(l => l.acc === a.code)));
  if (!used.some(a => a.code === ledgerAcc)) ledgerAcc = used[0]?.code || '1000';
  const rows = ledger(ledgerAcc, { party: ledgerParty || undefined });

  return `
    <h2>Ledger</h2>
    <div class="filters">
      <select onchange="finReports.setAccount(this.value)" aria-label="Account">
        ${used.map(a => `<option value="${a.code}" ${a.code === ledgerAcc ? 'selected' : ''}>${esc(a.code)} — ${esc(a.name)}</option>`).join('')}
      </select>
      <select onchange="finReports.setLedgerParty(this.value)" aria-label="Party">
        <option value="">All parties</option>
        ${st().parties.map(p => `<option value="${p.id}" ${p.id === ledgerParty ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <button class="btn sm" type="button" onclick="finReports.csvLedger()">Download CSV</button>
    </div>
    ${rows.length ? table(
    `<th>Date</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th>`,
    rows.map(r => `<tr class="click" onclick="fin.openTxn('${esc(r.txnId)}')">
        <td class="nowrap small">${esc(r.date)}</td>
        <td>${esc(r.desc)}${r.party ? `<br><span class="small faint">${esc(pname(r.party))}</span>` : ''}</td>
        <td class="n">${r.dr ? fmt(r.dr) : ''}</td>
        <td class="n">${r.cr ? fmt(r.cr) : ''}</td>
        <td class="n">${fmt(r.balance)}</td>
      </tr>`).join(''))
      : empty('Nothing posted to this account.')}`;
}

function journalRows() {
  return st().txns
    .filter(t => t.date >= jFrom && t.date <= jTo)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function journalSection() {
  const rows = journalRows();
  return `
    <h2>General journal</h2>
    <div class="filters">
      <input type="date" value="${esc(jFrom)}" onchange="finReports.setRange('from',this.value)" aria-label="From date">
      <input type="date" value="${esc(jTo)}" onchange="finReports.setRange('to',this.value)" aria-label="To date">
    </div>
    ${rows.length ? table(
    `<th>Date</th><th>Entry</th><th>Account</th><th class="n">Debit</th><th class="n">Credit</th>`,
    rows.map(t => t.lines.map((l, i) => `<tr class="click" onclick="fin.openTxn('${esc(t.id)}')">
        <td class="nowrap small">${i === 0 ? esc(t.date) : ''}</td>
        <td>${i === 0 ? esc(t.desc) : ''}</td>
        <td class="small">${esc(A[l.acc]?.name || l.acc)}</td>
        <td class="n">${l.dr ? fmt(l.dr) : ''}</td>
        <td class="n">${l.cr ? fmt(l.cr) : ''}</td>
      </tr>`).join('')).join(''))
      : empty('No entries in that range.')}`;
}

// ═══════ EXPORTS ═══════

function journalCsvRows() {
  const rows = [['Txn', 'Date', 'Description', 'Account code', 'Account name', 'Debit', 'Credit', 'Party', 'Event']];
  for (const t of journalRows()) {
    for (const l of t.lines) {
      rows.push([t.id, t.date, t.desc, l.acc, A[l.acc]?.name || '',
        num(l.dr) || '', num(l.cr) || '', l.party ? pname(l.party) : '', t.event]);
    }
  }
  return rows;
}

// Tally imports match on ledger NAMES, not codes, so the account name is what has to be in
// the Ledger Name column — a code there imports as an unrecognised ledger.
function tallyCsvRows() {
  const rows = [['Date', 'Voucher Type', 'Voucher No', 'Ledger Name', 'Debit', 'Credit', 'Narration']];
  for (const t of journalRows()) {
    for (const l of t.lines) {
      rows.push([t.date, 'Journal', t.id, A[l.acc]?.name || l.acc,
        num(l.dr) || '', num(l.cr) || '', t.desc]);
    }
  }
  return rows;
}

// ═══════ PICKER STATE ═══════
//
// Attached to window rather than exported, because these are called from inline onchange
// handlers in the markup above. Guarded so the module still imports under Node.

if (typeof window !== 'undefined') {
  window.finReports = {
    setMode: v => { repMode = v; window.fin.repaint(); },
    setMonth: v => { repMonth = v; window.fin.repaint(); },
    setFy: v => { repFy = v; window.fin.repaint(); },
    setAccount: v => { ledgerAcc = v; window.fin.repaint(); },
    setLedgerParty: v => { ledgerParty = v; window.fin.repaint(); },
    setBsDate: v => { bsDate = v; window.fin.repaint(); },
    setRange: (which, v) => { if (which === 'from') jFrom = v; else jTo = v; window.fin.repaint(); },

    csvCategory(slug) {
      const p = repMode === 'month' ? pl(repMonth) : pl(null, null, repFy);
      const label = repMode === 'month' ? repMonth : repFy;
      if (slug === 'cashflow') {
        downloadCsv(`3pin-cashflow-${label}.csv`,
          [['Type', 'In', 'Out', 'Net'], ...cashFlowRows().map(r => [r.kind, r.in, r.out, r.in - r.out])]);
        return;
      }
      const map = slug === 'income' ? p.inc : p.exp;
      downloadCsv(`3pin-${slug}-${label}.csv`,
        [['Code', 'Category', 'Amount'],
        ...Object.entries(map).map(([c, v]) => [c, A[c]?.name || c, v])]);
    },

    csvJournal: () => downloadCsv(`3pin-journal-${jFrom}-to-${jTo}.csv`, journalCsvRows()),
    csvTally: () => downloadCsv(`3pin-tally-${jFrom}-to-${jTo}.csv`, tallyCsvRows()),
    csvLedger() {
      const rows = ledger(ledgerAcc, { party: ledgerParty || undefined });
      downloadCsv(`3pin-ledger-${ledgerAcc}.csv`,
        [['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Party'],
        ...rows.map(r => [r.date, r.desc, r.dr || '', r.cr || '', r.balance, r.party ? pname(r.party) : ''])]);
    },
    exportAll: () => downloadJson(`3pin-finance-backup-${today()}.json`, getState()),
  };
}
