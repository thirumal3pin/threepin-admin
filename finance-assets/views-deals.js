// ═══════ DEALS ═══════
//
// The pipeline and what each deal actually made. A brokerage lives and dies by this table:
// expected against invoiced, what has been collected, what is still held for the client, and
// what the deal cost to close. Everything is derived from the lines tagged with the deal.

import {
  A, fmt, esc, num, today, getState, bal, pl, pname, dealFigures,
} from './finance-core.js';
import { stat, signed, empty, note, tag, table, modal } from './ui.js';
import * as SY from './finance-sync.js';

const STATUS = { open: ['Open', ''], registered: ['Registered', 'ok'], cancelled: ['Cancelled', 'rev'] };

// Cash that moved in transactions carrying this deal: tokens, payments, refunds, costs.
function cashOnDeal(d) {
  let s = 0;
  for (const t of getState().txns) {
    if (!t.lines.some(l => l.deal === d.id)) continue;
    for (const l of t.lines) if (['1000', '1010'].includes(l.acc)) s += num(l.dr) - num(l.cr);
  }
  return s;
}

function figures(d) {
  const f = dealFigures(d);
  return {
    ...f,
    expected: num(d.expSeller) + num(d.expBuyer),
    received: cashOnDeal(d),
  };
}

export function renderDeals() {
  const s = getState();
  if (!s.deals.length) {
    return `<h1>Deals</h1>
      ${note('A deal is where income and costs are mapped. Add one as soon as a client is serious — the expected brokerage is an estimate for your pipeline and nothing counts as income until the deal closes.', 'info')}
      ${empty('<b>No deals yet.</b>', '<button class="btn primary" type="button" onclick="fin.record(\'newdeal\')">Add a deal</button>')}`;
  }

  const rows = [...s.deals].map(d => ({ d, f: figures(d) }))
    .sort((a, b) => (a.d.status === 'cancelled') - (b.d.status === 'cancelled') || String(b.d.opened || '').localeCompare(String(a.d.opened || '')));
  const open = rows.filter(r => r.d.status === 'open');
  const pipeline = open.reduce((a, r) => a + r.f.expected, 0);
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
      `<th>Deal</th><th>Status</th><th class="n">Expected</th><th class="n">Invoiced</th><th class="n">Received</th><th class="n">Owed to you</th><th class="n">Token held</th><th class="n">Costs</th><th class="n">Net</th><th></th>`,
      rows.map(({ d, f }) => {
        const [label, cls] = STATUS[d.status] || [d.status, ''];
        return `<tr class="click" onclick="finDeals.open('${esc(d.id)}')">
          <td><b>${esc(d.nickname)}</b>${d.propertyCode || d.propertyName ? `<br><span class="small faint">${esc([d.propertyCode, d.propertyName].filter(Boolean).join(' — '))}</span>` : ''}
            <br><span class="small faint">${[d.seller?.name && 'Seller ' + d.seller.name, d.buyer?.name && 'Buyer ' + d.buyer.name].filter(Boolean).map(esc).join(' · ') || 'No parties yet'}</span></td>
          <td>${tag(label, cls)}</td>
          <td class="n">${fmt(f.expected)}</td>
          <td class="n">${fmt(f.income)}</td>
          <td class="n">${fmt(f.received)}</td>
          <td class="n">${f.recv > 0.5 ? `<span class="neg">${fmt(f.recv)}</span>` : '—'}</td>
          <td class="n">${f.tokens > 0.5 ? fmt(f.tokens) : '—'}</td>
          <td class="n">${f.costs ? fmt(f.costs) : '—'}</td>
          <td class="n">${signed(f.net)}</td>
          <td class="n"><button class="btn ghost sm" type="button" onclick="event.stopPropagation();finDeals.open('${esc(d.id)}')">Open</button></td>
        </tr>`;
      }).join(''),
      `<tr><td colspan="2">Totals</td><td class="n">${fmt(rows.reduce((a, r) => a + r.f.expected, 0))}</td><td class="n">${fmt(invoiced)}</td>
         <td class="n">${fmt(rows.reduce((a, r) => a + r.f.received, 0))}</td><td class="n">${fmt(rows.reduce((a, r) => a + r.f.recv, 0))}</td>
         <td class="n">${fmt(tokens)}</td><td class="n">${fmt(rows.reduce((a, r) => a + r.f.costs, 0))}</td><td class="n">${signed(net)}</td><td></td></tr>`)}`;
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
  const act = (k, preset, label, cls = 'btn sm') => `<button class="${cls}" type="button" onclick="fin.closeModal();fin.record('${k}',${JSON.stringify(preset).replace(/"/g, '&quot;')})">${esc(label)}</button>`;

  modal({
    title: d.nickname,
    body: `
      <p class="small muted" style="margin:0 0 10px">${tag((STATUS[d.status] || [d.status])[0], (STATUS[d.status] || ['', ''])[1])}
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
          <div><div class="small muted">Seller</div>${side(d.seller)}</div>
          <div><div class="small muted">Buyer</div>${side(d.buyer)}</div>
        </div>
      </div>

      <h3>Record on this deal</h3>
      <div class="actions">
        ${d.status !== 'cancelled' ? act('token', { deal: d.id }, 'Token received') : ''}
        ${d.status !== 'cancelled' ? act('dealcost', { deal: d.id }, 'Cost for this deal') : ''}
        ${d.status !== 'cancelled' && d.buyer?.partyId ? act('invoice', { deal: d.id, from: 'buyer' }, 'Close — bill the buyer', 'btn sm primary') : ''}
        ${d.status !== 'cancelled' && d.seller?.partyId ? act('invoice', { deal: d.id, from: 'seller' }, 'Close — bill the seller', 'btn sm primary') : ''}
        ${f.recv > 0.5 ? act('dealpay', { deal: d.id }, 'Client pays') : ''}
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
        <div class="hint">Registered is set for you when you close the deal. Use Cancelled when it falls through; the token can then be settled.</div></div>`,
    foot: `<button class="btn primary" type="button" onclick="finDeals.save('${esc(d.id)}')">Save details</button>`,
  });
}

if (typeof window !== 'undefined') {
  window.finDeals = {
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
