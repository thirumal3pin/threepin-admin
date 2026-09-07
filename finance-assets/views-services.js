// ═══════ SERVICES, LOANS, ASSETS ═══════
//
// Three read-only views over the master records. Like Owed, none of them enter data: each
// button opens the Record screen pre-filled, so every journal entry in the system is still
// created in exactly one place.

import {
  fmt, esc, num, today, ym, addMonths, mlabel, getState, bal,
  prepaidLeft, serviceRunRate, pname,
  expectedFor, nextPlanChange, serviceMonths, missingServiceMonths, openBills, billOutstanding,
} from './finance-core.js';
import { stat, signed, empty, note, tag, table, daysBetween } from './ui.js';

// ═══════ SERVICES ═══════
//
// A service is a commitment (what you expect each month, with a dated history of plan
// changes), a stream of documents (each month's bill, paid or not) and the variance between
// the two, with a reason. The page shows all three, month by month.

// An upfront plan's term ends on the last day of its end month; that is the date the vendor
// will actually take the renewal, so it is what "renews soon" has to measure against.
function renewalDate(sub) {
  if (!sub.end) return null;
  const [y, m] = sub.end.split('-').map(Number);
  return new Date(y, m, 0).toISOString().slice(0, 10);
}

const REASONS = {
  prorate: 'Plan changed mid-month (prorated)', usage: 'Usage-based', price: 'Vendor changed the price',
  discount: 'Discount / credit', fx: 'Exchange rate moved', other: 'Other',
};

const recordBtn = (sub, month, label = 'Record') =>
  `<button class="btn ghost sm" type="button" onclick="fin.record('confirmcharge',{sub:'${esc(sub.id)}',month:'${esc(month)}'})">${label}</button>`;

function monthCell(m, sub) {
  switch (m.status) {
    case 'released': return '<span class="pos">released</span>';
    case 'pending': return '<span class="faint">auto at month-end</span>';
    case 'skipped': return '<span class="faint">not charged</span>';
    case 'billed': return `<span class="neg">${fmt(m.actual)} — unpaid</span>`;
    case 'recorded': return `<span class="pos">${fmt(m.actual)} paid</span>`;
    case 'due': return `<span class="faint">not yet</span> ${recordBtn(sub, m.month)}`;
    case 'upcoming': return `<span class="faint">upcoming</span> ${recordBtn(sub, m.month, 'Record early')}`;
    default: return `${tag('missing', 'warn')} ${recordBtn(sub, m.month)}`;
  }
}

// An expense variance reads the other way round from income: over what was expected is the
// bad direction.
function varianceCell(v) {
  if (Math.abs(v) <= 0.5) return '<span class="faint">—</span>';
  return `<span class="${v > 0 ? 'neg' : 'pos'}">${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}</span>`;
}

function planHistory(sub) {
  const hist = [...(sub.history || [])].sort((a, b) => a.from.localeCompare(b.from));
  if (hist.length < 2) return '';
  return `<p class="small muted" style="margin:10px 0 0"><b>Plan history:</b> ${hist.map(h =>
    `${esc(mlabel(h.from))} → ${fmt(h.amount)}/mo${h.plan ? ' (' + esc(h.plan) + ')' : ''}`).join(' · ')}</p>`;
}

function monthByMonth(sub) {
  const rows = serviceMonths(sub);
  if (!rows.length) return '';
  const unpaidBills = openBills(null, { serviceId: sub.id });
  return `
    <details class="journal" style="margin-top:0">
      <summary>${esc(sub.name)}${sub.plan ? ' (' + esc(sub.plan) + ')' : ''} — expected vs billed vs paid, month by month</summary>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Month</th><th class="n">Expected</th><th class="n">Billed</th><th class="n">Variance</th><th>Why</th><th>Status</th></tr></thead>
        <tbody>${rows.slice().reverse().map(m => `<tr>
          <td class="nowrap">${esc(mlabel(m.month))}</td>
          <td class="n">${fmt(m.expected)}</td>
          <td class="n">${m.rec && !m.rec.skipped ? fmt(m.actual) : '<span class="faint">—</span>'}</td>
          <td class="n">${m.rec && !m.rec.skipped ? varianceCell(m.variance) : '<span class="faint">—</span>'}</td>
          <td class="small">${esc(REASONS[m.rec?.reason] || '')}${m.rec?.note ? (REASONS[m.rec?.reason] ? ' — ' : '') + esc(m.rec.note) : ''}</td>
          <td class="small nowrap">${monthCell(m, sub)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${planHistory(sub)}
      ${unpaidBills.length ? `<p class="small neg" style="margin:10px 0 0">${unpaidBills.length} unpaid bill${unpaidBills.length === 1 ? '' : 's'} on this service — ${fmt(unpaidBills.reduce((a, b) => a + billOutstanding(b), 0))}. Pay from the Owed tab.</p>` : ''}
    </details>`;
}

export function renderServices() {
  const s = getState();
  const month = ym(today());
  const rr = serviceRunRate();
  const active = s.subs.filter(x => x.status === 'active');
  const paused = s.subs.filter(x => x.status === 'paused');
  const past = s.subs.filter(x => !['active', 'paused'].includes(x.status));

  if (!s.subs.length) {
    return `<h1>Services</h1>
      ${empty('<b>No services yet.</b><br>Add your subscriptions — CRM, ads, phone, software — and this page tells you what they really cost you every month, what you expected, and why the two differ.',
      '<button class="btn primary" type="button" onclick="fin.record(\'subnew\')">Add a service</button>')}`;
  }

  // The run-rate is what is EXPECTED this month, plan changes included — not the number
  // typed when the service was first added.
  const expectedNow = active.reduce((a, x) => a + (x.payMode === 'upfront' ? num(x.monthly) : expectedFor(x, month)), 0);
  const nextMonth = addMonths(month, 1);
  const expectedNext = active.reduce((a, x) => a + (x.payMode === 'upfront' ? (x.end && x.end < nextMonth ? 0 : num(x.monthly)) : expectedFor(x, nextMonth)), 0);
  const missing = missingServiceMonths(month).filter(m => m.status === 'missing');
  const dueNow = missingServiceMonths(month).filter(m => m.status === 'due');
  const svcBills = openBills(null).filter(b => b.serviceId);
  const unpaid = svcBills.reduce((a, b) => a + billOutstanding(b), 0);

  return `
    <h1>Services</h1>
    <p class="lead">What your tools cost each month — expected, actually billed, and paid — whether you pay monthly or once a year.</p>

    <div class="grid g3">
      ${stat('Expected this month', fmt(expectedNow), { sub: Math.abs(expectedNext - expectedNow) > 0.5 ? `${fmt(expectedNext)} from ${mlabel(nextMonth)}` : 'Same next month' })}
      ${stat('Annual commitment', fmt(rr.annual))}
      ${stat('Prepaid with vendors', fmt(rr.prepaidUnused), { sub: 'Paid for but not yet used' })}
      ${stat('Unpaid service bills', fmt(unpaid), { cls: unpaid > 0.5 ? 'neg' : '', sub: svcBills.length ? `${svcBills.length} bill${svcBills.length === 1 ? '' : 's'} on Owed` : 'Nothing outstanding' })}
    </div>

    ${missing.length ? note(`<b>${missing.length} month${missing.length === 1 ? '' : 's'} not recorded.</b> Until each is recorded (or marked not charged) the books are missing that cost: ${missing.map(m => `${esc(m.sub.name)} — ${esc(mlabel(m.month))} ${recordBtn(m.sub, m.month)}`).join(' · ')}`, 'warn') : ''}
    ${dueNow.length && !missing.length ? note(`${dueNow.length} service${dueNow.length === 1 ? '' : 's'} still to record for ${esc(mlabel(month))}.`, 'info') : ''}

    <div class="actions">
      <button class="btn primary" type="button" onclick="fin.record('subnew')">Add a service</button>
    </div>

    ${active.length ? table(
    `<th>Service</th><th>What for</th><th class="n">Expected / mo</th><th>Billing</th><th>Period</th><th>${esc(mlabel(month))}</th><th></th>`,
    active.map(sub => {
      const rd = renewalDate(sub);
      const soon = rd && daysBetween(today(), rd) >= 0 && daysBetween(today(), rd) <= 7;
      const next = sub.payMode === 'upfront' ? null : nextPlanChange(sub, month);
      const thisM = serviceMonths(sub).find(m => m.month === month) || { status: sub.payMode === 'upfront' ? 'pending' : 'due', month };
      const billing = sub.payMode === 'upfront' ? 'Upfront' : sub.billing === 'invoice' ? 'Invoiced monthly' : 'Auto-charged';
      return `<tr>
          <td><b>${esc(sub.name)}</b>${sub.plan ? ` <span class="small muted">${esc(sub.plan)}</span>` : ''}${soon ? tag('renews soon', 'warn') : ''}
            ${sub.vendor ? `<br><span class="small faint">${esc(sub.vendor)}</span>` : ''}</td>
          <td class="small">${esc(sub.use || '—')}</td>
          <td class="n">${fmt(sub.payMode === 'upfront' ? sub.monthly : expectedFor(sub, month))}
            ${next ? `<br><span class="small muted nowrap">→ ${fmt(next.amount)} from ${esc(mlabel(next.from))}</span>` : ''}</td>
          <td class="small">${billing}</td>
          <td class="small nowrap">${esc(mlabel(sub.start))}${sub.end ? ' → ' + esc(mlabel(sub.end)) : ' → ongoing'}</td>
          <td class="small nowrap">${monthCell(thisM, sub)}</td>
          <td class="n nowrap">
            ${sub.payMode === 'monthly' ? recordBtn(sub, month, 'Record a month') : ''}
            <button class="btn ghost sm" type="button" onclick="fin.record('subchange',{sub:'${esc(sub.id)}'})">Change plan</button>
            <button class="btn ghost sm" type="button" onclick="fin.record('subcancel',{sub:'${esc(sub.id)}'})">Cancel</button>
          </td></tr>`;
    }).join(''),
    `<tr><td colspan="2">Expected this month</td><td class="n">${fmt(expectedNow)}</td><td colspan="4"></td></tr>`)
      : empty('No active services.')}

    ${active.some(x => x.payMode === 'monthly') ? `
      <h2>Month by month</h2>
      <p class="small muted">Every month a service has run: what you expected, what the vendor billed, whether it is paid, and why it differs. A missing month is a cost the books do not yet know about.</p>
      ${active.filter(x => x.payMode === 'monthly').map(monthByMonth).join('')}` : ''}

    ${paused.length ? `
      <h2>Paused</h2>
      ${table(
        `<th>Service</th><th class="n">Was per month</th><th>Since</th><th></th>`,
        paused.map(sub => `<tr>
            <td>${esc(sub.name)}</td>
            <td class="n">${fmt(expectedFor(sub, month))}</td>
            <td class="small">${sub.end ? esc(mlabel(sub.end)) : '—'}</td>
            <td class="n"><button class="btn ghost sm" type="button" onclick="fin.record('subcancel',{sub:'${esc(sub.id)}',action:'resume'})">Resume</button></td>
          </tr>`).join(''))}` : ''}

    ${past.length ? `
      <h2>No longer active</h2>
      ${table(
        `<th>Service</th><th class="n">Was per month</th><th>Status</th><th>Ended</th>`,
        past.map(sub => `<tr>
            <td>${esc(sub.name)}${sub.plan ? ` <span class="small muted">${esc(sub.plan)}</span>` : ''}</td>
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
