// ═══════ REPORTS & BOOKS ═══════
//
// Reports is the owner's view — what came in, what went out, what is left. Books is the
// accountant's view — trial balance, balance sheet, ledgers, and the CSVs the CA actually
// wants. All of it is derived by finance-core.js; nothing is recomputed here.

import {
  ACCOUNTS, A, fmt, esc, num, today, ym, addMonths, mlabel, fyOf,
  pl, bal, ledger, trialBalance, balanceSheet, getState, pname, dname, taxProvision,
  cashProfitBridge, scopeMode, scopeLabel, scoped, cashBook, lastDayOfMonth,
  trialBalanceDetail, plStatement, balanceSheetGrouped, booksHealth,
  openBills, openInvoices, billOutstanding, invoiceOutstanding, addDays,
  monthCompare, breakEven, mlabel as monthName, INCOME_ACCS, EXPENSE_ACCS,
} from './finance-core.js';
import {
  stat, signed, empty, note, tag, table, seg, downloadCsv, downloadJson, monthOptions, drillAttrs,
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
  petty: 'Expense', director: 'Expense', confirmcharge: 'Expense', dealcost: 'Expense', vendorrefund: 'Expense',
  subnew: 'Expense', subchange: 'Expense', subcancel: 'Expense',
  funding: 'Funding', bankloan: 'Funding',
  emi: 'Repayment', statutory: 'Repayment',
  token: 'Advance', dealpay: 'Collections',
  asset: 'Asset', assetdispose: 'Asset',
  transfer: 'Transfer', card2emi: 'Transfer',
};
const KIND_ORDER = ['Income', 'Expense', 'Advance', 'Funding', 'Repayment', 'Asset', 'Transfer', 'Other'];

// Only accounts 1000 and 1010 are real money; everything else is a promise one way or another.
const cashMoved = t => t.lines.reduce(
  (s, l) => ['1000', '1010'].includes(l.acc) ? s + num(l.dr) - num(l.cr) : s, 0);

// ═══════ REPORTS ═══════

// "I made a profit and the bank went down" — every step here is a real movement that
// explains part of the gap. The residual is what none of them explain and should be nil.
function bridgeBlock(month) {
  const b = cashProfitBridge(month);
  if (!b.steps.length) return '';
  return `
    <h2>Profit is not cash</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 10px">What happened to the money, starting from the month's profit.</p>
      <div class="tbl-wrap"><table>
        <tbody>${b.steps.map((x, i) => `<tr>
          <td>${i === 0 ? '<b>' + esc(x.label) + '</b>' : esc(x.label)}</td>
          <td class="n">${signed(x.amt)}</td></tr>`).join('')}
          <tr><td><b>Cash actually moved</b></td><td class="n"><b>${signed(b.cashMoved)}</b></td></tr>
          ${Math.abs(b.residual) > 1 ? `<tr><td class="neg">Not explained — tell your CA</td><td class="n neg">${signed(b.residual)}</td></tr>` : ''}
        </tbody>
      </table></div>
    </div>`;
}

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
      ${stat('Income', fmt(p.ti), { sub: periodLabel, drill: { accs: INCOME_ACCS, ...periodSpec(), flip: true } })}
      ${stat('Expenses', fmt(p.te), { sub: periodLabel, drill: { accs: EXPENSE_ACCS, ...periodSpec() } })}
      ${stat('Profit', signed(p.profit), { raw: true, hero: true, sub: periodLabel, drill: { profit: true, ...periodSpec() } })}
      ${stat('Margin', p.ti ? Math.round((p.profit / p.ti) * 100) + '%' : '—')}
    </div>

    ${repMode === 'month' ? compareBlock(repMonth) : ''}
    ${repMode === 'month' ? breakEvenBlock(repMonth) : ''}
    ${repMode === 'month' ? bridgeBlock(repMonth) : ''}

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
    ${cashBookSection()}
    ${cashFlowTable()}`;
}

// Three columns and three sentences. An owner reads the sentences; an analyst reads the
// columns. Both want the same thing first — what moved, and by how much.
function compareBlock(month) {
  const c = monthCompare(month);
  const arrow = r => r.change > 0 ? '▲' : '▼';
  const cls = r => Math.abs(r.change) < 0.5 ? '' : (r.worse ? 'neg' : 'pos');
  const line = (label, k, invert) => {
    const d = c[k];
    const chg = Math.round((d.now - d.prev) * 100) / 100;
    const vs = Math.round((d.now - d.planned) * 100) / 100;
    const bad = invert ? chg > 0 : chg < 0;
    return `<tr>
      <td class="lead">${esc(label)}</td>
      <td class="n" data-label="This month">${fmt(d.now)}</td>
      <td class="n" data-label="Last month">${fmt(d.prev)}</td>
      <td class="n" data-label="Change"><span class="${Math.abs(chg) < 0.5 ? '' : bad ? 'neg' : 'pos'}">${chg > 0 ? '+' : chg < 0 ? '−' : ''}${fmt(Math.abs(chg))}</span></td>
      <td class="n" data-label="Expected">${d.planned ? fmt(d.planned) : '<span class="faint">—</span>'}</td>
      <td class="n" data-label="Against expected">${d.planned ? `${vs > 0 ? '+' : vs < 0 ? '−' : ''}${fmt(Math.abs(vs))}` : '<span class="faint">—</span>'}</td>
    </tr>`;
  };

  return `
    <h2>How ${esc(monthName(month))} compares</h2>
    ${c.movers.length ? `<p class="lead">${c.movers.map(r =>
    `<b>${esc(r.name)}</b> ${r.change > 0 ? 'up' : 'down'} ${fmt(Math.abs(r.change))}`).join(', ')} against ${esc(monthName(c.prev))}.</p>` : ''}
    ${table(
    `<th>&nbsp;</th><th class="n">This month</th><th class="n">Last month</th><th class="n">Change</th><th class="n">Expected</th><th class="n">Against expected</th>`,
    line('Income', 'income', false) + line('Costs', 'expense', true) + line('Profit', 'profit', false),
    '', { stack: true })}
    ${c.movers.length ? `
    <details class="card pad0 bucket">
      <summary><b>What moved</b> <span class="faint small">biggest change first</span> <span class="n">${c.rows.length}</span></summary>
      ${table(
      `<th>Account</th><th class="n">This month</th><th class="n">Last month</th><th class="n">Change</th><th class="n">Expected</th>`,
      c.rows.map(r => `<tr ${drillAttrs(r.name + ' — ' + monthName(month), { accs: r.code, month, flip: r.type === 'income' })}>
          <td class="lead">${esc(r.name)} <span class="small faint">${esc(r.code)}</span></td>
          <td class="n" data-label="This month">${fmt(r.now)}</td>
          <td class="n" data-label="Last month">${fmt(r.prev)}</td>
          <td class="n" data-label="Change"><span class="${cls(r)}">${Math.abs(r.change) < 0.5 ? '—' : `${arrow(r)} ${fmt(Math.abs(r.change))}`}</span></td>
          <td class="n" data-label="Expected">${r.planned ? fmt(r.planned) : '<span class="faint">—</span>'}</td>
        </tr>`).join(''), '', { stack: true })}
    </details>` : ''}`;
}

// What has to be earned before the business is standing still. The margin is this business's
// own, taken from the last three months it traded — not a figure anyone typed in.
function breakEvenBlock(month) {
  const b = breakEven(month);
  if (!b.fixed) return '';
  return `
    <h2>Keeping the lights on</h2>
    <div class="grid g3">
      ${stat('Fixed cost a month', fmt(b.fixed), { sub: b.fixedCash < b.fixed ? `${fmt(b.fixedCash)} of it actually leaves the bank` : 'All of it leaves the bank' })}
      ${stat('Margin on what you sell', b.basedOn ? b.marginPct + '%' : '—', { sub: b.basedOn ? `From the last ${b.basedOn} month${b.basedOn === 1 ? '' : 's'} you traded` : 'Not enough history yet' })}
      ${stat('Income needed to break even', b.need ? fmt(b.need) : '—', { hero: true, sub: 'Before the month makes anything' })}
      ${stat(b.covered ? 'Past break-even by' : 'Short of break-even by', fmt(Math.abs(b.gap)), { cls: b.covered ? 'pos' : 'neg', sub: `${fmt(b.actual)} earned so far` })}
    </div>
    <details class="card pad0 bucket">
      <summary><b>What the fixed cost is made of</b> <span class="faint small">commitments that arrive whether or not a deal closes</span> <span class="n">${fmt(b.fixed)}</span></summary>
      ${table(
      `<th>What</th><th>Kind</th><th class="n">A month</th>`,
      b.items.map(i => `<tr>
          <td class="lead">${esc(i.what)}${i.noCash ? ' <span class="small faint">— no money moves</span>' : ''}</td>
          <td class="small" data-label="Kind">${esc(i.kind)}</td>
          <td class="n" data-label="A month">${fmt(i.amt)}</td>
        </tr>`).join(''),
      `<tr><td colspan="2">Total</td><td class="n">${fmt(b.fixed)}</td></tr>`, { stack: true })}
    </details>`;
}

// Whichever period the page is set to, said the way explain() wants it.
const periodSpec = () => repMode === 'month' ? { month: repMonth } : { fy: repFy };

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
    rows.map(([code, v]) => `<tr ${drillAttrs(A[code]?.name || code, { accs: code, ...periodSpec(), flip: slug === 'income' })}>
        <td>${esc(A[code]?.name || code)}</td>
        <td class="n">${fmt(v)}</td>
        <td class="n">${total ? Math.round((v / total) * 100) : 0}%</td>
      </tr>`).join(''),
    `<tr><td>Total</td><td class="n">${fmt(total)}</td><td class="n">100%</td></tr>`)}`;
}

// The money statement the owner asked for: opening, every movement, closing — bank and box,
// with the card optionally. Closing equals the ledger by construction.
let cbPockets = 'cash';
function cashBookSection() {
  const s = st();
  const from = repMode === 'month' ? repMonth + '-01' : fyStart(repFy, s.settings.fyStartMonth);
  const to = repMode === 'month' ? lastDayOfMonth(repMonth) : fyEnd(repFy, s.settings.fyStartMonth);
  const accs = cbPockets === 'all' ? ['1000', '1010', '2300'] : cbPockets === 'bank' ? ['1000'] : cbPockets === 'box' ? ['1010'] : ['1000', '1010'];
  const b = cashBook(from, to, accs);
  return `
    <h2>Money in and out</h2>
    <p class="small muted">Only money that actually moved. Bills received and invoices raised are not here until they are paid.</p>
    <div class="actions" style="align-items:center">
      ${seg([['cash', 'Bank + box'], ['bank', 'Bank'], ['box', 'Petty cash'], ['all', 'Incl. card']], cbPockets, 'finReports.setPockets')}
      <div class="spacer"></div>
      <button class="btn sm" type="button" onclick="finReports.csvCashBook()">Download CSV</button>
    </div>
    <div class="grid g3">
      ${stat('Opening', fmt(b.opening))}
      ${stat('Money in', fmt(b.in), { cls: 'pos' })}
      ${stat('Money out', fmt(b.out), { cls: b.out > 0.5 ? 'neg' : '' })}
      ${stat('Closing', fmt(b.closing), { hero: true })}
    </div>
    ${b.rows.length ? table(
      `<th>What</th><th>Date</th><th class="n">In</th><th class="n">Out</th><th class="n">Balance</th>`,
      b.rows.map(r => `<tr class="click" onclick="fin.openTxn('${esc(r.t.id)}')">
        <td class="lead">${esc(r.t.desc)}${r.pocket ? `<br><span class="small faint">${esc(r.pocket)}</span>` : ''}</td>
        <td class="nowrap small" data-label="Date">${esc(r.t.date)}</td>
        <td class="n" data-label="In">${r.in ? fmt(r.in) : '—'}</td>
        <td class="n" data-label="Out">${r.out ? fmt(r.out) : '—'}</td>
        <td class="n" data-label="Balance">${fmt(r.after)}</td></tr>`).join(''),
      `<tr><td colspan="2" data-label="Totals">Totals</td><td class="n">${fmt(b.in)}</td><td class="n">${fmt(b.out)}</td><td class="n">${fmt(b.closing)}</td></tr>`,
      { stack: true })
      : empty('No money moved in this period.')}`;
}
function cashBookCsvRows() {
  const s = st();
  const from = repMode === 'month' ? repMonth + '-01' : fyStart(repFy, s.settings.fyStartMonth);
  const to = repMode === 'month' ? lastDayOfMonth(repMonth) : fyEnd(repFy, s.settings.fyStartMonth);
  const accs = cbPockets === 'all' ? ['1000', '1010', '2300'] : cbPockets === 'bank' ? ['1000'] : cbPockets === 'box' ? ['1010'] : ['1000', '1010'];
  const b = cashBook(from, to, accs);
  return [...scopeRow(), ['Date', 'Entry', 'Description', 'Pocket', 'In', 'Out', 'Balance'],
    ['', '', 'Opening', '', '', '', b.opening],
    ...b.rows.map(r => [r.t.date, r.t.no || '', r.t.desc, r.pocket, r.in || '', r.out || '', r.after]),
    ['', '', 'Closing', '', b.in, b.out, b.closing]];
}
const fyStart = (fy, m) => `${fy.slice(0, 4)}-${String(m || 4).padStart(2, '0')}-01`;
const fyEnd = (fy, m) => lastDayOfMonth(addMonths(fyStart(fy, m).slice(0, 7), 11));

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

// Which kinds of entry a cash-flow line is made of, so the row can be opened.
const eventsOfKind = kind => Object.entries(KIND_OF).filter(([, k]) => k === kind).map(([e]) => e);

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
    rows.map(r => `<tr ${drillAttrs(r.kind + ' — money moved', { events: eventsOfKind(r.kind), ...periodSpec(), accs: ['1000', '1010'], moved: true })}>
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
  if (!jFrom) jFrom = fyStart(fyOf(today(), s.settings.fyStartMonth), s.settings.fyStartMonth);
  if (!jTo) jTo = today();

  return `
    <h1>Books</h1>
    <p class="lead">The five statements a chartered accountant asks for, over one period you choose.
    Everything below is built from the same entries — change the dates once and all of it moves together.</p>

    <div class="card">
      <div class="filters">
        <label class="small muted" for="bkFrom">From</label>
        <input type="date" id="bkFrom" value="${esc(jFrom)}" onchange="finReports.setRange('from',this.value)" aria-label="Period from">
        <label class="small muted" for="bkTo">To</label>
        <input type="date" id="bkTo" value="${esc(jTo)}" onchange="finReports.setRange('to',this.value)" aria-label="Period to">
        <button class="btn ghost sm" type="button" onclick="finReports.period('fy')">This financial year</button>
        <button class="btn ghost sm" type="button" onclick="finReports.period('month')">This month</button>
        <button class="btn ghost sm" type="button" onclick="finReports.period('all')">Everything</button>
      </div>
      <div class="actions" style="margin-bottom:0">
        <button class="btn primary" type="button" onclick="finReports.csvJournal()">Journal CSV</button>
        <button class="btn" type="button" onclick="finReports.csvTrial()">Trial balance CSV</button>
        <button class="btn" type="button" onclick="finReports.csvGeneralLedger()">All ledgers CSV</button>
        <button class="btn" type="button" onclick="finReports.csvTally()">Tally-friendly CSV</button>
        <button class="btn" type="button" onclick="finReports.exportAll()">Export everything (JSON)</button>
      </div>
      <p class="small faint" style="margin:8px 0 0">Send your CA the journal and the ledgers. Both carry account codes, names and both sides of every entry.</p>
    </div>

    ${healthSection()}
    ${trialBalanceSection()}
    ${plSection()}
    ${balanceSheetSection()}
    ${ledgerSection()}
    ${registerSection()}
    ${journalSection()}`;
}

// What an accountant checks before signing anything. Read at full scope on purpose: a
// petty-cash filter must never be able to make the books look balanced when they are not.
function healthSection() {
  const h = scoped(() => booksHealth(jTo), 'with');
  const icon = c => c.level === 'ok' ? '<span class="pos">✓</span>' : c.level === 'warn' ? '<span class="neg">!</span>' : '<span class="neg">✗</span>';
  const bad = h.bad, warn = h.warn;
  return `
    <h2>The check <span class="small faint">as at ${esc(jTo)}</span>
      ${bad ? tag(`${bad} to fix`, 'rev') : warn ? tag(`${warn} to look at`, 'warn') : tag('all clear ✓', 'ok')}</h2>
    <p class="small muted">Twelve things that have to be true before these books can be filed or handed over.</p>
    ${table(
    `<th>Check</th><th>What it says</th><th></th>`,
    h.checks.map(c => `<tr>
      <td class="lead">${icon(c)} ${esc(c.label)}</td>
      <td class="small" data-label="What it says">${esc(c.detail)}</td>
      <td class="n">${c.go && c.level !== 'ok' ? `<button class="btn ghost sm" type="button" onclick="fin.go('${esc(c.go)}')">Open</button>` : ''}</td>
    </tr>`).join(''), '', { stack: true })}`;
}

function trialBalanceSection() {
  return scoped(() => trialBalanceFull(), 'with');
}

// A trial balance with movement: where each account started, what went through it, where it
// ended. The closing columns are what most people call the trial balance; the movement
// columns are what makes it tie to the journal.
function trialBalanceFull() {
  const tb = trialBalanceDetail(jFrom, jTo);
  const cell = (amt, want) => (want === 'dr' ? amt > 0 : amt < 0) ? fmt(Math.abs(amt)) : '';
  return `
    <h2>Trial balance
      ${tb.balanced ? tag('balanced ✓', 'ok') : tag('does not balance', 'rev')}
      <span class="small faint">${esc(jFrom)} to ${esc(jTo)}</span></h2>
    ${table(
    `<th>Code</th><th>Account</th><th class="n">Opening Dr</th><th class="n">Opening Cr</th>
     <th class="n">Debit</th><th class="n">Credit</th><th class="n">Closing Dr</th><th class="n">Closing Cr</th>`,
    tb.rows.map(r => `<tr>
        <td class="small faint">${esc(r.acc.code)}</td>
        <td class="lead">${esc(r.acc.name)}</td>
        <td class="n" data-label="Opening Dr">${cell(r.opening, 'dr')}</td>
        <td class="n" data-label="Opening Cr">${cell(r.opening, 'cr')}</td>
        <td class="n" data-label="Debit">${r.debit ? fmt(r.debit) : ''}</td>
        <td class="n" data-label="Credit">${r.credit ? fmt(r.credit) : ''}</td>
        <td class="n" data-label="Closing Dr">${cell(r.closing, 'dr')}</td>
        <td class="n" data-label="Closing Cr">${cell(r.closing, 'cr')}</td>
      </tr>`).join(''),
    `<tr><td colspan="2">Total</td>
       <td class="n">${fmt(tb.totals.openingDr)}</td><td class="n">${fmt(tb.totals.openingCr)}</td>
       <td class="n">${fmt(tb.totals.debit)}</td><td class="n">${fmt(tb.totals.credit)}</td>
       <td class="n">${fmt(tb.totals.closingDr)}</td><td class="n">${fmt(tb.totals.closingCr)}</td></tr>`,
    { stack: true })}
    <p class="small faint">Debits and credits for the period are equal by construction — every entry balances before it is written. The closing columns are what a trial balance normally shows.</p>`;
}

// Profit and loss the way it is read: revenue, what earning it cost, what running the place
// cost, and then the lines below the operating result.
function plSection() {
  return scoped(() => plFull(), 'with');
}
function plFull() {
  const period = plForRange();
  const line = (label, amt, o = {}) => `<tr class="${o.cls || ''}">
      <td${o.indent ? ' style="padding-left:22px"' : ''}>${o.bold ? '<b>' + esc(label) + '</b>' : esc(label)}</td>
      <td class="n">${o.bold ? '<b>' + signed(amt) + '</b>' : signed(amt)}</td></tr>`;
  const groupRows = g => `
    <tr><td colspan="2" class="lead"><b>${esc(g.label)}</b></td></tr>
    ${g.rows.map(r => `<tr><td style="padding-left:22px">${esc(r.name)} <span class="small faint">${esc(r.code)}</span></td><td class="n">${fmt(r.amt)}</td></tr>`).join('')}
    <tr><td style="padding-left:22px"><i>Total ${esc(g.label.toLowerCase())}</i></td><td class="n"><b>${fmt(g.total)}</b></td></tr>`;

  return `
    <h2>Profit and loss <span class="small faint">${esc(jFrom)} to ${esc(jTo)}</span></h2>
    <div class="card">
      <div class="tbl-wrap"><table>
        <tbody>
          ${period.groups.map(groupRows).join('')}
          <tr><td colspan="2"></td></tr>
          ${line('Gross profit', period.grossProfit, { bold: true })}
          ${line('Operating costs', -period.opex, { indent: true })}
          ${line('Other income', period.otherIncome, { indent: true })}
          ${line('Operating profit (EBITDA)', period.ebitda, { bold: true })}
          ${line('Depreciation', -period.depreciation, { indent: true })}
          ${line('Finance cost', -period.finance, { indent: true })}
          ${line('Exceptional and non-deductible', -period.exceptional, { indent: true })}
          ${line('Profit before tax', period.pbt, { bold: true })}
          ${line(`Estimated tax at ${period.taxRate}%`, -period.tax, { indent: true })}
          ${line('Profit after tax', period.pat, { bold: true })}
        </tbody>
      </table></div>
    </div>
    <p class="small faint">Margin ${period.margin}% of ${fmt(period.income)} income. Tax is an estimate at the rate in Settings, not the return.</p>`;
}

// The statement functions take a month or a financial year; an arbitrary date range is read
// by summing the months it covers, which is what the range picker gives.
function plForRange() {
  const months = [];
  for (let m = ym(jFrom), guard = 0; m <= ym(jTo) && guard < 240; m = addMonths(m, 1), guard++) months.push(m);
  if (months.length === 1) return plStatement({ month: months[0] });
  const parts = months.map(m => plStatement({ month: m }));
  const groups = [];
  for (const part of parts) {
    for (const g of part.groups) {
      let t = groups.find(x => x.key === g.key);
      if (!t) { t = { ...g, rows: [], total: 0 }; groups.push(t); }
      for (const r of g.rows) {
        const row = t.rows.find(x => x.code === r.code);
        if (row) row.amt = Math.round((row.amt + r.amt) * 100) / 100;
        else t.rows.push({ ...r });
      }
      t.total = Math.round((t.total + g.total) * 100) / 100;
    }
  }
  const sum = k => Math.round(parts.reduce((a, p) => a + p[k], 0) * 100) / 100;
  const pbt = Math.round((sum('ebitda') - sum('depreciation') - sum('finance') - sum('exceptional')) * 100) / 100;
  const prov = taxProvision(pbt);
  const income = sum('income');
  return {
    groups: groups.filter(g => g.rows.length),
    revenue: sum('revenue'), otherIncome: sum('otherIncome'), direct: sum('direct'),
    grossProfit: sum('grossProfit'), opex: sum('opex'), ebitda: sum('ebitda'),
    depreciation: sum('depreciation'), finance: sum('finance'), exceptional: sum('exceptional'),
    pbt, tax: prov.tax, taxRate: prov.rate, pat: prov.pat,
    income, expense: sum('expense'), profit: sum('profit'),
    margin: income ? Math.round((sum('profit') / income) * 100) : 0,
  };
}
function balanceSheetSection() {
  return scoped(() => balanceSheetFull(), 'with');
}
function balanceSheetFull() {
  const s = st();
  const fy = fyOf(jTo, s.settings.fyStartMonth);
  const bs = balanceSheetGrouped(jTo, fyStart(fy, s.settings.fyStartMonth));
  const group = g => `
    <tr><td colspan="2" class="lead"><b>${esc(g.label)}</b></td></tr>
    ${g.rows.map(r => `<tr><td style="padding-left:22px">${esc(r.name)} <span class="small faint">${esc(r.code)}</span></td><td class="n">${fmt(r.amt)}</td></tr>`).join('')}
    ${g.rows.length ? `<tr><td style="padding-left:22px"><i>Total ${esc(g.label.toLowerCase())}</i></td><td class="n"><b>${fmt(g.total)}</b></td></tr>` : '<tr><td style="padding-left:22px" class="faint">Nothing here</td><td class="n">—</td></tr>'}`;

  return `
    <h2>Balance sheet
      ${bs.balanced ? tag('balances ✓', 'ok') : tag('out by ' + fmt(bs.diff), 'rev')}
      <span class="small faint">as at ${esc(jTo)}</span></h2>
    <div class="grid g1" style="grid-template-columns:1fr 1fr">
      <div class="card pad0">
        <div class="tbl-wrap"><table>
          <thead><tr><th>What the business owns</th><th class="n">Amount</th></tr></thead>
          <tbody>
            ${bs.assets.map(group).join('')}
            <tr><td><b>Total assets</b></td><td class="n"><b>${fmt(bs.totalAssets)}</b></td></tr>
          </tbody>
        </table></div>
      </div>
      <div class="card pad0">
        <div class="tbl-wrap"><table>
          <thead><tr><th>Where it came from</th><th class="n">Amount</th></tr></thead>
          <tbody>
            ${bs.funds.map(group).join('')}
            <tr><td colspan="2" class="lead"><b>Profit kept in the business</b></td></tr>
            <tr><td style="padding-left:22px">Earlier years</td><td class="n">${signed(bs.profitEarlier)}</td></tr>
            <tr><td style="padding-left:22px">This financial year</td><td class="n">${signed(bs.profitThisYear)}</td></tr>
            <tr><td><b>Total funds and liabilities</b></td><td class="n"><b>${fmt(bs.totalFunds)}</b></td></tr>
          </tbody>
        </table></div>
      </div>
    </div>
    ${bs.balanced ? '' : note(`The two sides differ by <b>${fmt(bs.diff)}</b>. Every entry balances on its own, so a gap here means an account is missing from the statement — tell your CA before filing anything.`, 'warn')}
    <p class="small faint">Fixed assets are shown at cost with accumulated depreciation beneath them, as a negative figure.</p>`;
}

function ledgerSection() {
  const used = ACCOUNTS.filter(a => st().txns.some(t => t.lines.some(l => l.acc === a.code)));
  if (!used.some(a => a.code === ledgerAcc)) ledgerAcc = used[0]?.code || '1000';
  const rows = ledger(ledgerAcc, { party: ledgerParty || undefined, from: jFrom, upto: jTo });
  const sign = (A[ledgerAcc].type === 'asset' || A[ledgerAcc].type === 'expense') ? 1 : -1;
  const opening = Math.round(sign * bal(ledgerAcc, { upto: addDays(jFrom, -1) }) * 100) / 100;
  const dr = rows.reduce((a, r) => a + num(r.dr), 0);
  const cr = rows.reduce((a, r) => a + num(r.cr), 0);
  const closing = Math.round((opening + dr - cr) * 100) / 100;

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
    ${table(
    `<th>Date</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th>`,
    `<tr><td class="nowrap small">${esc(jFrom)}</td><td><i>Opening balance</i></td><td class="n"></td><td class="n"></td><td class="n">${fmt(opening)}</td></tr>` +
    rows.map(r => `<tr class="click" onclick="fin.openTxn('${esc(r.txnId)}')">
        <td class="nowrap small">${esc(r.date)}</td>
        <td class="lead">${esc(r.desc)}${r.party ? `<br><span class="small faint">${esc(pname(r.party))}</span>` : ''}</td>
        <td class="n" data-label="Debit">${r.dr ? fmt(r.dr) : ''}</td>
        <td class="n" data-label="Credit">${r.cr ? fmt(r.cr) : ''}</td>
        <td class="n" data-label="Balance">${fmt(Math.round((opening + r.balance) * 100) / 100)}</td>
      </tr>`).join(''),
    `<tr><td colspan="2">Closing balance</td><td class="n">${fmt(dr)}</td><td class="n">${fmt(cr)}</td><td class="n">${fmt(closing)}</td></tr>`,
    { stack: true })}
    <p class="small faint">The running balance starts from what the account held on ${esc(jFrom)}, so it is the real ledger balance, not a total of the rows shown.</p>`;
}

// Purchase and sales registers — every document raised or received in the period, which is
// what a GST audit and a CA both ask for by name.
function registerSection() {
  const s = st();
  const bills = (s.bills || []).filter(b => b.paid !== undefined && b.date >= jFrom && b.date <= jTo)
    .sort((a, b) => a.date.localeCompare(b.date));
  const invs = (s.invoices || []).filter(i => i.paid !== undefined && i.date >= jFrom && i.date <= jTo)
    .sort((a, b) => a.date.localeCompare(b.date));
  const money = x => x ? fmt(x) : '';
  const statusTag = d => d.status === 'void' ? tag('reversed', 'rev') : d.status === 'paid' ? tag('settled', 'ok') : d.status === 'part' ? tag('part', 'warn') : tag('open', 'warn');

  return `
    <h2>Registers <span class="small faint">${esc(jFrom)} to ${esc(jTo)}</span></h2>
    <details class="card pad0 bucket">
      <summary><b>Purchases</b> <span class="faint small">every bill received, with its number and due date</span> <span class="n">${bills.length}</span></summary>
      ${bills.length ? table(
      `<th>Date</th><th>Vendor</th><th>Bill no</th><th>For</th><th class="n">Taxable</th><th class="n">GST</th><th class="n">Total</th><th>Due</th><th></th>`,
      bills.map(b => `<tr${b.txnId ? ` class="click" onclick="fin.openTxn('${esc(b.txnId)}')"` : ''}>
          <td class="nowrap small">${esc(b.date)}</td>
          <td class="lead">${esc(b.vendorName || pname(b.partyId) || '')}</td>
          <td class="small">${esc(b.billNo || '')}${!b.billNo ? '<span class="faint">awaited</span>' : ''}</td>
          <td class="small" data-label="For">${esc(b.desc)}${b.period && b.period !== ym(b.date) ? ` <span class="faint">(${esc(mlabel(b.period))})</span>` : ''}</td>
          <td class="n" data-label="Taxable">${money(num(b.taxable))}</td>
          <td class="n" data-label="GST">${money(num(b.gst))}</td>
          <td class="n" data-label="Total">${money(num(b.total))}</td>
          <td class="small" data-label="Due">${esc(b.dueDate || '')}</td>
          <td>${statusTag(b)}</td>
        </tr>`).join(''),
      `<tr><td colspan="4">Total purchases</td>
         <td class="n">${fmt(bills.reduce((a, b) => a + num(b.taxable), 0))}</td>
         <td class="n">${fmt(bills.reduce((a, b) => a + num(b.gst), 0))}</td>
         <td class="n">${fmt(bills.reduce((a, b) => a + num(b.total), 0))}</td><td colspan="2"></td></tr>`,
      { stack: true }) : empty('No bills in this period.')}
    </details>
    <details class="card pad0 bucket">
      <summary><b>Sales</b> <span class="faint small">every invoice and credit note raised</span> <span class="n">${invs.length}</span></summary>
      ${invs.length ? table(
      `<th>Date</th><th>Number</th><th>Client</th><th class="n">Base</th><th class="n">GST</th><th class="n">Total</th><th>Due</th><th></th>`,
      invs.map(i => `<tr${i.txnId ? ` class="click" onclick="fin.openTxn('${esc(i.txnId)}')"` : ''}>
          <td class="nowrap small">${esc(i.date)}</td>
          <td class="small">${esc(i.invoiceNo || '')}${i.kind === 'creditnote' ? ' ' + tag('credit note', 'warn') : ''}</td>
          <td class="lead">${esc(pname(i.partyId) || '')}</td>
          <td class="n" data-label="Base">${money(num(i.base))}</td>
          <td class="n" data-label="GST">${money(num(i.cgst) + num(i.sgst) + num(i.igst))}</td>
          <td class="n" data-label="Total">${money(num(i.total))}</td>
          <td class="small" data-label="Due">${esc(i.dueDate || '')}</td>
          <td>${statusTag(i)}</td>
        </tr>`).join(''),
      `<tr><td colspan="3">Total sales</td>
         <td class="n">${fmt(invs.reduce((a, i) => a + num(i.base), 0))}</td>
         <td class="n">${fmt(invs.reduce((a, i) => a + num(i.cgst) + num(i.sgst) + num(i.igst), 0))}</td>
         <td class="n">${fmt(invs.reduce((a, i) => a + num(i.total), 0))}</td><td colspan="2"></td></tr>`,
      { stack: true }) : empty('No invoices in this period.')}
    </details>`;
}

function journalRows() {
  return st().txns
    .filter(t => t.date >= jFrom && t.date <= jTo)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function journalSection() {
  const rows = journalRows();
  return `
    <h2>General journal <span class="small faint">${rows.length} entries</span></h2>
    ${rows.length ? table(
    `<th>Date</th><th>Entry</th><th>Account</th><th class="n">Debit</th><th class="n">Credit</th>`,
    rows.map(t => t.lines.map((l, i) => `<tr class="click" onclick="fin.openTxn('${esc(t.id)}')">
        <td class="nowrap small">${i === 0 ? esc(t.date) : ''}</td>
        <td>${i === 0 ? esc(t.desc) : ''}</td>
        <td class="small">${esc(A[l.acc]?.code || l.acc)} · ${esc(A[l.acc]?.name || l.acc)}</td>
        <td class="n">${l.dr ? fmt(l.dr) : ''}</td>
        <td class="n">${l.cr ? fmt(l.cr) : ''}</td>
      </tr>`).join('')).join(''))
      : empty('No entries in that range.')}`;
}

// ═══════ EXPORTS ═══════

const scopeSuffix = () => scopeMode() === 'with' ? '' : '-' + scopeMode() + '-petty-cash';
const scopeRow = () => scopeMode() === 'with' ? [] : [[`Petty-cash scope: ${scopeLabel()}`]];

function journalCsvRows() {
  const rows = [...scopeRow(), ['Txn', 'Date', 'Description', 'Account code', 'Account name', 'Debit', 'Credit', 'Party', 'Event']];
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
  const rows = [...scopeRow(), ['Date', 'Voucher Type', 'Voucher No', 'Ledger Name', 'Debit', 'Credit', 'Narration']];
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
    period(which) {
      const s = getState();
      if (which === 'fy') {
        const fy = fyOf(today(), s.settings.fyStartMonth);
        jFrom = fyStart(fy, s.settings.fyStartMonth); jTo = today();
      } else if (which === 'month') {
        jFrom = ym(today()) + '-01'; jTo = today();
      } else {
        jFrom = s.txns.map(t => t.date).sort()[0] || today(); jTo = today();
      }
      window.fin.repaint();
    },
    csvTrial() { return scoped(() => this._csvTrial(), 'with'); },
    _csvTrial() {
      const tb = trialBalanceDetail(jFrom, jTo);
      downloadCsv(`3pin-trial-balance-${jFrom}-to-${jTo}.csv`,
        [['Code', 'Account', 'Opening Dr', 'Opening Cr', 'Debit', 'Credit', 'Closing Dr', 'Closing Cr'],
        ...tb.rows.map(r => [r.acc.code, r.acc.name,
          r.opening > 0 ? r.opening : '', r.opening < 0 ? -r.opening : '',
          r.debit || '', r.credit || '',
          r.closing > 0 ? r.closing : '', r.closing < 0 ? -r.closing : '']),
        ['', 'Total', tb.totals.openingDr, tb.totals.openingCr, tb.totals.debit, tb.totals.credit, tb.totals.closingDr, tb.totals.closingCr]]);
    },
    csvGeneralLedger() { return scoped(() => this._csvGeneralLedger()); },
    _csvGeneralLedger() {
      const rows = [['Code', 'Account', 'Date', 'Entry', 'Description', 'Party', 'Debit', 'Credit', 'Balance']];
      for (const a of ACCOUNTS) {
        const ls = ledger(a.code, { from: jFrom, upto: jTo });
        if (!ls.length) continue;
        const sign = (a.type === 'asset' || a.type === 'expense') ? 1 : -1;
        const opening = Math.round(sign * bal(a.code, { upto: addDays(jFrom, -1) }) * 100) / 100;
        rows.push([a.code, a.name, jFrom, '', 'Opening balance', '', '', '', opening]);
        for (const r of ls) rows.push([a.code, a.name, r.date, r.txnId, r.desc, r.party ? pname(r.party) : '', r.dr || '', r.cr || '', Math.round((opening + r.balance) * 100) / 100]);
      }
      downloadCsv(`3pin-ledgers-${jFrom}-to-${jTo}${scopeSuffix()}.csv`, [...scopeRow(), ...rows]);
    },

    csvCategory(slug) { return scoped(() => this._csvCategory(slug)); },
    _csvCategory(slug) {
      const p = repMode === 'month' ? pl(repMonth) : pl(null, null, repFy);
      const label = repMode === 'month' ? repMonth : repFy;
      if (slug === 'cashflow') {
        downloadCsv(`3pin-cashflow-${label}${scopeSuffix()}.csv`,
          [['Type', 'In', 'Out', 'Net'], ...cashFlowRows().map(r => [r.kind, r.in, r.out, r.in - r.out])]);
        return;
      }
      const map = slug === 'income' ? p.inc : p.exp;
      downloadCsv(`3pin-${slug}-${label}${scopeSuffix()}.csv`,
        [['Code', 'Category', 'Amount'],
        ...Object.entries(map).map(([c, v]) => [c, A[c]?.name || c, v])]);
    },

    setPockets(p) { cbPockets = p; window.fin.repaint(); },
    csvCashBook: () => scoped(() => downloadCsv(`3pin-cash-book-${repMode === 'month' ? repMonth : repFy}${scopeSuffix()}.csv`, cashBookCsvRows())),
    csvJournal: () => scoped(() => downloadCsv(`3pin-journal-${jFrom}-to-${jTo}${scopeSuffix()}.csv`, journalCsvRows())),
    csvTally: () => scoped(() => downloadCsv(`3pin-tally-${jFrom}-to-${jTo}${scopeSuffix()}.csv`, tallyCsvRows())),
    csvLedger() { return scoped(() => this._csvLedger()); },
    _csvLedger() {
      const rows = ledger(ledgerAcc, { party: ledgerParty || undefined, from: jFrom, upto: jTo });
      downloadCsv(`3pin-ledger-${ledgerAcc}${scopeSuffix()}.csv`,
        [['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Party'],
        ...rows.map(r => [r.date, r.desc, r.dr || '', r.cr || '', r.balance, r.party ? pname(r.party) : ''])]);
    },
    exportAll: () => downloadJson(`3pin-finance-backup-${today()}.json`, getState()),
  };
}
