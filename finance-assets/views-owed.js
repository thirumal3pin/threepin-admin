// ═══════ OWED BOTH WAYS ═══════
//
// The two lists worth acting on every week: money to chase and bills to pay. Nothing is
// entered here — every button opens the Record screen with the party already filled in, so
// there is exactly one place in the app where money is recorded.
//
// Both lists are built from DOCUMENTS — invoices you raised and bills you received — each
// with its due date and what is still open on it. The party totals are still proved against
// the ledger (1100 / 2000), and any difference between the two is shown rather than hidden:
// it is money owed that has no document behind it, which is worth knowing.

import {
  fmt, esc, num, today, getState, bal, partyBalances, pname, deal, agedReceivables,
  openInvoices, openBills, invoiceOutstanding, billOutstanding, vendorAdvance, mlabel, agedPayables,
} from './finance-core.js';
import { stat, empty, note, tag, table, daysAgo, daysBetween, dueCell } from './ui.js';

// Which deal and which side of it a party sits on, so a button can pre-fill the Record form.
// A client can appear on several deals; the one with an outstanding balance is the one meant.
function dealSideFor(partyId, code) {
  for (const d of getState().deals) {
    if (Math.abs(bal(code, { party: partyId, deal: d.id })) <= 0.5) continue;
    const side = d.seller?.partyId === partyId ? 'seller'
      : d.buyer?.partyId === partyId ? 'buyer'
        : (d.others || []).findIndex(o => o.partyId === partyId) >= 0
          ? 'other:' + (d.others || []).findIndex(o => o.partyId === partyId)
          : null;
    if (side) return { deal: d.id, from: side };
  }
  return null;
}

// The oldest still-unpaid entry for this party on an account, used for the ageing column.
function oldestOpen(partyId, code) {
  const dates = getState().txns
    .filter(t => t.lines.some(l => l.acc === code && l.party === partyId && num(l.dr) > 0))
    .map(t => t.date)
    .sort();
  return dates[0] || null;
}

const sortedBalances = code => Object.entries(partyBalances(code))
  .filter(([, v]) => v > 0.5)
  .sort((a, b) => b[1] - a[1]);

const totalRow = (label, amount, span = 1) =>
  `<tr><td colspan="${span}">${esc(label)}</td><td class="n">${fmt(amount)}</td><td></td></tr>`;

export function renderOwed() {
  const s = getState();
  const receivable = sortedBalances('1100');
  const payable = sortedBalances('2000');
  const tokens = sortedBalances('2100');
  const tds = sortedBalances('1150');
  const advances = sortedBalances('1550');

  if (!receivable.length && !payable.length && !tokens.length && !advances.length) {
    return `<h1>Owed both ways</h1>
      ${empty('<b>Nothing outstanding.</b><br>Nobody owes you and you owe nobody — everything recorded so far has settled.',
      '<button class="btn" type="button" onclick="fin.go(\'record\')">Record something</button>')}`;
  }

  return `
    <h1>Owed both ways</h1>
    <p class="lead">Worked out from your entries. Go down the first list once a week and chase;
    go down the second and pay. Everything here opens the Record screen already filled in.</p>

    ${sectionReceivable(receivable)}
    ${sectionPayable(payable)}
    ${sectionAdvances(advances)}
    ${sectionTokens(tokens)}
    ${s.settings.tdsEnabled ? sectionTds(tds) : ''}`;
}

// ═══════ CLIENTS OWE YOU ═══════

function sectionReceivable(rows) {
  const total = rows.reduce((a, [, v]) => a + v, 0);
  if (!rows.length) {
    return `<h2>Clients owe you</h2>
      ${empty('Nothing to collect. Every invoice raised has been paid.')}`;
  }

  // Oldest first: the longer something sits, the less likely it is ever collected.
  const aged = rows
    .map(([id, amt]) => ({ id, amt, since: oldestOpen(id, '1100') }))
    .sort((a, b) => (a.since || '9999').localeCompare(b.since || '9999'));

  const buckets = agedReceivables(today());
  return `
    <h2>Clients owe you</h2>
    <div class="grid g3">
      ${stat('0–30 days', fmt(buckets['0-30']))}
      ${stat('31–60 days', fmt(buckets['31-60']), { cls: buckets['31-60'] > 0.5 ? 'neg' : '' })}
      ${stat('61–90 days', fmt(buckets['61-90']), { cls: buckets['61-90'] > 0.5 ? 'neg' : '' })}
      ${stat('Over 90 days', fmt(buckets['90+']), { cls: buckets['90+'] > 0.5 ? 'neg' : '', sub: buckets['90+'] > 0.5 ? 'Chase, or write it off' : '' })}
    </div>
    ${buckets['no document'] > 0.5 ? `<p class="small faint">${fmt(buckets['no document'])} of this has no invoice behind it — recovered costs, or balances from before invoices were tracked — so it is not aged.</p>` : ''}
    <p class="small muted">Oldest first — that is the order worth chasing in. Each client's open invoices are listed under them.</p>
    ${table(
    `<th>Client</th><th class="n">Owes</th><th class="n">Waiting</th><th></th>`,
    aged.map(r => {
      const days = r.since ? daysAgo(r.since) : null;
      const ctx = dealSideFor(r.id, '1100');
      const preset = ctx ? JSON.stringify(ctx).replace(/"/g, '&quot;') : '{}';
      const invs = openInvoices(r.id);
      const docTotal = invs.reduce((a, i) => a + invoiceOutstanding(i), 0);
      const undocumented = r.amt - docTotal;
      return `<tr>
          <td>${esc(pname(r.id))}
            ${days > 30 ? tag('overdue', 'warn') : ''}
            ${ctx ? `<br><span class="small faint">${esc(deal(ctx.deal)?.nickname || '')}</span>` : ''}
            ${invs.length ? `<div class="doclist">${invs.map(i => `
              <div class="docrow"><span class="eno">${esc(i.invoiceNo)}</span> <span class="small">${esc(i.date)}</span>
                <span class="n">${fmt(invoiceOutstanding(i))}${i.status === 'part' ? ` <span class="small faint">of ${fmt(i.total)}</span>` : ''}</span>
                <span>${dueCell(i.dueDate)}</span></div>`).join('')}</div>` : ''}
            ${undocumented > 0.5 ? `<div class="small faint" style="margin-top:4px">${fmt(undocumented)} recoverable costs / no invoice</div>` : ''}</td>
          <td class="n">${fmt(r.amt)}</td>
          <td class="n">${days === null ? '—' : days + ' day' + (days === 1 ? '' : 's')}</td>
          <td class="n nowrap">
            <button class="btn ghost sm in" type="button" onclick="fin.record('dealpay',{party:'${esc(r.id)}'})">Record payment</button>
            ${ctx ? `<button class="btn ghost sm" type="button" onclick="fin.record('writeoff',${preset})">Write off</button>` : ''}
          </td></tr>`;
    }).join(''),
    totalRow('Total to collect', total, 1))}`;
}

// ═══════ YOU OWE VENDORS ═══════

function sectionPayable(rows) {
  const total = rows.reduce((a, [, v]) => a + v, 0);
  if (!rows.length) {
    return `<h2>You owe vendors</h2>${empty('No unpaid bills.')}`;
  }
  const allOpen = openBills(null);
  const overdue = allOpen.filter(b => b.dueDate && b.dueDate < today());
  const soon = allOpen.filter(b => b.dueDate && b.dueDate >= today() && daysBetween(today(), b.dueDate) <= 7);
  const aged = agedPayables(today());
  return `
    <h2>You owe vendors</h2>
    <div class="grid g3">
      ${stat('Open bills', String(allOpen.length))}
      ${stat('Overdue', fmt(overdue.reduce((a, b) => a + billOutstanding(b), 0)), { cls: overdue.length ? 'neg' : '', sub: overdue.length ? `${overdue.length} bill${overdue.length === 1 ? '' : 's'}` : 'None' })}
      ${stat('Due within 7 days', fmt(soon.reduce((a, b) => a + billOutstanding(b), 0)), { sub: soon.length ? `${soon.length} bill${soon.length === 1 ? '' : 's'}` : 'None' })}
    </div>
    <p class="small muted">How long you have been holding on to what you owe:</p>
    <div class="grid g3">
      ${stat('0–30 days', fmt(aged['0-30']))}
      ${stat('31–60 days', fmt(aged['31-60']), { cls: aged['31-60'] > 0.5 ? 'neg' : '' })}
      ${stat('61–90 days', fmt(aged['61-90']), { cls: aged['61-90'] > 0.5 ? 'neg' : '' })}
      ${stat('Over 90 days', fmt(aged['90+']), { cls: aged['90+'] > 0.5 ? 'neg' : '', sub: aged['90+'] > 0.5 ? 'GST credit is at risk after 180 days' : '' })}
    </div>
    ${table(
    `<th>Vendor</th><th class="n">You owe</th><th></th>`,
    rows.map(([id, amt]) => {
      const bills = openBills(id);
      const docTotal = bills.reduce((a, b) => a + billOutstanding(b), 0);
      const undocumented = amt - docTotal;
      const adv = vendorAdvance(id);
      return `<tr>
        <td>${esc(pname(id))}
          ${bills.length ? `<div class="doclist">${bills.map(b => `
            <div class="docrow"><span class="small">${esc(b.desc)}</span> <span class="small faint">${esc(b.date)}${b.billNo ? ' · ' + esc(b.billNo) : ''}</span>
              <span class="n">${fmt(billOutstanding(b))}${b.status === 'part' ? ` <span class="small faint">of ${fmt(b.net ?? b.total)}</span>` : ''}</span>
              <span>${dueCell(b.dueDate)}
                ${b.txnId ? `<button class="btn ghost sm" type="button" onclick="fin.openTxn('${esc(b.txnId)}')">Entry</button>` : ''}
                ${b.serviceId ? `<button class="btn ghost sm" type="button" onclick="fin.go('services')">Service</button>` : ''}
              </span></div>`).join('')}</div>` : ''}
          ${undocumented > 0.5 ? `<div class="small faint" style="margin-top:4px">${fmt(undocumented)} owed from entries before bills were tracked</div>` : ''}
          ${adv > 0.5 ? `<div class="small pos" style="margin-top:4px">${fmt(adv)} advance already with them — used first when you pay</div>` : ''}</td>
        <td class="n">${fmt(amt)}</td>
        <td class="n"><button class="btn ghost sm out" type="button" onclick="fin.record('paybill',{party:'${esc(id)}'})">Pay</button></td>
      </tr>`;
    }).join(''),
    totalRow('Total to pay', total, 1))}`;
}

// ═══════ ADVANCES WITH VENDORS ═══════

function sectionAdvances(rows) {
  if (!rows.length) return '';
  const total = rows.reduce((a, [, v]) => a + v, 0);
  return `
    <h2>Advances with vendors</h2>
    ${note('You paid these vendors more than their bills, or paid ahead. The money is yours until a bill uses it up — the next time you pay them, it is applied first.', 'info')}
    ${table(
    `<th>Vendor</th><th class="n">Advance</th><th></th>`,
    rows.map(([id, amt]) => `<tr><td>${esc(pname(id))}</td><td class="n">${fmt(amt)}</td><td></td></tr>`).join(''),
    totalRow('Total advanced', total, 1))}`;
}

// ═══════ CLIENT TOKENS HELD ═══════

function sectionTokens(rows) {
  const total = rows.reduce((a, [, v]) => a + v, 0);
  if (!rows.length) return '';
  return `
    <h2>Client tokens held</h2>
    ${note('This money is <b>not yours yet</b>. It becomes income only when the deal registers, or when the client agrees you may keep it.', 'info')}
    ${table(
    `<th>Client</th><th class="n">Held</th><th></th>`,
    rows.map(([id, amt]) => {
      const ctx = dealSideFor(id, '2100');
      const preset = ctx ? JSON.stringify(ctx).replace(/"/g, '&quot;') : '{}';
      return `<tr>
          <td>${esc(pname(id))}
            ${ctx ? `<br><span class="small faint">${esc(deal(ctx.deal)?.nickname || '')}</span>` : ''}</td>
          <td class="n">${fmt(amt)}</td>
          <td class="n nowrap">
            <button class="btn ghost sm" type="button" onclick="fin.record('invoice',${preset})">Adjust on deal</button>
            <button class="btn ghost sm" type="button" onclick="fin.record('settle',${preset})">Refund / keep</button>
          </td></tr>`;
    }).join(''),
    totalRow('Total held', total, 1))}`;
}

// ═══════ TDS DEDUCTED BY CLIENTS ═══════

function sectionTds(rows) {
  const total = rows.reduce((a, [, v]) => a + v, 0);
  if (!rows.length) return '';
  return `
    <h2>TDS deducted by clients</h2>
    ${note('Clients withheld this and paid it to the government against your PAN. Claim it when the return is filed — it is money you have already earned.', 'info')}
    ${table(
    `<th>Client</th><th class="n">Withheld</th><th></th>`,
    rows.map(([id, amt]) =>
      `<tr><td>${esc(pname(id))}</td><td class="n">${fmt(amt)}</td><td></td></tr>`).join(''),
    totalRow('Total claimable', total, 1))}`;
}
