// ═══════ OWED BOTH WAYS ═══════
//
// The two lists worth acting on every week: money to chase and bills to pay. Nothing is
// entered here — every button opens the Record screen with the party and deal already filled
// in, so there is exactly one place in the app where money is recorded.

import {
  fmt, esc, num, today, getState, bal, partyBalances, pname, deal,
} from './finance-core.js';
import { empty, note, tag, table, daysAgo } from './ui.js';

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

  if (!receivable.length && !payable.length && !tokens.length) {
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

  return `
    <h2>Clients owe you</h2>
    <p class="small muted">Oldest first — that is the order worth chasing in.</p>
    ${table(
    `<th>Client</th><th class="n">Owes</th><th class="n">Waiting</th><th></th>`,
    aged.map(r => {
      const days = r.since ? daysAgo(r.since) : null;
      const ctx = dealSideFor(r.id, '1100');
      const preset = ctx ? JSON.stringify(ctx).replace(/"/g, '&quot;') : '{}';
      return `<tr>
          <td>${esc(pname(r.id))}
            ${days > 30 ? tag('overdue', 'warn') : ''}
            ${ctx ? `<br><span class="small faint">${esc(deal(ctx.deal)?.nickname || '')}</span>` : ''}</td>
          <td class="n">${fmt(r.amt)}</td>
          <td class="n">${days === null ? '—' : days + ' day' + (days === 1 ? '' : 's')}</td>
          <td class="n nowrap">
            <button class="btn ghost sm" type="button" onclick="fin.record('dealpay',${preset})">Record payment</button>
            <button class="btn ghost sm" type="button" onclick="fin.record('writeoff',${preset})">Write off</button>
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
  return `
    <h2>You owe vendors</h2>
    ${table(
    `<th>Vendor</th><th class="n">You owe</th><th></th>`,
    rows.map(([id, amt]) => `<tr>
        <td>${esc(pname(id))}</td>
        <td class="n">${fmt(amt)}</td>
        <td class="n"><button class="btn ghost sm" type="button" onclick="fin.record('paybill',{party:'${esc(id)}'})">Pay</button></td>
      </tr>`).join(''),
    totalRow('Total to pay', total, 1))}`;
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
            <button class="btn ghost sm" type="button" onclick="fin.record('settle',${preset})">Refund</button>
            <button class="btn ghost sm" type="button" onclick="fin.record('settle',${preset})">Forfeit</button>
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
