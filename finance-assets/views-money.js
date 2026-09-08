// ═══════ PETTY CASH · BUDGET ═══════
//
// Two views over money that already exists in the books. Petty cash is account 1010 seen
// from the owner's side of the drawer: what went in, what went out, what it paid for, and
// what should be in it right now. Budget is the month ahead set against the month that
// happened: every expectation the books already hold (recurring commitments, loan interest,
// depreciation, deals expected to close) plus anything typed in, against the actual P&L.
// Neither view enters anything — every button opens the Record screen.

import {
  fmt, esc, num, today, ym, addMonths, mlabel, getState, bal, A, ACCOUNTS,
  pettyActivity, projection, budgetLines, PETTY, monthPicture, awaitingBill, outlook,
} from './finance-core.js';
import { stat, signed, empty, note, tag, table, seg, dueCell } from './ui.js';
import * as SY from './finance-sync.js';

// ═══════ PETTY CASH ═══════

let pettyMonth = ym(today());

const KIND_LABEL = { topup: 'Added from the bank', in: 'Money in', spend: 'Spent from the box', sweep: 'Sent back to the bank' };

export function renderPetty() {
  const all = pettyActivity();
  const thisM = pettyActivity({ month: pettyMonth });
  const lastTop = all.rows.find(r => r.kind === 'topup');
  const months = [...new Set(all.rows.map(r => ym(r.t.date)))].sort().reverse();
  if (!months.includes(pettyMonth)) months.unshift(pettyMonth);

  return `
    <h1>Petty cash</h1>
    <p class="lead">The cash box, account 1010. Money goes in from the bank, goes out as small spends,
    and the balance here should match the notes in the drawer.</p>

    <div class="grid g3">
      ${stat('In the box now', fmt(all.balance), { hero: true })}
      ${stat('Added in ' + mlabel(pettyMonth), fmt(thisM.topups + thisM.received))}
      ${stat('Spent in ' + mlabel(pettyMonth), fmt(thisM.spent + thisM.swept), { cls: thisM.spent > 0.5 ? 'neg' : '' })}
      ${stat('Last top-up', lastTop ? fmt(lastTop.in) : '—', { sub: lastTop ? esc(lastTop.t.date) : 'Never' })}
    </div>

    <div class="actions">
      <button class="btn primary" type="button" onclick="fin.record('transfer',{kind:'1000>1010'})">Add money to the box</button>
      <button class="btn out" type="button" onclick="fin.record('petty')">Record spends from the box</button>
      <button class="btn" type="button" onclick="fin.record('transfer',{kind:'1010>1000'})">Send cash back to the bank</button>
    </div>

    ${all.balance < -0.5 ? note('<b>The box is negative.</b> Something was recorded as paid from petty cash that the box could not have covered — a top-up is missing, or a spend was recorded against the wrong account.', 'warn') : ''}

    <div class="actions" style="justify-content:space-between">
      <h2 style="margin:0;border:0;padding:0">Everything through the box</h2>
      <select onchange="finMoney.setPettyMonth(this.value)" aria-label="Month" style="max-width:190px">
        <option value="">All months</option>
        ${months.map(m => `<option value="${m}" ${m === pettyMonth ? 'selected' : ''}>${esc(mlabel(m))}</option>`).join('')}
      </select>
    </div>
    ${(() => {
      const rows = pettyMonth ? thisM.rows : all.rows;
      if (!rows.length) return empty('Nothing has gone through the box' + (pettyMonth ? ' in ' + esc(mlabel(pettyMonth)) : '') + '.');
      let running = pettyMonth ? bal(PETTY, { upto: addMonths(pettyMonth, -1) + '-31' }) : 0;
      const ordered = [...rows].reverse();
      const withBal = ordered.map(r => { running = Math.round((running + r.in - r.out) * 100) / 100; return { ...r, after: running }; }).reverse();
      return table(
        `<th>Date</th><th>What</th><th class="n">In</th><th class="n">Out</th><th class="n">Box after</th>`,
        withBal.map(r => `<tr class="click" onclick="fin.openTxn('${esc(r.t.id)}')">
          <td class="lead">${esc(r.t.desc)} ${tag(KIND_LABEL[r.kind] || r.kind, r.kind === 'spend' ? 'rev' : r.kind === 'topup' ? 'ok' : '')}
            <br><span class="small faint">${esc(r.what)}</span></td>
          <td class="nowrap small" data-label="Date">${esc(r.t.date)}</td>
          <td class="n" data-label="In">${r.in ? fmt(r.in) : '—'}</td>
          <td class="n" data-label="Out">${r.out ? fmt(r.out) : '—'}</td>
          <td class="n" data-label="Box after">${fmt(r.after)}</td>
        </tr>`).join(''),
        `<tr><td colspan="2" data-label="Totals">Totals</td><td class="n">${fmt(rows.reduce((a, r) => a + r.in, 0))}</td><td class="n">${fmt(rows.reduce((a, r) => a + r.out, 0))}</td><td></td></tr>`,
        { stack: true });
    })()}

    ${note('To see the box across every other screen — Transactions, Reports, Analytics, exports — use the <b>Petty cash</b> switch at the top: <i>Only</i> shows what went through the box, <i>Without</i> leaves it out. The trial balance and balance sheet always show everything.', 'info')}`;
}

// ═══════ BUDGET AND PROJECTIONS ═══════

let budgetMonth = ym(today());

export function renderBudget() {
  const p = projection(budgetMonth);
  const typed = budgetLines(budgetMonth);
  const inc = p.rows.filter(r => r.type === 'income');
  const exp = p.rows.filter(r => r.type === 'expense');
  const past = budgetMonth < ym(today());
  const diffCls = (r, v) => Math.abs(v) <= 0.5 ? '' : (r.type === 'income' ? (v > 0 ? 'pos' : 'neg') : (v > 0 ? 'neg' : 'pos'));

  const rowsFor = list => list.map(r => `<tr>
      <td class="lead">${esc(r.name)} <span class="small faint">${esc(r.code)}</span></td>
      <td class="n" data-label="Expected">
        <input type="number" inputmode="decimal" step="1" min="0" class="budget-in" value="${r.typed ? num(typed[r.code]) : ''}"
          placeholder="${r.planned ? fmt(r.planned).replace('₹', '') : '—'}" data-code="${esc(r.code)}"
          aria-label="Budget for ${esc(r.name)}" onchange="finMoney.setBudget('${esc(r.code)}', this.value)">
        ${r.typed && r.why[0] === 'budget' ? '' : ''}</td>
      <td class="n" data-label="Actual">${r.actual ? fmt(r.actual) : '<span class="faint">—</span>'}</td>
      <td class="n" data-label="Difference"><span class="${diffCls(r, r.variance)}">${r.planned || r.actual ? (r.variance > 0 ? '+' : r.variance < 0 ? '−' : '') + fmt(Math.abs(r.variance)) : '—'}</span></td>
      <td class="small" data-label="Where from">${r.typed ? 'Typed' + (r.why.length > 1 ? ' — overrides ' + esc(r.why.slice(1).join(', ')) : '') : esc(r.why.join(', ')) || '<span class="faint">actuals only</span>'}</td>
    </tr>`).join('');

  return `
    <h1>Budget</h1>
    <p class="lead">What you expect the month to look like, set against what actually happened. Expectations come from
    what the books already know — recurring costs, loan interest, depreciation, deals due to close — and anything you type here.
    <b>Nothing on this page is an entry.</b></p>

    <div class="actions" style="align-items:center">
      <button class="btn ghost sm" type="button" onclick="finMoney.budgetShift(-1)" aria-label="Previous month">◀</button>
      <h2 style="margin:0;border:0;padding:0;min-width:160px;text-align:center">${esc(mlabel(budgetMonth))}</h2>
      <button class="btn ghost sm" type="button" onclick="finMoney.budgetShift(1)" aria-label="Next month">▶</button>
      <div class="spacer"></div>
      <button class="btn ghost sm" type="button" onclick="finMoney.copyBudget()">Copy last month's typed figures</button>
    </div>

    <div class="grid g3">
      ${stat('Expected income', fmt(p.planned.income), { sub: `Actual ${fmt(p.actual.income)}` })}
      ${stat('Expected costs', fmt(p.planned.expense), { sub: `Actual ${fmt(p.actual.expense)}` })}
      ${stat('Expected profit', signed(p.planned.profit), { raw: true, hero: true, sub: `Actual ${fmt(p.actual.profit)}` })}
      ${stat('Loan principal due', fmt(p.principal), { sub: 'Cash out, not a cost' })}
    </div>

    ${past && Math.abs(p.actual.profit - p.planned.profit) > 0.5 ? note(`${esc(mlabel(budgetMonth))} came in <b>${fmt(Math.abs(p.actual.profit - p.planned.profit))} ${p.actual.profit > p.planned.profit ? 'better' : 'worse'}</b> than expected.`, p.actual.profit >= p.planned.profit ? 'info' : 'warn') : ''}

    <h2>Income</h2>
    ${inc.length ? table(`<th>Account</th><th class="n">Expected</th><th class="n">Actual</th><th class="n">Difference</th><th>Where from</th>`, rowsFor(inc), '', { stack: true })
      : empty('No income expected or recorded this month. Add a deal with an expected close month, or type a figure below.')}
    <div class="actions"><button class="btn ghost sm" type="button" onclick="finMoney.addBudgetLine('income')">Add an income line</button></div>

    <h2>Costs</h2>
    ${exp.length ? table(`<th>Account</th><th class="n">Expected</th><th class="n">Actual</th><th class="n">Difference</th><th>Where from</th>`, rowsFor(exp), '', { stack: true })
      : empty('No costs expected this month yet.')}
    <div class="actions"><button class="btn ghost sm" type="button" onclick="finMoney.addBudgetLine('expense')">Add a cost line</button></div>

    ${note('A typed figure is yours and wins over what the app worked out for that account. Leave a box empty to use the projection the app worked out, shown as the placeholder. Recurring costs are managed on the Recurring tab; deals on the Deals tab.', 'info')}`;
}

// ═══════ THIS MONTH ═══════
//
// The question this page answers is not "what did I spend" but "can I spend". A commitment
// passes through four states — estimate, event, bill with a due date, payment — and the
// owner needs all four at once: what has gone, what is coming, what is only a guess, and
// what that leaves. Money out and money in are shown apart and then together, because a
// decision to spend depends on both. Nothing here is an entry; every figure is read from
// the books, the documents and the commitments.

let picMonth = ym(today());

const BUCKETS = [
  ['paid', 'Paid', 'Money that actually left or arrived this month'],
  ['invoiced', 'Invoiced', 'Documents dated this month, still unsettled'],
  ['due', 'Due this month', 'Falls due between the 1st and the last'],
  ['overdue', 'Overdue', 'Was due before this month and is still open'],
  ['estimated', 'Still an estimate', 'Expected, but no event and no document yet'],
];

function bucketRows(b, side) {
  if (!b.rows.length) return empty('Nothing in this group.');
  return table(
    `<th>What</th><th>When</th><th class="n">Amount</th>`,
    b.rows.map(r => `<tr${r.txnId ? ` class="click" onclick="fin.openTxn('${esc(r.txnId)}')"` : ''}>
      <td class="lead">${esc(r.what)}${r.waiting ? ' <span class="small faint">— waiting for the vendor bill</span>' : ''}${r.noCash ? ' <span class="small faint">— no money moves</span>' : ''}
        ${r.period && r.period !== picMonth ? `<br><span class="small faint">${esc(mlabel(r.period))} cost</span>` : ''}</td>
      <td class="small nowrap" data-label="When">${esc(String(r.when || ''))}</td>
      <td class="n" data-label="Amount">${fmt(r.amt)}</td>
    </tr>`).join(''),
    `<tr><td colspan="2">Total ${esc(side)}</td><td class="n">${fmt(b.amt)}</td></tr>`,
    { stack: true });
}

function sideBlock(title, s, side, tone) {
  return `
    <h2>${esc(title)}</h2>
    <div class="grid g3">
      ${stat('Paid', fmt(s.paid.amt), { sub: side === 'out' ? 'Left the bank and the box' : 'Reached the bank and the box' })}
      ${stat('Invoiced', fmt(s.invoiced.amt), { sub: 'Dated this month, unsettled' })}
      ${stat('Due this month', fmt(s.due.amt), { cls: side === 'out' && s.due.amt > 0.5 ? tone : '' })}
      ${stat('Overdue', fmt(s.overdue.amt), { cls: s.overdue.amt > 0.5 ? 'neg' : '', sub: s.overdue.amt > 0.5 ? 'Should already have been settled' : 'Nothing behind' })}
      ${stat('Still an estimate', fmt(s.estimated.amt), { sub: 'No event, no document' })}
      ${stat(side === 'out' ? 'Still to find' : 'Still to come', fmt(s.committed), { hero: true, sub: 'Due + overdue + estimates' })}
    </div>
    <p class="small muted">The books count ${fmt(s.booked)} of ${esc(side === 'out' ? 'cost' : 'income')} for this month — what belongs to it, whoever has been paid.</p>
    ${BUCKETS.map(([k, label, why]) => `
      <details class="card pad0 bucket">
        <summary><b>${esc(label)}</b> <span class="faint small">${esc(why)}</span> <span class="n">${fmt(s[k].amt)}</span></summary>
        ${bucketRows(s[k], label.toLowerCase())}
      </details>`).join('')}`;
}

// Three months ahead on what is already known. Deliberately short: past three months the
// estimates outnumber the facts and the number stops being worth acting on.
function outlookBlock() {
  const o = outlook(3, ym(today()));
  return `
    <h2>If nothing changes</h2>
    <p class="small muted">The next three months using only what the books already know — bills with due dates, recurring commitments, loan instalments, deals expected to close. Starting from ${fmt(o.opening)} in the bank and the box today.</p>
    ${table(
    `<th>Month</th><th class="n">Out — certain</th><th class="n">Out — estimated</th><th class="n">Expected in</th><th class="n">Left at month end</th>`,
    o.rows.map(r => `<tr class="click" onclick="finMoney.goMonth('${esc(r.month)}')">
      <td class="lead">${esc(mlabel(r.month))}</td>
      <td class="n" data-label="Out — certain">${fmt(r.committed)}</td>
      <td class="n" data-label="Out — estimated">${fmt(r.guessed)}</td>
      <td class="n" data-label="Expected in">${fmt(r.in)}</td>
      <td class="n" data-label="Left at month end"><span class="${r.short ? 'neg' : ''}">${signed(r.closing)}</span></td>
    </tr>`).join(''), '', { stack: true })}
    ${o.firstShort
    ? note(`On what is known today the money runs out in <b>${esc(mlabel(o.firstShort))}</b>. Bills with due dates will happen; the estimated column may not. Collect earlier, or move what is only an estimate.`, 'warn')
    : note('Nothing known today puts you short in the next three months. Only what has been recorded or committed is counted — a deal you have not entered is not in here.', 'info')}`;
}

export function renderMonth() {
  const p = monthPicture(picMonth);
  const waiting = awaitingBill();
  const past = picMonth < ym(today());
  const cur = picMonth === ym(today());

  return `
    <h1>This month</h1>
    <p class="lead">Everything that belongs to ${esc(mlabel(picMonth))}, at whichever stage it has reached —
    still a guess, recorded as an event, invoiced with a date to pay, or settled. Nothing on this page is an entry.</p>

    <div class="actions" style="align-items:center">
      <button class="btn ghost sm" type="button" onclick="finMoney.monthShift(-1)" aria-label="Previous month">◀</button>
      <h2 style="margin:0;border:0;padding:0;min-width:170px;text-align:center">${esc(mlabel(picMonth))}</h2>
      <button class="btn ghost sm" type="button" onclick="finMoney.monthShift(1)" aria-label="Next month" ${picMonth >= ym(addMonths(today(), 12)) ? 'disabled' : ''}>▶</button>
      ${cur ? '' : `<button class="btn ghost sm" type="button" onclick="finMoney.thisMonth()">Back to ${esc(mlabel(ym(today())))}</button>`}
      <div class="spacer"></div>
      <button class="btn" type="button" onclick="fin.go('budget')">Set expectations</button>
      <button class="btn primary" type="button" onclick="fin.go('record')">Record something</button>
    </div>

    <h2>Can I spend?</h2>
    <div class="card">
      <div class="grid g3">
        ${stat('In the bank and the box', fmt(p.cash.now), { hero: true })}
        ${stat('Still to pay this month', fmt(p.cash.needed), { cls: p.cash.needed > 0.5 ? 'neg' : '' })}
        ${stat('Still to come in', fmt(p.cash.expected), { cls: p.cash.expected > 0.5 ? 'pos' : '' })}
        ${stat('Left if everything lands', signed(p.cash.after), { raw: true, sub: p.cash.after < 0 ? 'Short — collect earlier or delay something' : 'Room to commit' })}
      </div>
      ${p.cash.after < 0
      ? note(`Everything known about ${esc(mlabel(picMonth))} leaves you <b>${fmt(Math.abs(p.cash.after))} short</b>. What is still an estimate can move; what is due cannot.`, 'warn')
      : note(`After what is due and what is expected, <b>${fmt(p.cash.after)}</b> is uncommitted. Estimates can still change when the bill comes.`, 'info')}
    </div>

    ${waiting.length ? `
      <h2>Waiting for the vendor bill</h2>
      ${note(`${waiting.length} month${waiting.length === 1 ? '' : 's'} ${waiting.length === 1 ? 'was' : 'were'} closed on your own figure and ${waiting.length === 1 ? 'has' : 'have'} no vendor bill number yet. When the invoice arrives, record it — the cost stays in the month you used it.`, 'info')}
      ${table(
      `<th>What</th><th>Recorded for</th><th class="n">Amount</th><th></th>`,
      waiting.map(b => `<tr>
          <td class="lead">${esc(b.vendorName || 'Vendor')} — ${esc(b.desc)}</td>
          <td class="small" data-label="Recorded for">${esc(mlabel(b.period || b.month || ym(b.date)))}</td>
          <td class="n" data-label="Amount">${fmt(b.net ?? b.total)}</td>
          <td class="n"><button class="btn ghost sm out" type="button" onclick="fin.record('billarrived',{billId:'${esc(b.id)}'})">Bill arrived</button></td>
        </tr>`).join(''), '', { stack: true })}` : ''}

    ${outlookBlock()}

    ${sideBlock('Money out', p.out, 'out', 'neg')}
    ${sideBlock('Money in', p.in, 'in', 'pos')}

    <h2>Together</h2>
    <div class="grid g3">
      ${stat('Net settled so far', signed(p.net.paid), { raw: true, sub: 'Money in less money out this month' })}
      ${stat('Net still to settle', signed(p.net.toSettle), { raw: true, sub: 'Invoices to collect less bills to pay' })}
      ${stat('Net still a guess', signed(p.net.estimated), { raw: true, sub: 'Income estimates less cost estimates' })}
      ${stat('Profit the books show', signed(p.net.booked), { raw: true, hero: true, sub: 'Earned less incurred, whoever has paid' })}
    </div>
    ${past ? note(`${esc(mlabel(picMonth))} is behind you. Anything still showing as an estimate never became an event — either it did not happen, or the month was never recorded.`, 'info') : ''}

    ${note('Profit and cash are different questions. The books count a cost in the month you used the thing; cash counts it on the day it left. This page shows both, side by side, so a decision to spend can be made on the cash line while the profit line stays honest.', 'info')}`;
}

// ═══════ ACTIONS ═══════

if (typeof window !== 'undefined') {
  window.finMoney = {
    setPettyMonth(m) { pettyMonth = m; window.fin.repaint(); },
    monthShift(n) { picMonth = addMonths(picMonth, n); window.fin.repaint(); },
    thisMonth() { picMonth = ym(today()); window.fin.repaint(); },
    goMonth(m) { picMonth = m; window.fin.repaint(); },
    budgetShift(n) { budgetMonth = addMonths(budgetMonth, n); window.fin.repaint(); },
    async setBudget(code, value) {
      const v = String(value).trim();
      const key = `budgets.${budgetMonth}.${code}`;
      try {
        // Firestore cannot delete a nested key with a merge write, so a cleared box is stored
        // as null and read back as "not typed".
        await SY.saveSettings({ [key]: v === '' ? null : num(v) });
        const st = getState();
        st.settings.budgets = st.settings.budgets || {};
        st.settings.budgets[budgetMonth] = st.settings.budgets[budgetMonth] || {};
        if (v === '') delete st.settings.budgets[budgetMonth][code]; else st.settings.budgets[budgetMonth][code] = num(v);
        window.fin.repaint();
      } catch (e) { window.fin.toast(e.message || 'Could not save'); }
    },
    addBudgetLine(type) {
      const opts = ACCOUNTS.filter(a => a.type === type).map(a => `<option value="${a.code}">${a.code} · ${esc(a.name)}</option>`).join('');
      window.fin.modal({
        title: type === 'income' ? 'Expected income' : 'Expected cost',
        body: `<div class="field"><label for="b_acc">Account</label><select id="b_acc">${opts}</select></div>
               <div class="field"><label for="b_amt">Expected in ${esc(mlabel(budgetMonth))}</label><input id="b_amt" type="number" inputmode="decimal" min="0"></div>`,
        foot: `<button class="btn primary" type="button" onclick="finMoney.saveBudgetLine()">Save</button>`,
      });
    },
    async saveBudgetLine() {
      const code = document.getElementById('b_acc').value;
      const amt = document.getElementById('b_amt').value;
      window.fin.closeModal();
      await this.setBudget(code, amt);
    },
    async copyBudget() {
      const prev = budgetLines(addMonths(budgetMonth, -1));
      const keys = Object.keys(prev);
      if (!keys.length) return window.fin.toast('Nothing typed for last month');
      const patch = {};
      for (const [code, amt] of Object.entries(prev)) patch[`budgets.${budgetMonth}.${code}`] = num(amt);
      try {
        await SY.saveSettings(patch);
        const st = getState();
        st.settings.budgets = st.settings.budgets || {};
        st.settings.budgets[budgetMonth] = { ...(st.settings.budgets[budgetMonth] || {}), ...prev };
        window.fin.repaint();
      } catch (e) { window.fin.toast(e.message || 'Could not save'); }
    },
  };
}
