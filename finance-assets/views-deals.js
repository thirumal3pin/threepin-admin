// ═══════ DEALS ═══════
//
// The pipeline and what each deal actually made. A brokerage lives and dies by this table:
// expected against invoiced, what has been collected, what is still held for the client, and
// what the deal cost to close. Everything is derived from the lines tagged with the deal.

import {
  sideInvoiced,
  A, fmt, esc, num, today, getState, bal, pl, pname, dealFigures,
} from './finance-core.js';
import { stat, signed, empty, note, tag, table, modal } from './ui.js';
import { renderInvoices, mountInvoices } from './views-invoices.js';
import * as SY from './finance-sync.js';

// open / registered / cancelled are stored. Settled is DERIVED — registered, invoiced, nothing
// owed and nothing held — so it can never go stale. Invoicing a side no longer changes status.
const STATUS = { open: ['Open', ''], registered: ['Registered', 'ok'], settled: ['Settled', 'ok'], cancelled: ['Cancelled', 'rev'] };
const shownStatus = (d, f) => f.settled ? 'settled' : d.status;

// Cash that moved in transactions carrying this deal: tokens, payments, refunds, costs.
function cashOnDeal(d) {
  let s = 0;
  for (const t of getState().txns) {
    if (!t.lines.some(l => l.deal === d.id)) continue;
    for (const l of t.lines) if (['1000', '1010'].includes(l.acc)) s += num(l.dr) - num(l.cr);
  }
  return s;
}

// One side of a deal: what was expected, what has been invoiced, what is still open.
function sideOf(d, side) {
  const s = getState();
  const pid = d[side]?.partyId;
  const invs = pid ? s.invoices.filter(i => i.dealId === d.id && i.partyId === pid && i.kind !== 'creditnote' && i.status !== 'void') : [];
  const invoiced = invs.reduce((a, i) => a + num(i.base), 0);
  const open = pid ? Math.max(0, bal('1100', { party: pid, deal: d.id })) : 0;
  const expected = num(side === 'seller' ? d.expSeller : d.expBuyer);
  return { pid, expected, invoiced, open, billed: invs.length > 0, count: invs.length };
}

function figures(d) {
  const f = dealFigures(d);
  const seller = sideOf(d, 'seller'), buyer = sideOf(d, 'buyer');
  const anyInvoice = seller.billed || buyer.billed;
  return {
    ...f,
    seller, buyer,
    expected: seller.expected + buyer.expected,
    // What is still to come: each side's estimate less what has been invoiced on it.
    pipeline: Math.max(0, seller.expected - seller.invoiced) + Math.max(0, buyer.expected - buyer.invoiced),
    received: cashOnDeal(d),
    // Settled: registered, every side that exists has been invoiced, nothing owed, nothing held.
    settled: d.status === 'registered' && anyInvoice
      && [seller, buyer].every(x => !x.pid || x.billed || x.expected < 0.5)
      && num(f.recv) < 0.5 && num(f.tokens) < 0.5,
  };
}

let dealsTab = 'pipeline';

export function renderDeals() {
  const tabs = `<div class="seg" role="tablist" style="margin-bottom:14px">
    <button type="button" role="tab" class="${dealsTab === 'pipeline' ? 'on' : ''}" aria-selected="${dealsTab === 'pipeline'}" onclick="finDeals.tab('pipeline')">Deals</button>
    <button type="button" role="tab" class="${dealsTab === 'invoices' ? 'on' : ''}" aria-selected="${dealsTab === 'invoices'}" onclick="finDeals.tab('invoices')">Invoices</button>
  </div>`;
  if (dealsTab === 'invoices') return tabs + renderInvoices();
  return tabs + renderPipeline();
}

function renderPipeline() {
  const s = getState();
  if (!s.deals.length) {
    return `<h1>Deals</h1>
      ${note('A deal is where income and costs are mapped. Add one as soon as a client is serious — the expected brokerage is an estimate for your pipeline and nothing counts as income until the deal closes.', 'info')}
      ${empty('<b>No deals yet.</b>', '<button class="btn primary" type="button" onclick="fin.record(\'newdeal\')">Add a deal</button>')}`;
  }

  const rows = [...s.deals].map(d => ({ d, f: figures(d) }))
    .sort((a, b) => (a.d.status === 'cancelled') - (b.d.status === 'cancelled') || String(b.d.opened || '').localeCompare(String(a.d.opened || '')));
  const open = rows.filter(r => r.d.status === 'open');
  // Everything not yet invoiced on a live deal — including the seller of a deal that has
  // registered but has only had its buyer billed so far.
  const pipeline = rows.filter(r => r.d.status !== 'cancelled').reduce((a, r) => a + r.f.pipeline, 0);
  const invoiced = rows.reduce((a, r) => a + r.f.income, 0);
  const net = rows.reduce((a, r) => a + r.f.net, 0);
  const tokens = rows.reduce((a, r) => a + r.f.tokens, 0);

  return `
    <h1>Deals</h1>
    <p class="lead">Expected is your estimate. Invoiced is real income. The gap between them is the pipeline.</p>

    <div class="grid g3">
      ${stat('Pipeline (open deals)', fmt(pipeline), { sub: `${open.length} open` })}
      ${stat('Invoiced to date', fmt(invoiced))}
      ${stat('Net after deal costs', signed(net), { raw: true, hero: true })}
      ${stat('Tokens held', fmt(tokens), { sub: 'Not yours until they close' })}
    </div>

    <div class="actions">
      <button class="btn primary" type="button" onclick="fin.record('newdeal')">Add a deal</button>
    </div>

    ${table(
      `<th>Deal</th><th>Status</th><th class="n">Expected</th><th class="n">Invoiced</th><th class="n">Received</th><th class="n">Owed to you</th><th class="n">Token held</th><th class="n">Costs</th><th class="n">Net</th>`,
      rows.map(({ d, f }) => {
        const [label, cls] = STATUS[shownStatus(d, f)] || [d.status, ''];
        return `<tr class="click" tabindex="0" role="button" onkeydown="if(event.key==='Enter')this.click()" onclick="finDeals.open('${esc(d.id)}')">
          <td><b>${esc(d.nickname)}</b>${d.propertyCode || d.propertyName ? `<br><span class="small faint">${esc([d.propertyCode, d.propertyName].filter(Boolean).join(' — '))}</span>` : ''}
            <br><span class="small faint">${[d.seller?.name && 'Seller ' + d.seller.name, d.buyer?.name && 'Buyer ' + d.buyer.name].filter(Boolean).map(esc).join(' · ') || 'No parties yet'}</span></td>
          <td data-label="Status">${tag(label, cls)}</td>
          <td class="n" data-label="Expected">${fmt(f.expected)}</td>
          <td class="n" data-label="Invoiced">${fmt(f.income)}</td>
          <td class="n" data-label="Received">${fmt(f.received)}</td>
          <td class="n" data-label="Owed to you">${f.recv > 0.5 ? `<span class="neg">${fmt(f.recv)}</span>` : '<span class="faint">—</span>'}</td>
          <td class="n" data-label="Token held">${f.tokens > 0.5 ? fmt(f.tokens) : '<span class="faint">—</span>'}</td>
          <td class="n" data-label="Costs">${f.costs ? fmt(f.costs) : '<span class="faint">—</span>'}</td>
          <td class="n" data-label="Net">${signed(f.net)}</td>
        </tr>`;
      }).join(''),
      `<tr><td colspan="2">Totals</td><td class="n" data-label="Expected">${fmt(rows.reduce((a, r) => a + r.f.expected, 0))}</td><td class="n" data-label="Invoiced">${fmt(invoiced)}</td>
         <td class="n" data-label="Received">${fmt(rows.reduce((a, r) => a + r.f.received, 0))}</td><td class="n" data-label="Owed to you">${fmt(rows.reduce((a, r) => a + r.f.recv, 0))}</td>
         <td class="n" data-label="Token held">${fmt(tokens)}</td><td class="n" data-label="Costs">${fmt(rows.reduce((a, r) => a + r.f.costs, 0))}</td><td class="n" data-label="Net">${signed(net)}</td></tr>`, { stack: true })}`;
}

function drawer(id) {
  const s = getState();
  const d = s.deals.find(x => x.id === id);
  if (!d) return;
  const f = figures(d);
  const lines = [];
  for (const t of [...s.txns].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const l of t.lines) if (l.deal === d.id) lines.push({ t, l });
  }
  const side = (who) => who?.partyId ? `${esc(who.name || pname(who.partyId))}${who.phone ? ' · ' + esc(who.phone) : ''}` : '<span class="faint">not set</span>';
  // What makes billing the two sides separately legible: each side says where it stands.
  const sideLine = x => x.pid ? `<div class="small muted" style="margin-top:4px">expected ${fmt(x.expected)} · invoiced ${x.billed ? fmt(x.invoiced) : '<span class="faint">not yet</span>'}${x.open > 0.5 ? ` · <span class="neg">open ${fmt(x.open)}</span>` : x.billed ? ' · <span class="pos">paid</span>' : ''}</div>` : '';
  const act = (k, preset, label, cls = 'btn sm') => `<button class="${cls}" type="button" onclick="fin.closeModal();fin.record('${k}',${JSON.stringify(preset).replace(/"/g, '&quot;')})">${esc(label)}</button>`;

  modal({
    title: d.nickname,
    body: `
      <p class="small muted" style="margin:0 0 10px">${tag((STATUS[shownStatus(d, f)] || [d.status])[0], (STATUS[shownStatus(d, f)] || ['', ''])[1])}${d.registeredOn ? ' · registered ' + esc(d.registeredOn) : ''}
        ${d.propertyCode || d.propertyName ? ' · ' + esc([d.propertyCode, d.propertyName].filter(Boolean).join(' — ')) : ''}
        · Property in ${esc(d.propertyState || s.settings.state)} · opened ${esc(d.opened || '—')}</p>

      <div class="grid g3" style="margin-bottom:12px">
        ${stat('Expected', fmt(f.expected))}
        ${stat('Invoiced', fmt(f.income))}
        ${stat('Net', signed(f.net), { raw: true })}
        ${stat('Owed to you', fmt(f.recv), { cls: f.recv > 0.5 ? 'neg' : '' })}
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="row2">
          <div><div class="small muted">Seller</div>${side(d.seller)}${sideLine(f.seller)}</div>
          <div><div class="small muted">Buyer</div>${side(d.buyer)}${sideLine(f.buyer)}</div>
        </div>
      </div>

      <h3>Record on this deal</h3>
      <div class="actions">
        ${d.status === 'open' ? act('register', { deal: d.id }, 'Mark registered', 'btn sm primary') : ''}
        ${d.status !== 'cancelled' && d.buyer?.partyId ? act('invoice', { deal: d.id, from: 'buyer' }, f.buyer.billed ? 'Invoice the buyer again' : 'Invoice the buyer', d.status === 'registered' && !f.buyer.billed ? 'btn sm primary' : 'btn sm') : ''}
        ${d.status !== 'cancelled' && d.seller?.partyId ? act('invoice', { deal: d.id, from: 'seller' }, f.seller.billed ? 'Invoice the seller again' : 'Invoice the seller', d.status === 'registered' && !f.seller.billed ? 'btn sm primary' : 'btn sm') : ''}
        ${d.status !== 'cancelled' ? act('token', { deal: d.id }, 'Token received') : ''}
        ${d.status !== 'cancelled' ? act('dealcost', { deal: d.id }, 'Cost for this deal') : ''}
        ${[d.buyer, d.seller].filter(p => p?.partyId && bal('1100', { party: p.partyId, deal: d.id }) > 0.5)
          .map(p => act('dealpay', { party: p.partyId }, `${p.name || 'Client'} pays`)).join('')}
        ${f.tokens > 0.5 ? act('settle', { deal: d.id }, 'Settle the token') : ''}
      </div>

      <h3>Every line on this deal <span class="muted">(${lines.length})</span></h3>
      ${lines.length ? `<div class="tbl-wrap"><table>
        <thead><tr><th>Date</th><th>Entry</th><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead>
        <tbody>${lines.map(({ t, l }) => `<tr class="click" onclick="fin.closeModal();fin.openTxn('${esc(t.id)}')">
          <td class="nowrap small">${esc(t.date)}</td>
          <td class="small">${esc(t.desc)}</td>
          <td class="small">${esc(A[l.acc]?.name || l.acc)}</td>
          <td class="n">${l.dr ? fmt(l.dr) : ''}</td><td class="n">${l.cr ? fmt(l.cr) : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="small faint">Nothing recorded on this deal yet.</p>'}

      <h3 style="margin-top:16px">Deal details</h3>
      <div class="row2">
        <div class="field"><label for="dl_nick">Nickname</label><input id="dl_nick" value="${esc(d.nickname)}"></div>
        <div class="field"><label for="dl_state">Property is in</label><input id="dl_state" value="${esc(d.propertyState || s.settings.state || 'Tamil Nadu')}"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="dl_exps">Expected from seller</label><input id="dl_exps" type="number" value="${num(d.expSeller)}"></div>
        <div class="field"><label for="dl_expb">Expected from buyer</label><input id="dl_expb" type="number" value="${num(d.expBuyer)}"></div>
      </div>
      <div class="field"><label for="dl_status">Status</label>
        <select id="dl_status">${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${d.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="hint">Registered is set by "Deal registered" or the button above. Invoices can be raised before or after. Use Cancelled when it falls through; a token can then be settled.</div></div>`,
    foot: `<button class="btn primary" type="button" onclick="finDeals.save('${esc(d.id)}')">Save details</button>`,
  });
}

if (typeof window !== 'undefined') {
  window.finDeals = {
    tab(t) { dealsTab = t; window.fin.repaint(); if (t === 'invoices') mountInvoices(); },
    open: drawer,
    async save(id) {
      const v = k => document.getElementById(k).value;
      try {
        await SY.saveDeal(id, {
          nickname: v('dl_nick').trim(), propertyState: v('dl_state').trim() || null,
          expSeller: num(v('dl_exps')), expBuyer: num(v('dl_expb')), status: v('dl_status'),
        });
        window.fin.closeModal();
        window.fin.toast('Deal updated');
      } catch (e) { window.fin.toast(e.message || 'Could not save'); }
    },
  };
}
