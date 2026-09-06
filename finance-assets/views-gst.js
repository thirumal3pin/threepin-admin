// ═══════ GST ═══════
//
// One month at a time, the way the return is filed: what was charged (output), what can be
// claimed (input credit, with what each claim rests on), the set-off in the order Rule 88A
// allows, and the cash that is actually due per head. The two registers export in the shape
// the CA keys into GSTR-1 and matches against GSTR-2B.

import {
  fmt, esc, num, ym, addMonths, mlabel, today, getState,
  gstComputation, gstr1Rows, itcRegister,
} from './finance-core.js';
import { stat, empty, note, tag, table, downloadCsv, monthOptions } from './ui.js';

let month = addMonths(ym(today()), -1);

const H = ['cgst', 'sgst', 'igst'];
const up = h => h.toUpperCase();
const sum = o => H.reduce((a, h) => a + num(o[h]), 0);

export function renderGst() {
  const s = getState();
  const months = monthOptions(s.txns, [month, ym(today())]);
  const g = gstComputation(month);
  const outward = gstr1Rows(month);
  const inward = itcRegister(month);
  const eligible = inward.filter(r => r.eligible).reduce((a, r) => a + r.tax, 0);
  const atRisk = inward.filter(r => !r.eligible && !r.blocked && !r.rcm);
  const used = g.setoff.util.reduce((a, u) => a + u.amt, 0);

  return `
    <h1>GST</h1>
    <p class="lead">The month's return, worked out from the entries. Output tax is what you charged;
    input credit is what your vendors charged you and what you can claim back. The difference,
    after set-off in the order the rules allow, is the cash due by the 20th.</p>

    <div class="actions">
      <select onchange="finGst.setMonth(this.value)" aria-label="Month" style="max-width:200px">
        ${months.map(m => `<option value="${m}" ${m === month ? 'selected' : ''}>${esc(mlabel(m))}</option>`).join('')}
      </select>
      <button class="btn primary" type="button" onclick="fin.record('statutory',{kind:'gst',month:'${esc(month)}'})">Pay GST for ${esc(mlabel(month))}</button>
    </div>

    <div class="grid g3">
      ${stat('Output tax this month', fmt(sum(g.output)), { sub: 'Charged on invoices and forfeits' })}
      ${stat('Credit availed this month', fmt(sum(g.availed)), { sub: g.blocked ? `+ ${fmt(g.blocked)} blocked, kept in cost` : 'Claimable on purchases' })}
      ${stat('Cash due after set-off', fmt(g.cash), { hero: true, sub: g.rcmDue ? `includes ${fmt(g.rcmDue)} reverse charge` : 'Liability less credit' })}
      ${stat('Credit carried forward', fmt(sum(g.setoff.carry)), { sub: 'Unused credit for next month' })}
    </div>

    ${atRisk.length ? note(`<b>${atRisk.length} claim${atRisk.length === 1 ? ' is' : 's are'} at risk</b> — ${fmt(atRisk.reduce((a, r) => a + r.tax, 0))} of credit was entered without the vendor's GSTIN or invoice number. GSTR-2B will not match it. Reverse and re-record those entries with the invoice details.`) : ''}

    <h2>GSTR-3B summary — ${esc(mlabel(month))}</h2>
    ${table(
      `<th>Head</th><th class="n">Liability outstanding</th><th class="n">Credit available</th><th class="n">Set off</th><th class="n">Pay in cash</th><th class="n">Credit carried</th>`,
      H.map(h => {
        const setOff = g.setoff.util.filter(u => u.to === h).reduce((a, u) => a + u.amt, 0);
        return `<tr>
          <td><b>${up(h)}</b></td>
          <td class="n">${fmt(g.liability[h])}</td>
          <td class="n">${fmt(g.credit[h])}</td>
          <td class="n">${setOff ? fmt(setOff) : '—'}</td>
          <td class="n"><b>${fmt(g.setoff.payable[h])}</b></td>
          <td class="n">${g.setoff.carry[h] ? fmt(g.setoff.carry[h]) : '—'}</td>
        </tr>`;
      }).join('') + (g.rcmDue ? `<tr>
          <td><b>Reverse charge</b><br><span class="small faint">cash only</span></td>
          <td class="n">${fmt(g.rcmDue)}</td><td class="n">—</td><td class="n">—</td>
          <td class="n"><b>${fmt(g.rcmDue)}</b></td><td class="n">—</td></tr>` : ''),
      `<tr><td>Total</td><td class="n">${fmt(sum(g.liability) + g.rcmDue)}</td><td class="n">${fmt(sum(g.credit))}</td>
         <td class="n">${fmt(used)}</td><td class="n">${fmt(g.cash)}</td><td class="n">${fmt(sum(g.setoff.carry))}</td></tr>`)}
    ${g.setoff.util.length ? `<p class="small muted">Set-off order (Rule 88A): ${g.setoff.util.map(u => `${fmt(u.amt)} ${up(u.from)} credit → ${up(u.to)}`).join(' · ')}.</p>` : ''}
    <div class="actions"><button class="btn sm" type="button" onclick="finGst.csv3b()">Download 3B summary CSV</button></div>

    <h2>Input credit register <span class="muted">(${inward.length})</span></h2>
    <p class="small muted">Every purchase carrying GST. A claim needs the vendor's GSTIN and invoice number — that is what the government matches against.</p>
    ${inward.length ? table(
      `<th>#</th><th>Date</th><th>Vendor · what</th><th>GSTIN · invoice</th><th class="n">Taxable</th><th class="n">CGST</th><th class="n">SGST</th><th class="n">IGST</th><th>Claim</th>`,
      inward.map(r => `<tr>
        <td class="eno">#${String(r.no || 0).padStart(4, '0')}</td>
        <td class="nowrap small">${esc(r.date)}</td>
        <td>${esc(r.vendor || '—')}<br><span class="small faint">${esc(r.desc)}</span></td>
        <td class="small">${r.gstin ? esc(r.gstin) : '<span class="neg">no GSTIN</span>'}<br>${r.invoice ? esc(r.invoice) : '<span class="neg">no invoice no.</span>'}</td>
        <td class="n">${fmt(r.taxable)}</td>
        <td class="n">${r.cgst ? fmt(r.cgst) : ''}</td><td class="n">${r.sgst ? fmt(r.sgst) : ''}</td><td class="n">${r.igst ? fmt(r.igst) : ''}</td>
        <td>${r.eligible ? tag(r.rcm ? 'reverse charge' : 'eligible', 'ok') : r.blocked ? tag('blocked') : tag('at risk', 'warn')}
          ${r.reason ? `<br><span class="small faint">${esc(r.reason)}</span>` : ''}</td>
      </tr>`).join(''),
      `<tr><td colspan="4">Eligible credit</td><td></td><td colspan="3" class="n">${fmt(eligible)}</td><td></td></tr>`)
      : empty('No purchases with GST this month.')}
    <div class="actions"><button class="btn sm" type="button" onclick="finGst.csvItc()">Download ITC register CSV</button></div>

    <h2>Outward register — GSTR-1 <span class="muted">(${outward.length})</span></h2>
    ${outward.length ? table(
      `<th>Type</th><th>Number</th><th>Date</th><th>Recipient</th><th>Place of supply</th><th class="n">Taxable</th><th class="n">CGST</th><th class="n">SGST</th><th class="n">IGST</th><th class="n">Total</th>`,
      outward.map(r => `<tr>
        <td>${tag(r.type, r.type === 'Credit note' ? 'rev' : r.type === 'B2B' ? 'ok' : '')}</td>
        <td class="nowrap"><b>${esc(r.no)}</b>${r.against ? `<br><span class="small faint">against ${esc(r.against)}</span>` : ''}</td>
        <td class="nowrap small">${esc(r.date)}</td>
        <td>${esc(r.party)}${r.gstin ? `<br><span class="small faint">${esc(r.gstin)}</span>` : ''}</td>
        <td class="small">${esc(r.placeOfSupply)}<br><span class="faint">SAC ${esc(r.sac || '')}</span></td>
        <td class="n">${fmt(r.taxable)}</td>
        <td class="n">${r.cgst ? fmt(r.cgst) : ''}</td><td class="n">${r.sgst ? fmt(r.sgst) : ''}</td><td class="n">${r.igst ? fmt(r.igst) : ''}</td>
        <td class="n">${fmt(r.total)}</td>
      </tr>`).join(''),
      `<tr><td colspan="5">Total</td><td class="n">${fmt(outward.reduce((a, r) => a + r.taxable, 0))}</td>
         <td class="n">${fmt(outward.reduce((a, r) => a + r.cgst, 0))}</td><td class="n">${fmt(outward.reduce((a, r) => a + r.sgst, 0))}</td>
         <td class="n">${fmt(outward.reduce((a, r) => a + r.igst, 0))}</td><td class="n">${fmt(outward.reduce((a, r) => a + r.total, 0))}</td></tr>`)
      : empty('No invoices or credit notes this month.')}
    <div class="actions"><button class="btn sm" type="button" onclick="finGst.csvGstr1()">Download GSTR-1 CSV</button></div>

    ${note('<b>Dates:</b> GSTR-1 by the 11th, GSTR-3B and payment by the 20th of the following month. A B2B invoice is one where the recipient has a GSTIN — add it to the client on the Settings tab so it files under the right table.', 'info')}`;
}

if (typeof window !== 'undefined') {
  window.finGst = {
    setMonth(m) { month = m; window.fin.repaint(); },
    csv3b() {
      const g = gstComputation(month);
      downloadCsv(`3pin-gstr3b-${month}.csv`, [
        ['Head', 'Output this month', 'Credit availed this month', 'Liability outstanding', 'Credit available', 'Set off', 'Cash payable', 'Credit carried'],
        ...H.map(h => [up(h), g.output[h], g.availed[h], g.liability[h], g.credit[h],
          g.setoff.util.filter(u => u.to === h).reduce((a, u) => a + u.amt, 0), g.setoff.payable[h], g.setoff.carry[h]]),
        ['Reverse charge', g.rcmMonth, '', g.rcmDue, '', '', g.rcmDue, ''],
        ['Blocked credit (in cost)', '', g.blocked, '', '', '', '', ''],
      ]);
    },
    csvItc() {
      downloadCsv(`3pin-itc-register-${month}.csv`, [
        ['Entry', 'Date', 'Vendor', 'Description', 'Vendor GSTIN', 'Vendor invoice no', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total tax', 'Eligible', 'Reason'],
        ...itcRegister(month).map(r => [r.no, r.date, r.vendor, r.desc, r.gstin, r.invoice, r.taxable, r.cgst, r.sgst, r.igst, r.tax, r.eligible ? 'Yes' : 'No', r.reason]),
      ]);
    },
    csvGstr1() {
      downloadCsv(`3pin-gstr1-${month}.csv`, [
        ['Type', 'Invoice no', 'Date', 'Recipient', 'Recipient GSTIN', 'Place of supply', 'SAC', 'Taxable value', 'Rate', 'CGST', 'SGST', 'IGST', 'Invoice value', 'Against'],
        ...gstr1Rows(month).map(r => [r.type, r.no, r.date, r.party, r.gstin, r.placeOfSupply, r.sac, r.taxable, r.rate, r.cgst, r.sgst, r.igst, r.total, r.against]),
      ]);
    },
  };
}
