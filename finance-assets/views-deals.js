// ═══════ DEALS ═══════
//
// The pipeline and what each deal actually made. A brokerage lives and dies by this table:
// expected against invoiced, what has been collected, what is still held for the client, and
// what the deal cost to close. Everything is derived from the lines tagged with the deal.

import {
  sideInvoiced,
  A, fmt, esc, num, today, getState, bal, pl, pname, dealFigures, liveInvoice,
  builderBook, projectOf, isBuilderDeal, codeKey, projectForCode,
} from './finance-core.js';
import { stat, signed, empty, note, tag, table, modal } from './ui.js';
import { renderInvoices, mountInvoices } from './views-invoices.js';
import { brokerageSync, dealBrokerage } from './finance-events.js';
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
  const invs = pid ? s.invoices.filter(i => i.dealId === d.id && i.partyId === pid && liveInvoice(i)) : [];
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
      && [seller, buyer].every(x => !x.pid || x.billed || x.expected < 0.5 || (x === buyer && isBuilderDeal(d)))
      && num(f.recv) < 0.5 && num(f.tokens) < 0.5,
  };
}

let dealsTab = 'pipeline';
// Which way each side's brokerage is given in the open deal panel: 'pct' follows the sale price.
let panelBasis = {};

export function renderDeals() {
  const tabs = `<div class="seg" role="tablist" style="margin-bottom:14px">
    <button type="button" role="tab" class="${dealsTab === 'pipeline' ? 'on' : ''}" aria-selected="${dealsTab === 'pipeline'}" onclick="finDeals.tab('pipeline')">Deals</button>
    <button type="button" role="tab" class="${dealsTab === 'builders' ? 'on' : ''}" aria-selected="${dealsTab === 'builders'}" onclick="finDeals.tab('builders')">Builders</button>
    <button type="button" role="tab" class="${dealsTab === 'invoices' ? 'on' : ''}" aria-selected="${dealsTab === 'invoices'}" onclick="finDeals.tab('invoices')">Invoices</button>
  </div>`;
  if (dealsTab === 'invoices') return tabs + renderInvoices();
  if (dealsTab === 'builders') return tabs + renderBuilders();
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
            <br><span class="small faint">${[d.seller?.name && (isBuilderDeal(d) ? 'Builder ' : 'Seller ') + d.seller.name, d.projectName && d.projectName + (d.unit ? ' ' + d.unit : ''), d.buyer?.name && 'Buyer ' + d.buyer.name].filter(Boolean).map(esc).join(' · ') || 'No parties yet'}${num(d.salePrice) > 0 ? ' · Sale ' + fmt(d.salePrice) : ''}</span></td>
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

// ═══════ BUILDERS ═══════
//
// The channel-partner book: every builder, its projects, the bookings closed in each, and the
// closed ones whose builder invoice has not gone out — the money most easily lost. A builder is
// a client record (finance-core.js builderBook): its GSTIN and billing address print on its
// invoices; its projects list the dashboard's property codes that belong to them.
function renderBuilders() {
  const book = builderBook(getState());
  const head = `<h1>Builders</h1>
    <p class="lead">Your channel-partner work: each builder, its projects, the bookings you closed in each — and the builder invoices still to raise.</p>`;
  const actions = `<div class="actions">
      <button class="btn primary" type="button" onclick="fin.record('newdeal',{sellerKind:'builder'})">Record a builder deal</button>
      <button class="btn" type="button" onclick="finDeals.editBuilder()">Add a builder</button>
    </div>`;
  if (!book.length) {
    return head + note('Add a builder with its GST and billing details — they print on its invoices — then its projects, and the property codes on your dashboard that belong to each (KOY0003 → Kinglife). Every deal whose seller is that builder is then counted against its project, and every closed booking not yet invoiced shows here.', 'info')
      + empty('<b>No builders yet.</b>', '<button class="btn primary" type="button" onclick="finDeals.editBuilder()">Add a builder</button>');
  }
  const T = k => book.reduce((a, x) => a + num(x.totals[k]), 0);
  const toInv = book.flatMap(x => x.totals.toInvoice.map(d => ({ d, b: x.builder })));
  const toInvAmt = toInv.reduce((a, x) => a + num(x.d.expSeller), 0);
  const where = d => [d.projectName, d.unit && 'Unit ' + d.unit].filter(Boolean).join(' · ');
  const dealRow = ({ d, b }) => `<tr>
      <td><a href="#" onclick="event.preventDefault();finDeals.open('${esc(d.id)}')"><b>${esc(d.nickname)}</b></a>
        <br><span class="small faint">${esc([b.name, where(d), d.buyer?.name && 'Buyer ' + d.buyer.name].filter(Boolean).join(' · '))}</span></td>
      <td class="small" data-label="Closed">${esc(d.registeredOn || d.opened || '—')}</td>
      <td class="n" data-label="Commission">${num(d.expSeller) > 0 ? fmt(d.expSeller) : '<span class="faint">not set</span>'}</td>
      <td class="n"><button class="btn sm primary" type="button" onclick="fin.record('invoice',{deal:'${esc(d.id)}',from:'seller'})">Invoice ${esc(b.name)}</button></td>
    </tr>`;

  const card = x => {
    const b = x.builder;
    const billing = [b.gstin ? 'GSTIN ' + b.gstin : '', b.state, num(b.commissionPct) > 0 ? `default commission ${+num(b.commissionPct).toFixed(2)}%` : ''].filter(Boolean).join(' · ');
    const rows = x.projects.map(r => {
      const pj = r.project;
      const codes = (pj?.codes || []).map(c => `<span class="code-chip">${esc(c)}</span>`).join(' ');
      return `<tr>
        <td><b>${pj ? esc(pj.name) : '<span class="muted">Not on a project</span>'}</b>
          ${pj && (pj.location || num(pj.pct) > 0) ? `<div class="small faint">${esc([pj.location, num(pj.pct) > 0 ? +num(pj.pct).toFixed(2) + '%' : ''].filter(Boolean).join(' · '))}</div>` : ''}
          ${codes ? `<div style="margin-top:3px">${codes}</div>` : ''}</td>
        <td data-label="Deals">${r.closed} closed${r.open ? ` · ${r.open} open` : ''}${r.cancelled ? ` <span class="faint">· ${r.cancelled} cancelled</span>` : ''}</td>
        <td class="n" data-label="Booked value">${r.sale ? fmt(r.sale) : '<span class="faint">—</span>'}</td>
        <td class="n" data-label="Commission">${fmt(r.expected)}</td>
        <td class="n" data-label="Invoiced">${fmt(r.invoiced)}</td>
        <td class="n" data-label="Owed">${r.owed > 0.5 ? `<span class="neg">${fmt(r.owed)}</span>` : '<span class="faint">—</span>'}</td>
        <td class="n" data-label="To invoice">${r.toInvoice.length ? tag(r.toInvoice.length + ' to invoice', 'warn') : '<span class="faint">—</span>'}</td>
        <td class="n">${pj ? `<button class="btn sm" type="button" onclick="fin.record('newdeal',{sellerKind:'builder',builder:'${esc(b.id)}',project:'${esc(pj.id)}'})">Record a deal</button>
          <button class="btn ghost sm" type="button" onclick="finDeals.editProject('${esc(b.id)}','${esc(pj.id)}')">Edit</button>` : ''}</td>
      </tr>`;
    }).join('');
    return `<div class="card bld" style="margin-bottom:14px">
      <div class="bld-head">
        <div><h3 style="margin:0">${esc(b.name)}</h3>
          <div class="small muted">${esc(billing) || '<span class="faint">No billing details yet</span>'}</div></div>
        <div class="actions" style="margin:0">
          <button class="btn sm" type="button" onclick="finDeals.editBuilder('${esc(b.id)}')">GST &amp; billing</button>
          <button class="btn sm" type="button" onclick="finDeals.editProject('${esc(b.id)}')">Add a project</button>
        </div>
      </div>
      ${!String(b.gstin || '').trim() || !String(b.address || '').trim() ? note(`<b>${!String(b.gstin || '').trim() ? 'No GSTIN' : 'No billing address'} on file.</b> It prints on ${esc(b.name)}'s invoices — add it under GST &amp; billing before you invoice.`) : ''}
      <div class="small muted" style="margin:6px 0 8px">${x.totals.deals} deal${x.totals.deals === 1 ? '' : 's'} · booked ${fmt(x.totals.sale)} · invoiced ${fmt(x.totals.invoiced)}${x.totals.owed > 0.5 ? ` · <span class="neg">owes you ${fmt(x.totals.owed)}</span>` : ''}</div>
      ${x.projects.length ? table(
        '<th>Project</th><th>Deals</th><th class="n">Booked value</th><th class="n">Commission</th><th class="n">Invoiced</th><th class="n">Owed</th><th class="n">To invoice</th><th></th>',
        rows, '', { stack: true }) : '<p class="small faint">No projects yet — add one, with the property codes that belong to it.</p>'}
      ${x.unlinked.length ? `<p class="small muted" style="margin:8px 0 0">${x.unlinked.length} invoice${x.unlinked.length === 1 ? '' : 's'} to ${esc(b.name)} (${fmt(x.unlinked.reduce((a, i) => a + num(i.base), 0))}) ${x.unlinked.length === 1 ? 'is' : 'are'} not on a deal — counted in its invoiced total, but no project gets the credit. Put each on its deal from the Invoices tab.</p>` : ''}
    </div>`;
  };

  return `${head}
    <div class="grid g3">
      ${stat('Builder deals', String(T('deals')), { sub: `${T('closed')} closed · ${T('open')} open` })}
      ${stat('Booked value', fmt(T('sale')))}
      ${stat('Invoiced to builders', fmt(T('invoiced')))}
      ${stat('Owed by builders', fmt(T('owed')), { cls: T('owed') > 0.5 ? 'neg' : '' })}
      ${stat('Closed, not invoiced', fmt(toInvAmt), { sub: `${toInv.length} deal${toInv.length === 1 ? '' : 's'}`, hero: toInv.length > 0 })}
    </div>
    ${actions}
    ${toInv.length ? `<h2>Closed, not invoiced <span class="muted">(${toInv.length})</span></h2>
      <p class="small muted" style="margin:-4px 0 8px">Each booking below has closed but its builder invoice has not been raised. Raise it and the income and GST are counted.</p>
      ${table('<th>Deal</th><th>Closed</th><th class="n">Commission</th><th></th>', toInv.map(dealRow).join(''), '', { stack: true })}` : ''}
    <h2>By builder and project</h2>
    ${book.map(card).join('')}`;
}

// The builder form: the billing details its invoices print, and its default commission.
function builderForm(id) {
  const s = getState();
  const b = id ? s.parties.find(p => p.id === id) : { name: '', type: 'client' };
  if (!b) return;
  const others = s.parties.filter(p => !p.builder && !p.__pending && (p.type === 'client' || !p.type)).sort((a, c) => a.name.localeCompare(c.name));
  modal({
    title: id ? b.name + ' — GST & billing' : 'Add a builder',
    body: `
      ${!id && others.length ? `<div class="field"><label for="b_existing">Already one of your clients?</label>
        <select id="b_existing" onchange="finDeals.pickExisting(this.value)"><option value="">No — a new builder</option>${others.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
        <div class="hint">Pick them to make that client a builder — their invoices and deals stay as they are.</div></div>` : ''}
      <div class="field"><label for="b_name">Builder name</label><input type="text" id="b_name" value="${esc(b.name)}" placeholder="e.g. Purvankara Ltd"></div>
      <div class="row2">
        <div class="field"><label for="b_gstin">GSTIN</label><input type="text" id="b_gstin" value="${esc(b.gstin || '')}" autocapitalize="characters"></div>
        <div class="field"><label for="b_state">State</label><input type="text" id="b_state" value="${esc(b.state || '')}" placeholder="Tamil Nadu"></div>
      </div>
      <div class="field"><label for="b_address">Billing address</label><textarea id="b_address" rows="2">${esc(b.address || '')}</textarea></div>
      <div class="row2">
        <div class="field"><label for="b_pan">PAN</label><input type="text" id="b_pan" value="${esc(b.pan || '')}" autocapitalize="characters"></div>
        <div class="field"><label for="b_commission">Default commission %</label><input type="number" id="b_commission" inputmode="decimal" step="0.01" min="0" value="${num(b.commissionPct) || ''}" placeholder="e.g. 2"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="b_contact">Contact person (CP desk)</label><input type="text" id="b_contact" value="${esc(b.contact || '')}"></div>
        <div class="field"><label for="b_phone">Phone</label><input type="text" id="b_phone" value="${esc(b.phone || '')}"></div>
      </div>
      <div class="field"><label for="b_email">Email (for invoices)</label><input type="email" id="b_email" value="${esc(b.email || '')}"></div>
      <div class="hint">These print on the builder's invoices, as the client billed. The default commission fills in on a new deal unless the project pays a different %.</div>`,
    foot: `<button class="btn primary" type="button" onclick="finDeals.saveBuilder('${esc(id || '')}')">${id ? 'Save' : 'Add builder'}</button>`,
  });
}

// A project: its name, where it is, the % it pays (when not the builder's default), and the
// property codes on the dashboard that belong to it.
function projectForm(bid, pid) {
  const b = getState().parties.find(p => p.id === bid);
  if (!b) return;
  const pj = pid ? projectOf(b, pid) : { name: '', location: '', codes: [], pct: '' };
  if (!pj) return;
  const used = getState().deals.filter(d => d.seller?.partyId === bid && d.projectId === pid).length;
  modal({
    title: pid ? `${b.name} — ${pj.name}` : `New project — ${b.name}`,
    body: `
      <div class="field"><label for="pj_name">Project name</label><input type="text" id="pj_name" value="${esc(pj.name)}" placeholder="e.g. Somerset"></div>
      <div class="row2">
        <div class="field"><label for="pj_loc">Location</label><input type="text" id="pj_loc" value="${esc(pj.location || '')}" placeholder="e.g. Kelambakkam"></div>
        <div class="field"><label for="pj_pct">Commission %</label><input type="number" id="pj_pct" inputmode="decimal" step="0.01" min="0" value="${num(pj.pct) || ''}" placeholder="${num(b.commissionPct) ? 'builder default ' + num(b.commissionPct) : 'e.g. 2'}"></div>
      </div>
      <div class="field"><label for="pj_codes">Your property codes in this project</label><input type="text" id="pj_codes" value="${esc((pj.codes || []).join(', '))}" placeholder="e.g. KOY0003, KOY0004" autocapitalize="characters">
        <div class="hint">The codes on your dashboard that belong to this project, separated by commas. Linking one of them on a new deal fills in this builder and project.</div></div>`,
    foot: `${pid ? `<button class="btn ghost" type="button" onclick="finDeals.removeProject('${esc(bid)}','${esc(pid)}')" ${used ? `disabled title="${used} deal${used === 1 ? '' : 's'} on it"` : ''}>Remove</button>` : ''}
      <button class="btn primary" type="button" onclick="finDeals.saveProject('${esc(bid)}','${esc(pid || '')}')">${pid ? 'Save' : 'Add project'}</button>`,
  });
}

function drawer(id) {
  const s = getState();
  const d = s.deals.find(x => x.id === id);
  if (!d) return;
  const f = figures(d);
  const bDeal = isBuilderDeal(d);
  const bParty = bDeal ? s.parties.find(p => p.id === d.seller.partyId) : null;
  const lines = [];
  for (const t of [...s.txns].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const l of t.lines) if (l.deal === d.id) lines.push({ t, l });
  }
  // A side picked from the CRM (or whose client is linked to a CRM lead) opens that lead, in a new tab.
  const side = (who) => {
    if (!who?.partyId) return '<span class="faint">not set</span>';
    const pt = getState().parties.find(p => p.id === who.partyId);
    const phone = who.phone || pt?.phone || '';
    const lead = who.crmRef || pt?.crmRef;
    return `${esc(who.name || pname(who.partyId))}${phone ? ' · ' + esc(phone) : ''}`
      + (lead ? `<div style="margin-top:3px"><a class="crm-open" href="/crm.html?lead=${encodeURIComponent(lead)}" target="_blank" rel="noopener" title="Open this lead in the CRM, in a new tab">Open in CRM ↗</a></div>` : '');
  };
  // What makes billing the two sides separately legible: each side says where it stands.
  const sideLine = x => x.pid ? `<div class="small muted" style="margin-top:4px">expected ${fmt(x.expected)} · invoiced ${x.billed ? fmt(x.invoiced) : '<span class="faint">not yet</span>'}${x.open > 0.5 ? ` · <span class="neg">open ${fmt(x.open)}</span>` : x.billed ? ' · <span class="pos">paid</span>' : ''}</div>` : '';
  const br = dealBrokerage(d);
  panelBasis = { sellerBy: num(d.sellerPct) > 0 ? 'pct' : 'amt', buyerBy: num(d.buyerPct) > 0 ? 'pct' : 'amt' };
  const shareOf = (amt, sale) => num(sale) > 0 && num(amt) > 0 ? Math.round(num(amt) / num(sale) * 10000) / 100 : '';
  const pctLine = p => num(p) > 0 ? `<div class="small muted">${+num(p).toFixed(2)}% of the sale</div>` : '';
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

      <div class="card deal-sides" style="margin-bottom:12px">
        <div class="row2">
          <div><div class="small muted">${bDeal ? 'Builder' : 'Seller'}</div>${side(d.seller)}${bDeal && (d.projectName || d.unit) ? `<div class="small">${esc([d.projectName, d.unit && 'Unit ' + d.unit].filter(Boolean).join(' · '))}</div>` : ''}${sideLine(f.seller)}${pctLine(d.sellerPct)}</div>
          <div><div class="small muted">Buyer${bDeal ? ' <span class="faint">(invoice optional)</span>' : ''}</div>${side(d.buyer)}${sideLine(f.buyer)}${pctLine(d.buyerPct)}</div>
        </div>
        <div class="small muted" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
          Sale price ${num(d.salePrice) > 0 ? `<b style="color:var(--ink)">${fmt(d.salePrice)}</b>${d.status === 'registered' ? ' (closed)' : ''}` : '<span class="faint">not set</span>'}
          · Brokerage ${fmt(br.base)} ${br.rate ? `+ ${br.rate}% GST ${fmt(br.gst)} = <b style="color:var(--ink)">${fmt(br.total)}</b>` : d.gst ? '· no GST' : ''}
        </div>
      </div>

      <h3>Record on this deal</h3>
      <p class="small muted" style="margin:-4px 0 8px">Status is where the deal sits on its timeline — it never limits what you can record.
        Money comes in and goes out, and a fee falls due, whenever it actually does${d.status === 'cancelled' ? ', a cancelled deal included' : ''}.</p>
      <div class="actiongroup">
        <div class="small muted">Money in</div>
        <div class="actions">
          ${act('token', { deal: d.id }, 'Token / advance received')}
          ${[d.buyer, d.seller].filter(p => p?.partyId && bal('1100', { party: p.partyId, deal: d.id }) > 0.5)
            .map(p => act('dealpay', { party: p.partyId }, `${p.name || 'Client'} pays what they owe`, 'btn sm primary')).join('')}
          ${f.tokens > 0.5 ? act('settle', { deal: d.id }, 'Settle the token — apply, refund or keep') : ''}
        </div>
      </div>
      <div class="actiongroup">
        <div class="small muted">Bill it</div>
        <div class="actions">
          ${d.buyer?.partyId ? act('invoice', { deal: d.id, from: 'buyer' }, f.buyer.billed ? 'Invoice the buyer again' : 'Invoice the buyer', d.status === 'registered' && !f.buyer.billed ? 'btn sm primary' : 'btn sm') : ''}
          ${d.seller?.partyId ? act('invoice', { deal: d.id, from: 'seller' }, (f.seller.billed ? 'Invoice the ' + (bDeal ? 'builder' : 'seller') + ' again' : 'Invoice the ' + (bDeal ? 'builder' : 'seller')), d.status === 'registered' && !f.seller.billed ? 'btn sm primary' : 'btn sm') : ''}
          ${act('dealfee', { deal: d.id }, 'Charge a flat fee', d.status === 'cancelled' ? 'btn sm primary' : 'btn sm')}
        </div>
      </div>
      <div class="actiongroup">
        <div class="small muted">Money out</div>
        <div class="actions">${act('dealcost', { deal: d.id }, 'Cost for this deal')}</div>
      </div>
      ${d.status === 'open' ? `<div class="actiongroup"><div class="small muted">Milestone</div>
        <div class="actions">${act('register', { deal: d.id }, 'Mark registered', 'btn sm primary')}</div></div>` : ''}

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
      ${bDeal ? `<div class="row2">
        <div class="field"><label for="dl_proj">Project</label><select id="dl_proj">
          ${(bParty?.projects || []).map(p => `<option value="${esc(p.id)}" ${d.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          <option value="" ${projectOf(bParty, d.projectId) ? '' : 'selected'}>Not on a project</option></select></div>
        <div class="field"><label for="dl_unit">Unit / flat no.</label><input id="dl_unit" value="${esc(d.unit || '')}"></div>
      </div>` : ''}
      <div class="field"><label for="dl_sale">${bDeal ? 'Agreement value' : d.status === 'registered' ? 'Closed sale price' : 'Sale price'}</label><input id="dl_sale" type="number" inputmode="decimal" value="${num(d.salePrice) || ''}" oninput="finDeals.calc('salePrice')"></div>
      <div class="row2">
        <div class="field"><label for="dl_pcts">Seller brokerage %</label><input id="dl_pcts" type="number" inputmode="decimal" step="0.01" value="${num(d.sellerPct) || shareOf(d.expSeller, d.salePrice)}" oninput="finDeals.calc('sellerPct')"></div>
        <div class="field"><label for="dl_exps">Expected from seller (before GST)</label><input id="dl_exps" type="number" inputmode="decimal" value="${num(d.expSeller)}" oninput="finDeals.calc('expSeller')"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="dl_pctb">Buyer brokerage %</label><input id="dl_pctb" type="number" inputmode="decimal" step="0.01" value="${num(d.buyerPct) || shareOf(d.expBuyer, d.salePrice)}" oninput="finDeals.calc('buyerPct')"></div>
        <div class="field"><label for="dl_expb">Expected from buyer (before GST)</label><input id="dl_expb" type="number" inputmode="decimal" value="${num(d.expBuyer)}" oninput="finDeals.calc('expBuyer')"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="dl_gst">GST on the brokerage</label>
          <select id="dl_gst" onchange="finDeals.calc('gst')"><option value="yes" ${d.gst?.on !== false && d.gst ? 'selected' : ''}>Yes — add GST</option><option value="no" ${d.gst?.on === false || !d.gst ? 'selected' : ''}>No GST</option></select></div>
        <div class="field"><label for="dl_gstr">GST %</label><input id="dl_gstr" type="number" inputmode="decimal" value="${d.gst?.on ? num(d.gst.rate) : 18}" oninput="finDeals.calc('gstRate')"></div>
      </div>
      <p class="small muted" id="dl_total" style="margin:-4px 0 12px">Total brokerage with GST: <b>${fmt(br.total)}</b></p>
      <div class="field"><label for="dl_status">Status</label>
        <select id="dl_status">${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${d.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="hint">Registered is set by "Deal registered" or the button above. Invoices can be raised before or after — status does not gate them. Use Cancelled when it falls through: you can still settle the token, bill a cancellation fee, collect what is owed and pay a cost that had already been incurred.</div></div>`,
    foot: `<button class="btn primary" type="button" onclick="finDeals.save('${esc(d.id)}')">Save details</button>`,
  });
}

if (typeof window !== 'undefined') {
  window.finDeals = {
    tab(t) { dealsTab = t; window.fin.repaint(); if (t === 'invoices') mountInvoices(); },
    open: drawer,
    editBuilder: builderForm,
    editProject: projectForm,
    // "Already one of your clients?" — fill the form from that client's record.
    pickExisting(pid) {
      const p = getState().parties.find(x => x.id === pid);
      const set = (k, x) => { const el = document.getElementById('b_' + k); if (el) el.value = x || ''; };
      if (!p) return;
      for (const k of ['name', 'gstin', 'state', 'address', 'pan', 'contact', 'phone', 'email']) set(k, p[k]);
    },
    async saveBuilder(id) {
      const v = k => (document.getElementById('b_' + k)?.value || '').trim();
      const name = v('name');
      if (!name) return window.fin.toast('Give the builder a name');
      const gstin = v('gstin').toUpperCase();
      if (gstin && !/^\d{2}[A-Z0-9]{13}$/.test(gstin)) return window.fin.toast('A GSTIN is 15 characters, starting with the state code — check it');
      const pct = num(v('commission'));
      if (pct < 0 || pct > 100) return window.fin.toast('A commission % is between 0 and 100');
      // A client of the same name (or the one picked) becomes the builder — never a second record.
      const s = getState();
      const target = id || v('existing') || s.parties.find(p => !p.__pending && p.name.trim().toLowerCase() === name.toLowerCase())?.id || null;
      const data = {
        name, gstin, state: v('state'), address: v('address'), pan: v('pan').toUpperCase(), contact: v('contact'),
        phone: v('phone'), email: v('email'), commissionPct: pct || null, builder: true,
        ...(target ? {} : { type: 'client', projects: [] }),
      };
      try {
        await SY.saveParty(target, data);
        window.fin.closeModal();
        window.fin.toast(id ? 'Saved' : `${name} added — now add its projects`);
      } catch (e) { window.fin.toast(e.message || 'Could not save'); }
    },
    async saveProject(bid, pid) {
      const b = getState().parties.find(p => p.id === bid);
      if (!b) return;
      const v = k => (document.getElementById('pj_' + k)?.value || '').trim();
      const name = v('name');
      if (!name) return window.fin.toast('Give the project a name');
      const list = [...(b.projects || [])];
      if (list.some(p => p.id !== pid && p.name.trim().toLowerCase() === name.toLowerCase())) return window.fin.toast(`${b.name} already has a project called ${name}`);
      const codes = [...new Set(v('codes').split(/[\s,;]+/).map(codeKey).filter(Boolean))];
      // A property belongs to one project — otherwise linking it could not say whose deal it is.
      for (const c of codes) {
        const hit = projectForCode(c);
        if (hit && !(hit.builder.id === bid && hit.project.id === pid)) return window.fin.toast(`${c} is already on ${hit.builder.name} — ${hit.project.name}`);
      }
      const pct = num(v('pct'));
      if (pct < 0 || pct > 100) return window.fin.toast('A commission % is between 0 and 100');
      const rec = { id: pid || 'pj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, location: v('loc'), pct: pct || null, codes };
      const at = list.findIndex(p => p.id === pid);
      if (at >= 0) list[at] = rec; else list.push(rec);
      try {
        await SY.saveParty(bid, { projects: list });
        // A renamed project: its deals carry the new name.
        if (pid) for (const d of getState().deals.filter(x => x.seller?.partyId === bid && x.projectId === pid && x.projectName !== name)) await SY.saveDeal(d.id, { projectName: name });
        window.fin.closeModal();
        window.fin.toast(pid ? 'Project saved' : `${name} added`);
      } catch (e) { window.fin.toast(e.message || 'Could not save'); }
    },
    async removeProject(bid, pid) {
      const b = getState().parties.find(p => p.id === bid);
      if (!b) return;
      if (getState().deals.some(d => d.seller?.partyId === bid && d.projectId === pid)) return window.fin.toast('This project has deals on it — it stays');
      try {
        await SY.saveParty(bid, { projects: (b.projects || []).filter(p => p.id !== pid) });
        window.fin.closeModal();
        window.fin.toast('Project removed');
      } catch (e) { window.fin.toast(e.message || 'Could not save'); }
    },
    // The panel's sale price, %s and amounts follow each other the way the form's do.
    calc(k) {
      const el = id => document.getElementById(id);
      const map = { salePrice: 'dl_sale', sellerPct: 'dl_pcts', expSeller: 'dl_exps', buyerPct: 'dl_pctb', expBuyer: 'dl_expb', gst: 'dl_gst', gstRate: 'dl_gstr' };
      const v = { ...panelBasis };
      for (const [key, id] of Object.entries(map)) v[key] = el(id)?.value ?? '';
      brokerageSync(k, v);
      panelBasis = { sellerBy: v.sellerBy, buyerBy: v.buyerBy };
      for (const [key, id] of Object.entries(map)) if (key !== k && el(id) && String(el(id).value) !== String(v[key] ?? '')) el(id).value = v[key] ?? '';
      if (el('dl_gstr')) el('dl_gstr').disabled = v.gst !== 'yes';
      if (el('dl_total')) el('dl_total').innerHTML = `Total brokerage with GST: <b>${fmt(v.totalWithGst)}</b>`;
    },
    async save(id) {
      const v = k => document.getElementById(k).value;
      // A builder deal's project and unit, when the panel shows them.
      const builderBits = () => {
        const sel = document.getElementById('dl_proj');
        if (!sel) return {};
        const d = getState().deals.find(x => x.id === id);
        const b = getState().parties.find(p => p.id === d?.seller?.partyId);
        const pj = projectOf(b, sel.value);
        return { sellerKind: 'builder', projectId: pj?.id || null, projectName: pj?.name || '', unit: v('dl_unit').trim() };
      };
      const gstOn = v('dl_gst') === 'yes';
      // A % is kept only for a side whose fee is a % of the sale.
      const pctKept = (side, id) => panelBasis[side + 'By'] === 'pct' ? num(v(id)) || null : null;
      if ([v('dl_pcts'), v('dl_pctb')].some(x => num(x) < 0 || num(x) > 100)) { window.fin.toast('A brokerage % is between 0 and 100'); return; }
      try {
        await SY.saveDeal(id, {
          nickname: v('dl_nick').trim(), propertyState: v('dl_state').trim() || null,
          salePrice: num(v('dl_sale')) || null, sellerPct: pctKept('seller', 'dl_pcts'), buyerPct: pctKept('buyer', 'dl_pctb'),
          gst: { on: gstOn, rate: gstOn ? num(v('dl_gstr')) : 0 },
          expSeller: num(v('dl_exps')), expBuyer: num(v('dl_expb')), status: v('dl_status'),
          ...builderBits(),
        });
        window.fin.closeModal();
        window.fin.toast('Deal updated');
      } catch (e) { window.fin.toast(e.message || 'Could not save'); }
    },
  };
}
