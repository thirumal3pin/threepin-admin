// ═══════ SERVICES, LOANS, ASSETS ═══════
//
// Three read-only views over the master records. Like Owed, none of them enter data: each
// button opens the Record screen pre-filled, so every journal entry in the system is still
// created in exactly one place.

import {
  fmt, esc, num, today, ym, addMonths, mlabel, getState, bal,
  prepaidLeft, serviceRunRate, pname,
} from './finance-core.js';
import { stat, signed, empty, note, tag, table, daysBetween } from './ui.js';

// ═══════ SERVICES ═══════

// An upfront plan's term ends on the last day of its end month; that is the date the vendor
// will actually take the renewal, so it is what "renews soon" has to measure against.
function renewalDate(sub) {
  if (!sub.end) return null;
  const [y, m] = sub.end.split('-').map(Number);
  return new Date(y, m, 0).toISOString().slice(0, 10);
}

function thisMonthCell(sub, month) {
  if (sub.payMode === 'upfront') {
    return (sub.amortized || []).includes(month)
      ? `<span class="pos">released</span>`
      : `<span class="faint">auto at month-end</span>`;
  }
  const c = (sub.charges || {})[month];
  if (!c) return `<span class="faint">not yet</span>`;
  if (c.skipped) return `<span class="faint">skipped</span>`;
  return `<span class="pos">${fmt(c.actual)}</span>`;
}

export function renderServices() {
  const s = getState();
  const month = ym(today());
  const rr = serviceRunRate();
  const active = s.subs.filter(x => x.status === 'active');
  const past = s.subs.filter(x => x.status !== 'active');

  if (!s.subs.length) {
    return `<h1>Services</h1>
      ${empty('<b>No services yet.</b><br>Add your subscriptions — CRM, ads, phone, software — and this page tells you what they really cost you every month.',
      '<button class="btn primary" type="button" onclick="fin.record(\'subnew\')">Add a service</button>')}`;
  }

  return `
    <h1>Services</h1>
    <p class="lead">What your tools actually cost per month, whether you pay monthly or once a year.</p>

    <div class="grid g3">
      ${stat('Run rate', fmt(rr.monthly) + '/mo')}
      ${stat('Annual commitment', fmt(rr.annual))}
      ${stat('Prepaid with vendors', fmt(rr.prepaidUnused), { sub: 'Paid for but not yet used' })}
      ${stat('Active', String(active.length))}
    </div>

    <div class="actions">
      <button class="btn primary" type="button" onclick="fin.record('subnew')">Add a service</button>
    </div>

    ${active.length ? table(
    `<th>Service</th><th>What for</th><th class="n">Per month</th><th>Paid</th><th>Period</th><th>${esc(mlabel(month))}</th><th></th>`,
    active.map(sub => {
      const rd = renewalDate(sub);
      const soon = rd && daysBetween(today(), rd) >= 0 && daysBetween(today(), rd) <= 7;
      return `<tr>
          <td><b>${esc(sub.name)}</b>${soon ? tag('renews soon', 'warn') : ''}
            ${sub.vendor ? `<br><span class="small faint">${esc(sub.vendor)}</span>` : ''}</td>
          <td class="small">${esc(sub.use || '—')}</td>
          <td class="n">${fmt(sub.monthly)}</td>
          <td class="small">${sub.payMode === 'upfront' ? 'Upfront' : 'Monthly'}</td>
          <td class="small nowrap">${esc(mlabel(sub.start))}${sub.end ? ' → ' + esc(mlabel(sub.end)) : ' → ongoing'}</td>
          <td class="small">${thisMonthCell(sub, month)}</td>
          <td class="n nowrap">
            ${sub.payMode === 'monthly'
          ? `<button class="btn ghost sm" type="button" onclick="fin.record('confirmcharge',{sub:'${esc(sub.id)}'})">Confirm charge</button>` : ''}
            <button class="btn ghost sm" type="button" onclick="fin.record('subchange',{sub:'${esc(sub.id)}'})">Change</button>
            <button class="btn ghost sm" type="button" onclick="fin.record('subcancel',{sub:'${esc(sub.id)}'})">Cancel</button>
          </td></tr>`;
    }).join(''),
    `<tr><td colspan="2">Total per month</td><td class="n">${fmt(rr.monthly)}</td><td colspan="4"></td></tr>`)
      : empty('No active services.')}

    ${past.length ? `
      <h2>No longer active</h2>
      ${table(
        `<th>Service</th><th class="n">Was per month</th><th>Status</th><th>Ended</th>`,
        past.map(sub => `<tr>
            <td>${esc(sub.name)}</td>
            <td class="n">${fmt(sub.monthly)}</td>
            <td class="small">${esc(sub.status)}</td>
            <td class="small">${sub.end ? esc(mlabel(sub.end)) : '—'}</td>
          </tr>`).join(''))}` : ''}`;
}

// ═══════ LOANS ═══════

export function renderLoans() {
  const s = getState();
  if (!s.loans.length) {
    return `<h1>Loans & EMIs</h1>
      ${note('Principal repays what you borrowed and is <b>not</b> a cost. Only the interest is. This page keeps the two apart for you.', 'info')}
      ${empty('<b>No loans.</b><br>Add one when you take a bank or NBFC loan, or when you convert a card purchase to EMI.',
      `<div class="actions" style="justify-content:center;margin-top:14px">
           <button class="btn primary" type="button" onclick="fin.record('bankloan')">Add a loan</button>
           <button class="btn" type="button" onclick="fin.record('card2emi')">Convert card to EMI</button>
         </div>`)}`;
  }

  const active = s.loans.filter(l => l.status === 'active');
  const closed = s.loans.filter(l => l.status !== 'active');

  return `
    <h1>Loans & EMIs</h1>
    <p class="lead">Principal reduces the loan; interest is the only part that is a cost.</p>
    <div class="actions">
      <button class="btn" type="button" onclick="fin.record('bankloan')">Add a loan</button>
      <button class="btn" type="button" onclick="fin.record('card2emi')">Convert card to EMI</button>
    </div>
    ${active.map(loanCard).join('')}
    ${closed.length ? `<h2>Fully repaid</h2>${closed.map(loanCard).join('')}` : ''}`;
}

function loanCard(l) {
  const paid = l.paid || [];
  const outstanding = bal('2400', { party: l.partyId });
  const totalInterest = l.schedule.reduce((a, x) => a + x.int, 0);
  const interestPaid = l.schedule.filter(x => paid.includes(x.n)).reduce((a, x) => a + x.int, 0);
  const next = l.schedule.find(x => !paid.includes(x.n));
  const progress = Math.round((paid.length / l.n) * 100);

  return `
    <div class="card">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0">${esc(l.lender)}</h3>
        <span class="small faint">${esc(l.purpose || '')}</span>
        <div class="spacer"></div>
        ${l.status === 'active' ? tag(`${paid.length} of ${l.n} paid`) : tag('closed', 'ok')}
      </div>

      <div class="grid g3" style="margin:12px 0">
        ${stat('Borrowed', fmt(l.principal))}
        ${stat('Still owed', fmt(outstanding))}
        ${stat('Interest paid', fmt(interestPaid), { sub: 'of ' + fmt(totalInterest) + ' total' })}
        ${stat('Rate', num(l.rate) + '% p.a.')}
      </div>

      <div class="bar" aria-label="${progress}% repaid"><i style="width:${progress}%"></i></div>

      ${next ? `
        <div style="margin-top:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <div class="small muted">Next EMI ${next.n} of ${l.n} · ${esc(mlabel(next.month))}</div>
            <div style="font-size:17px;font-weight:700">${fmt(next.emi)}</div>
            <div class="small faint">${fmt(next.prin)} principal + ${fmt(next.int)} interest</div>
          </div>
          <div class="spacer"></div>
          <button class="btn primary" type="button" onclick="fin.record('emi',{loan:'${esc(l.id)}'})">Pay this EMI</button>
        </div>` : '<p class="small pos" style="margin-top:12px">Fully repaid.</p>'}

      <details class="journal" style="margin-top:14px">
        <summary>Show the full schedule</summary>
        <div class="tbl-wrap"><table>
          <thead><tr><th>#</th><th>Month</th><th class="n">EMI</th><th class="n">Principal</th><th class="n">Interest</th><th class="n">Balance</th><th></th></tr></thead>
          <tbody>${l.schedule.map(x => `<tr>
            <td>${x.n}</td><td class="nowrap">${esc(mlabel(x.month))}</td>
            <td class="n">${fmt(x.emi)}</td><td class="n">${fmt(x.prin)}</td>
            <td class="n">${fmt(x.int)}</td><td class="n">${fmt(x.bal)}</td>
            <td>${paid.includes(x.n) ? '<span class="pos">✓</span>' : ''}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>
    </div>`;
}

// ═══════ ASSETS ═══════

export function renderAssets() {
  const s = getState();
  const inUse = s.assets.filter(a => a.status === 'in use');
  const gone = s.assets.filter(a => a.status !== 'in use');

  if (!s.assets.length) {
    return `<h1>Assets</h1>
      ${note(`Anything lasting over a year and costing more than ${fmt(s.settings.capitalisationThreshold)} is an asset, not an expense — its cost spreads over its life.`, 'info')}
      ${empty('<b>No assets yet.</b><br>Laptops, cameras, furniture — record them here so their cost spreads properly instead of wrecking one month\'s profit.',
      '<button class="btn primary" type="button" onclick="fin.record(\'asset\')">Buy an asset</button>')}`;
  }

  const written = a => (a.depreciated || []).length * num(a.monthly);
  const totals = inUse.reduce((t, a) => ({
    cost: t.cost + num(a.cost),
    monthly: t.monthly + num(a.monthly),
    written: t.written + written(a),
    left: t.left + (num(a.cost) - written(a)),
  }), { cost: 0, monthly: 0, written: 0, left: 0 });

  return `
    <h1>Assets</h1>
    <p class="lead">Depreciation is posted automatically at month-end — there is nothing to do here monthly.</p>
    <div class="actions">
      <button class="btn primary" type="button" onclick="fin.record('asset')">Buy an asset</button>
    </div>

    ${inUse.length ? table(
    `<th>Item</th><th>Bought</th><th class="n">Cost</th><th class="n">Per month</th><th class="n">Written down</th><th class="n">Value left</th><th></th>`,
    inUse.map(a => `<tr>
        <td><b>${esc(a.name)}</b><br><span class="small faint">${(a.depreciated || []).length} of ${a.life} months</span></td>
        <td class="nowrap small">${esc(a.date)}</td>
        <td class="n">${fmt(a.cost)}</td>
        <td class="n">${fmt(a.monthly)}</td>
        <td class="n">${fmt(written(a))}</td>
        <td class="n">${fmt(num(a.cost) - written(a))}</td>
        <td class="n"><button class="btn ghost sm" type="button" onclick="fin.record('assetdispose',{assetId:'${esc(a.id)}'})">Sell / scrap</button></td>
      </tr>`).join(''),
    `<tr><td colspan="2">Totals</td><td class="n">${fmt(totals.cost)}</td><td class="n">${fmt(totals.monthly)}</td>
       <td class="n">${fmt(totals.written)}</td><td class="n">${fmt(totals.left)}</td><td></td></tr>`)
      : empty('Nothing in use.')}

    ${gone.length ? `
      <h2>Sold or scrapped</h2>
      ${table(
        `<th>Item</th><th>Bought</th><th class="n">Cost</th><th>Disposed</th>`,
        gone.map(a => `<tr>
            <td class="muted">${esc(a.name)}</td>
            <td class="small">${esc(a.date)}</td>
            <td class="n">${fmt(a.cost)}</td>
            <td class="small">${esc(a.disposedOn || '—')}</td>
          </tr>`).join(''))}` : ''}`;
}
