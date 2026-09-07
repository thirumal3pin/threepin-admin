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
  pettyActivity, projection, budgetLines, PETTY,
} from './finance-core.js';
import { stat, signed, empty, note, tag, table, seg } from './ui.js';
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

// ═══════ ACTIONS ═══════

if (typeof window !== 'undefined') {
  window.finMoney = {
    setPettyMonth(m) { pettyMonth = m; window.fin.repaint(); },
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
