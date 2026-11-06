// ═══════ INVOICES ═══════
//
// Invoices come two ways. A deal closed with GST on it raises one automatically; anything else
// is raised here, with New invoice — numbered lines, the client's billing details, GST. Every
// number comes from a counter taken inside a Firestore transaction and stepped past any number
// already on a document, so it can never be issued twice. An invoice raised here can go into
// the books at once or be issued as a document only, then recorded or attached to an entry
// later; the deal it belongs to can be set at any time. Its PDF is generated and saved the
// moment it is issued.

import {
  fmt, esc, num, today, getState, bal, pname, dname, deal,
  invoiceOutstanding, duplicateNumbers, invoiceTotals, netOfGst, withGst, issueNumber, A, invoiceServices, knownClient, KNOWN_CLIENTS,
} from './finance-core.js';
import { empty, note, tag, table, toast, modal, closeModal, dueCell, confirmDialog, picker } from './ui.js';
import { invoiceModel, downloadInvoice, shareInvoice, renderInvoicePdf } from './finance-invoice.js';
import { validateEvent, INVOICE_ACCS } from './finance-events.js';
import * as SY from './finance-sync.js';
import { presetOffer } from './views-admin.js';

// What the invoice is for, said on the row. A flat fee is not brokerage and a cancellation
// fee least of all — labelling them all "brokerage" made a GST return hard to check against
// the income heads they actually posted to.
const KIND_TAG = {
  other: 'other income',
  'fee:cancel': 'cancellation fee',
  'fee:retainer': 'retainer',
  'fee:flat': 'flat brokerage',
  forfeit: 'forfeited advance',
  direct: 'raised here',
};

// An invoice's status is derived from the payments allocated to it (its `paid` figure). An
// invoice from before allocations existed has no such figure, so for those it falls back to
// whatever the client still owes on that deal.
function statusOf(inv) {
  if (inv.kind === 'creditnote') return { key: 'cn', label: 'Credit note', cls: 'rev' };
  if (inv.unposted) return { key: 'unposted', label: 'Not in books', cls: 'warn' };
  if (inv.status === 'void') return { key: 'void', label: 'Reversed', cls: 'rev' };
  // An invoice raised before payments were tracked has no figure of its own. Guessing from
  // the party balance would give two invoices on one deal the same answer, so it says so.
  if (inv.paid === undefined) {
    const sameDeal = getState().invoices.filter(i => i.paid === undefined && i.partyId === inv.partyId && i.dealId === inv.dealId);
    if (sameDeal.length > 1) return { key: 'unknown', label: 'Before tracking', cls: '' };
  }
  const outstanding = inv.paid !== undefined
    ? num(inv.total) - num(inv.paid)
    : inv.dealId
      ? bal('1100', { party: inv.partyId, deal: inv.dealId })
      : bal('1100', { party: inv.partyId });
  if (outstanding <= 0.5) return { key: 'paid', label: 'Paid', cls: 'ok' };
  if (outstanding < num(inv.total) - 0.5) return { key: 'part', label: 'Part paid', cls: 'warn' };
  return { key: 'unpaid', label: 'Unpaid', cls: '' };
}

// Every payment applied to this invoice, so "part paid" can be opened up rather than
// simply asserted.
function paymentsFor(inv) {
  const pays = getState().txns
    .filter(t => (t.allocations || []).some(a => a.coll === 'invoices' && a.id === inv.id))
    .map(t => ({ t, amt: (t.allocations || []).filter(a => a.id === inv.id).reduce((x, a) => x + num(a.amt), 0) }))
    .filter(p => Math.abs(p.amt) > 0.005);
  if (!pays.length) return '';
  return `<details class="journal" style="margin-top:6px">
    <summary class="small">${pays.length} payment${pays.length === 1 ? '' : 's'}</summary>
    ${pays.map(p => `<div class="docrow"><span class="small">${esc(p.t.date)}</span>
      <span class="n">${fmt(p.amt)}</span>
      <span><button class="btn ghost sm" type="button" onclick="event.stopPropagation();fin.openTxn('${esc(p.t.id)}')">Entry</button></span></div>`).join('')}
  </details>`;
}

function modelFor(inv) {
  const s = getState();
  return invoiceModel({
    invoice: inv,
    party: s.parties.find(p => p.id === inv.partyId) || { name: pname(inv.partyId) },
    deal: deal(inv.dealId),
    settings: s.settings,
  });
}

export function renderInvoices() {
  const s = getState();
  if (!s.invoices.length) {
    return `<h1>Invoices</h1>
      ${note('Closing a deal with GST raises its invoice for you. For anything else, use <b>New invoice</b>.', 'info')}
      ${empty('<b>No invoices yet.</b><br>Raise one here, or close a deal and its GST invoice is generated, numbered and stored for you.',
      '<button class="btn primary" type="button" onclick="finInvoices.create()">New invoice</button>')}
      ${clientsSection()}`;
  }

  // A missing GSTIN or bank account does not block anything, but it does make the PDF wrong,
  // so it is surfaced here rather than discovered by a client.
  const gaps = modelFor(s.invoices[0]).missing || [];
  // A number on two documents is the one thing on this page that is plainly wrong, so it is
  // said first. The oldest holder keeps it; every later one gets a button for a fresh number.
  const dupes = duplicateNumbers(s.invoices);
  const renumber = new Set(Object.values(dupes).flatMap(list => list.slice(1).map(i => i.id)));
  const dupeKeys = Object.keys(dupes);
  const rows = [...s.invoices].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.invoiceNo).localeCompare(String(a.invoiceNo)));
  const isCn = i => i.kind === 'creditnote';
  const total = rows.filter(i => !isCn(i)).reduce((a, i) => a + num(i.total), 0) - rows.filter(isCn).reduce((a, i) => a + num(i.total), 0);
  // What is still to come in is what each invoice has left on it, not its face value — a
  // part-paid invoice is not still owed in full.
  const unpaid = rows
    .filter(i => !isCn(i) && !['paid', 'void', 'unposted'].includes(statusOf(i).key))
    .reduce((a, i) => a + (i.paid !== undefined ? invoiceOutstanding(i) : num(i.total)), 0);

  const loose = rows.filter(i => i.unposted);

  return `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h1 style="margin:0">Invoices</h1>
      <div class="spacer"></div>
      <button class="btn" type="button" onclick="finAdmin.editParty()">Add a client</button>
      <button class="btn primary" type="button" onclick="finInvoices.create()">New invoice</button>
    </div>
    <p class="lead">${rows.filter(i => !isCn(i)).length} invoices${rows.some(isCn) ? ` and ${rows.filter(isCn).length} credit note${rows.filter(isCn).length === 1 ? '' : 's'}` : ''}, ${fmt(total)} net. Deal brokerage and other income both raise invoices; reversing an invoiced entry issues a credit note against it.</p>
    ${dupeKeys.length ? note(
    `<b>${dupeKeys.length === 1 ? 'One invoice number is' : `${dupeKeys.length} invoice numbers are`} used twice:</b> ${esc(dupeKeys.join(', '))}.
       The earliest one keeps its number. Use <b>New number</b> on the later one${dupeKeys.length === 1 ? '' : 's'}, then send
       that client the new PDF. New invoices can no longer repeat a number.`) : ''}
    ${loose.length ? note(
    `<b>${loose.length} invoice${loose.length === 1 ? ' is' : 's are'} not in the books yet</b> (${fmt(loose.reduce((a, i) => a + num(i.total), 0))}).
       Until each is recorded or attached to an entry, it is not in your income, what clients owe, or the GST figures.
       Open <b>Manage</b> on it to do that.`, 'info') : ''}
    ${gaps.length ? note(
    `<b>Your invoices are missing ${gaps.length === 1 ? 'a detail' : 'some details'}:</b> ${esc(gaps.join(', '))}.
       Fill these in on the <a href="#profile" onclick="fin.go('profile');return false">Profile tab</a> — every PDF you
       generate until then will be incomplete.
       ${presetOffer() ? `<div class="actions" style="margin:10px 0 0"><button class="btn primary" type="button" onclick="finAdmin.fillPreset()">Fill in from invoice 056</button></div>` : ''}`) : ''}

    ${table(
    `<th>Number</th><th>Date</th><th>Client</th><th>Deal</th><th class="n">Total</th><th>Due</th><th>Status</th><th></th>`,
    rows.map(inv => {
      const st = statusOf(inv);
      return `<tr>
          <td class="lead nowrap">${esc(inv.invoiceNo || '—')}
            ${dupes[String(inv.invoiceNo || '').trim()] ? tag(renumber.has(inv.id) ? 'duplicate' : 'keeps number', renumber.has(inv.id) ? 'rev' : '') : ''}
            ${inv.renumberedFrom ? `<br><span class="small faint">was ${esc(inv.renumberedFrom)}</span>` : ''}
            ${inv.kind === 'creditnote' ? `<br><span class="small faint">against ${esc(inv.against || '')}</span>` : tag(KIND_TAG[inv.kind === 'fee' ? 'fee:' + (inv.feeKind || 'cancel') : inv.kind] || 'brokerage')}
            ${s.parties.find(p => p.id === inv.partyId)?.gstin ? tag('B2B', 'ok') : ''}</td>
          <td class="nowrap small" data-label="Date">${esc(inv.date)}</td>
          <td data-label="Client">${esc(pname(inv.partyId))}</td>
          <td class="small" data-label="For">${inv.dealId ? esc(dname(inv.dealId)) : esc(inv.items?.length > 1 ? `${inv.items.length} lines — ${inv.items[0].desc}` : (inv.desc || '—'))}</td>
          <td class="n" data-label="Total">${fmt(inv.total)}
            ${inv.paid > 0.005 && st.key !== 'paid' ? `<br><span class="small neg">${fmt(invoiceOutstanding(inv))} left</span>` : ''}
            <br><span class="small faint">${inv.igst ? 'IGST' : 'CGST+SGST'}</span></td>
          <td class="small nowrap" data-label="Due">${isCn(inv) || !inv.dueDate ? '—' : dueCell(inv.dueDate)}</td>
          <td data-label="Status">${tag(st.label, st.cls)}
            ${paymentsFor(inv)}</td>
          <td class="n nowrap">
            ${renumber.has(inv.id) ? `<button class="btn sm" type="button" onclick="finInvoices.renumber('${esc(inv.id)}')">New number</button>` : ''}
            <button class="btn ghost sm" type="button" onclick="finInvoices.view('${esc(inv.id)}')">View PDF</button>
            <button class="btn ghost sm" type="button" onclick="finInvoices.share('${esc(inv.id)}')">Share</button>
            <button class="btn ghost sm" type="button" onclick="finInvoices.manage('${esc(inv.id)}')">Manage</button>
          </td></tr>`;
    }).join(''),
    `<tr><td colspan="4" data-label="Total raised">Total raised</td><td class="n">${fmt(total)}</td><td colspan="3"></td></tr>
       <tr><td colspan="4" data-label="Still to collect">Still to collect</td><td class="n">${fmt(unpaid)}</td><td colspan="3"></td></tr>`, { stack: true })}

    ${clientsSection()}

    <input type="file" id="invUpload" accept="application/pdf" hidden>`;
}

// ═══════ NEW INVOICE ═══════
//
// One dialog: the client (picked, or added on the spot), their billing details as they will
// print — edited here and saved back to the client for next time — numbered lines, the GST rate
// (18% unless changed, CGST and SGST in-state), and whether it goes into the books now. A line
// is typed before GST or including it, and the other figure follows.

const RATES = [0, 5, 12, 18, 28];
const BILL_KEYS = [['address', 'Address'], ['gstin', 'GSTIN'], ['state', 'State'], ['phone', 'Phone'], ['email', 'Email']];
let ed = null;

const blankLine = () => ({ desc: '', sac: '', amt: '', gross: '' });
const home = () => getState().settings.state || 'Tamil Nadu';
const posOf = () => (ed.posTouched ? ed.placeOfSupply : (ed.billTo.state || home()));
const edTotals = () => invoiceTotals(ed.lines.map(l => ({ desc: l.desc, sac: l.sac, amt: num(l.amt) })), ed.gstRate, posOf());

function edValues() {
  return {
    party: ed.party, date: ed.date, dueDate: ed.dueDate, placeOfSupply: posOf(), gstRate: num(ed.gstRate),
    items: ed.lines.map(l => ({ desc: l.desc.trim(), sac: l.sac.trim(), amt: num(l.amt) })).filter(l => l.amt > 0 || l.desc),
    billTo: { name: ed.billTo.name, ...Object.fromEntries(BILL_KEYS.map(([k]) => [k, ed.billTo[k] || ''])) },
    dealId: ed.dealId || null, notes: ed.notes, acc: ed.acc, via: ed.via,
  };
}

function linesHtml() {
  const svcs = invoiceServices();
  return ed.lines.map((l, i) => `<tr>
      <td class="small faint">${i + 1}</td>
      <td><select data-svc="${i}" aria-label="Line ${i + 1} service">
        <option value="">—</option>
        ${svcs.map((x, k) => `<option value="${k}" ${l.svc === String(k) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></td>
      <td><input type="text" data-line="${i}" data-f="desc" value="${esc(l.desc)}" placeholder="What it is for" aria-label="Line ${i + 1} description"></td>
      <td><input type="text" data-line="${i}" data-f="sac" value="${esc(l.sac)}" placeholder="optional" aria-label="Line ${i + 1} SAC (optional)" style="width:90px"></td>
      <td><input type="text" data-line="${i}" data-f="amt" inputmode="decimal" value="${esc(l.amt)}" aria-label="Line ${i + 1} amount before GST" style="text-align:right"></td>
      <td><input type="text" data-line="${i}" data-f="gross" inputmode="decimal" value="${esc(l.gross)}" aria-label="Line ${i + 1} amount including GST" style="text-align:right"></td>
      <td>${ed.lines.length > 1 ? `<button class="btn ghost sm" type="button" data-drop="${i}" aria-label="Remove line ${i + 1}">✕</button>` : ''}</td>
    </tr>`).join('');
}

function totalsHtml() {
  const t = edTotals();
  const r = num(ed.gstRate);
  return `<table class="invtot"><tbody>
    <tr><td>Sub total</td><td class="n">${fmt(t.base)}</td></tr>
    ${!t.tax ? '' : t.intra
    ? `<tr><td>SGST ${r / 2}%</td><td class="n">${fmt(t.sgst)}</td></tr><tr><td>CGST ${r / 2}%</td><td class="n">${fmt(t.cgst)}</td></tr>`
    : `<tr><td>IGST ${r}% <span class="small faint">— client outside ${esc(home())}</span></td><td class="n">${fmt(t.igst)}</td></tr>`}
    <tr class="grand"><td>Total</td><td class="n">${fmt(t.total)}</td></tr>
  </tbody></table>`;
}

function editorBody() {
  const s = getState();
  const deals = [...s.deals].sort((a, b) => String(a.nickname || '').localeCompare(String(b.nickname || '')));
  return `
    <div class="field"><label>Client</label><div id="edParty"></div>
      <div class="hint">Pick a client, or type a new name and add it.</div></div>
    <fieldset class="billto" id="edBill" ${ed.party ? '' : 'hidden'}>
      <legend>Billed to — as it will print</legend>
      <div class="field"><label for="ed_name">Name on the invoice</label><input type="text" id="ed_name" data-b="name" value="${esc(ed.billTo.name)}"></div>
      <div class="field"><label for="ed_address">Address</label><textarea id="ed_address" data-b="address" rows="2">${esc(ed.billTo.address)}</textarea></div>
      <div class="row2">
        <div class="field"><label for="ed_gstin">GSTIN</label><input type="text" id="ed_gstin" data-b="gstin" value="${esc(ed.billTo.gstin)}" placeholder="33XXXXXXXXXXXZX"></div>
        <div class="field"><label for="ed_state">State</label><input type="text" id="ed_state" data-b="state" value="${esc(ed.billTo.state)}" placeholder="${esc(home())}"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="ed_phone">Phone</label><input type="text" id="ed_phone" data-b="phone" value="${esc(ed.billTo.phone)}"></div>
        <div class="field"><label for="ed_email">Email</label><input type="email" id="ed_email" data-b="email" value="${esc(ed.billTo.email)}"></div>
      </div>
      <div class="hint">Changes are saved to the client, so the next invoice starts filled in. An invoice already issued keeps what it printed.</div>
    </fieldset>

    <div class="row2">
      <div class="field"><label for="ed_date">Invoice date</label><input type="date" id="ed_date" value="${esc(ed.date)}"></div>
      <div class="field"><label for="ed_due">Payment due by <span class="faint">(optional)</span></label><input type="date" id="ed_due" value="${esc(ed.dueDate)}"></div>
    </div>

    <div class="tbl-wrap invlines"><table>
      <thead><tr><th>No.</th><th>Service</th><th>Description</th><th>SAC <span class="faint">(optional)</span></th><th class="n">Before GST</th><th class="n">With GST</th><th></th></tr></thead>
      <tbody id="edLines">${linesHtml()}</tbody>
    </table></div>
    <div class="actions" style="margin:8px 0 16px"><button class="btn ghost sm" type="button" id="edAdd">+ Add a line</button></div>

    <div class="row2">
      <div class="field"><label for="ed_rate">GST %</label>
        <select id="ed_rate">${RATES.map(r => `<option value="${r}" ${num(ed.gstRate) === r ? 'selected' : ''}>${r ? r + '%' : 'No GST'}</option>`).join('')}</select>
        <div class="hint">In ${esc(home())}: half CGST, half SGST. Another state: IGST.</div></div>
      <div class="field"><label for="ed_pos">Place of supply</label><input type="text" id="ed_pos" value="${esc(posOf())}">
        <div class="hint">The client's state, unless you change it.</div></div>
    </div>
    <div id="edTotals">${totalsHtml()}</div>

    <div class="row2" style="margin-top:16px">
      <div class="field"><label for="ed_books">In the books</label>
        <select id="ed_books">
          <option value="yes" ${ed.record === 'yes' ? 'selected' : ''}>Record the income now</option>
          <option value="no" ${ed.record === 'no' ? 'selected' : ''}>Document only — record or attach later</option>
        </select></div>
      <div class="field"><label for="ed_deal">Deal <span class="faint">(optional)</span></label>
        <select id="ed_deal"><option value="">— none —</option>
          ${deals.map(d => `<option value="${esc(d.id)}" ${ed.dealId === d.id ? 'selected' : ''}>${esc(d.nickname || d.propertyName || d.id)}</option>`).join('')}
        </select><div class="hint">Can be set or changed later.</div></div>
    </div>
    <div class="row2" id="edPost" ${ed.record === 'yes' ? '' : 'hidden'}>
      <div class="field"><label for="ed_acc">Income head</label>
        <select id="ed_acc">${INVOICE_ACCS.map(c => `<option value="${c}" ${ed.acc === c ? 'selected' : ''}>${c} · ${esc(A[c]?.name || c)}</option>`).join('')}</select></div>
      <div class="field"><label for="ed_via">Received</label>
        <select id="ed_via">
          <option value="later" ${ed.via === 'later' ? 'selected' : ''}>Not yet — the client will pay later</option>
          <option value="1000" ${ed.via === '1000' ? 'selected' : ''}>Now — into Bank</option>
          <option value="1010" ${ed.via === '1010' ? 'selected' : ''}>Now — into Petty cash</option>
        </select></div>
    </div>
    <div class="field"><label for="ed_notes">Note on the invoice <span class="faint">(optional)</span></label>
      <input type="text" id="ed_notes" value="${esc(ed.notes)}" placeholder="e.g. Payment within 15 days"></div>
    <div id="edProblems"></div>`;
}

function fillBillTo(p) {
  // A client billed before on a hand-made invoice brings what that invoice printed, wherever
  // their record is still empty — and issuing saves it onto the record.
  const k = knownClient(p?.name) || {};
  const pick = f => String(p?.[f] || '').trim() || k[f] || '';
  ed.billTo = { name: p?.name || '', address: pick('address'), gstin: pick('gstin'), state: pick('state'), phone: p?.phone || '', email: p?.email || '' };
  const box = document.getElementById('edBill');
  box.hidden = !ed.party;
  for (const k of ['name', ...BILL_KEYS.map(([x]) => x)]) {
    const el = box.querySelector(`[data-b="${k}"]`);
    if (el) el.value = ed.billTo[k];
  }
  syncPos();
}

function syncPos() {
  const el = document.getElementById('ed_pos');
  if (el && !ed.posTouched) el.value = posOf();
  redrawTotals();
}

function redrawTotals() {
  document.getElementById('edTotals').innerHTML = totalsHtml();
  const no = issueNumber(getState().settings, 'invoice', getState().invoices, ed.date).no;
  const btn = document.getElementById('edIssue');
  if (btn) btn.textContent = `Issue ${no}`;
}

function redrawLines() {
  document.getElementById('edLines').innerHTML = linesHtml();
  wireLines();
  redrawTotals();
}

function wireLines() {
  const box = document.getElementById('edLines');
  box.querySelectorAll('input[data-line]').forEach(el => {
    el.oninput = () => {
      const l = ed.lines[+el.dataset.line];
      const f = el.dataset.f;
      l[f] = el.value;
      // Whichever amount was typed leads; the other follows at the invoice's rate.
      if (f === 'amt' || f === 'gross') {
        const other = f === 'amt' ? 'gross' : 'amt';
        const v = String(el.value).replace(/,/g, '').trim();
        l[other] = v === '' ? '' : String(f === 'amt' ? withGst(v, ed.gstRate) : netOfGst(v, ed.gstRate));
        const sib = box.querySelector(`input[data-line="${el.dataset.line}"][data-f="${other}"]`);
        if (sib) sib.value = l[other];
        l.lead = f;
      }
      redrawTotals();
    };
  });
  // A service fills the line from the list on the Settings tab, and the first line's service
  // decides the income head unless one was picked by hand.
  box.querySelectorAll('select[data-svc]').forEach(el => {
    el.onchange = () => {
      const i = +el.dataset.svc;
      const l = ed.lines[i];
      const x = invoiceServices()[+el.value];
      l.svc = el.value;
      if (x) {
        l.desc = x.desc ? x.desc + ' ' : l.desc;
        l.sac = x.sac || l.sac;
        if (num(x.price) > 0) { l.amt = String(num(x.price)); l.gross = String(withGst(x.price, ed.gstRate)); l.lead = 'amt'; }
        if (i === 0 && !ed.accTouched) {
          ed.acc = x.acc || ed.acc;
          const acc = document.getElementById('ed_acc');
          if (acc) acc.value = ed.acc;
        }
      }
      redrawLines();
      const d = document.querySelector(`#edLines input[data-line="${i}"][data-f="desc"]`);
      if (d) { d.focus(); d.setSelectionRange(d.value.length, d.value.length); }
    };
  });
  box.querySelectorAll('[data-drop]').forEach(b => {
    b.onclick = () => { ed.lines.splice(+b.dataset.drop, 1); redrawLines(); };
  });
}

// Everyone who can be billed, clients first and A to Z — then a client from the hand-made
// invoices the app has no record of yet, offered to add with their details.
function clientChoices(q = '') {
  const s = getState();
  const want = String(q).trim().toLowerCase();
  const hit = p => !want || (p.name + ' ' + (p.gstin || '') + ' ' + (p.phone || '')).toLowerCase().includes(want);
  const list = s.parties.filter(p => !p.__pending && p.name && p.name !== '__account_request' && hit(p))
    .sort((a, b) => ((a.type === 'client' ? 0 : 1) - (b.type === 'client' ? 0 : 1)) || a.name.localeCompare(b.name))
    .slice(0, 50);
  const missing = KNOWN_CLIENTS.filter(k => !s.parties.some(p => k.match.test(p.name || '')) && (!want || k.name.toLowerCase().includes(want) || k.match.test(want)))
    .map(k => ({ __new: true, known: true, name: k.name }));
  return [...missing, ...list];
}

function mountEditor() {
  const s = getState();
  picker(document.getElementById('edParty'), {
    value: typeof ed.party === 'string' ? s.parties.find(p => p.id === ed.party) : ed.party,
    placeholder: 'Search or add a client',
    allowNew: true,
    newLabel: 'Add client',
    describe: p => p.__new ? `${p.name} (${p.known ? 'from invoice 056 — adds them' : 'new client'})`
      : `${p.name}${p.gstin ? ' · ' + p.gstin : p.phone ? ' · ' + p.phone : ''}${p.type && p.type !== 'client' ? ' · ' + p.type : ''}`,
    search: async q => clientChoices(q),
    onChange: v => {
      ed.party = v ? (v.__new ? { __new: true, name: v.name, type: 'client' } : v.id) : null;
      fillBillTo(v && !v.__new ? v : v ? { name: v.name } : null);
    },
  });
  document.querySelectorAll('#edBill [data-b]').forEach(el => {
    el.oninput = () => { ed.billTo[el.dataset.b] = el.value; if (el.dataset.b === 'state') syncPos(); };
  });
  const on = (id, fn, ev = 'input') => { const el = document.getElementById(id); if (el) el.addEventListener(ev, () => fn(el)); };
  on('ed_date', el => { ed.date = el.value; redrawTotals(); });
  on('ed_due', el => { ed.dueDate = el.value; });
  on('ed_pos', el => { ed.placeOfSupply = el.value; ed.posTouched = true; redrawTotals(); });
  on('ed_notes', el => { ed.notes = el.value; });
  on('ed_rate', el => {
    ed.gstRate = num(el.value);
    // A new rate keeps whichever figure each line was typed in, and works the other out again.
    for (const l of ed.lines) {
      if (l.lead === 'gross' && String(l.gross).trim() !== '') l.amt = String(netOfGst(l.gross, ed.gstRate));
      else if (String(l.amt).trim() !== '') l.gross = String(withGst(l.amt, ed.gstRate));
    }
    redrawLines();
  }, 'change');
  on('ed_books', el => { ed.record = el.value; document.getElementById('edPost').hidden = el.value !== 'yes'; }, 'change');
  on('ed_deal', el => { ed.dealId = el.value; }, 'change');
  on('ed_acc', el => { ed.acc = el.value; ed.accTouched = true; }, 'change');
  on('ed_via', el => { ed.via = el.value; }, 'change');
  document.getElementById('edAdd').onclick = () => {
    ed.lines.push(blankLine());
    redrawLines();
    document.querySelector(`#edLines input[data-line="${ed.lines.length - 1}"][data-f="desc"]`)?.focus();
  };
  wireLines();
  redrawTotals();
}

function openEditor(preset = {}) {
  const t = today();
  ed = {
    party: null, billTo: { name: '', address: '', gstin: '', state: '', phone: '', email: '' },
    date: t, dueDate: '', placeOfSupply: '', posTouched: false, gstRate: 18,
    lines: [blankLine()], record: 'yes', acc: '4020', via: 'later', dealId: '', notes: '', busy: false,
    ...preset,
  };
  modal({
    title: 'New invoice',
    body: editorBody(),
    foot: `<button class="btn ghost" type="button" onclick="finInvoices.preview()">Preview PDF</button>
      <div class="spacer"></div>
      <button class="btn" type="button" onclick="fin.closeModal()">Cancel</button>
      <button class="btn primary" type="button" id="edIssue" onclick="finInvoices.issue()">Issue</button>`,
    onClose: () => { ed = null; },
  });
  document.querySelector('#ov .modal')?.classList.add('wide');
  mountEditor();
  // Opened for a client (the Invoice button on their row): their billing details, filled.
  if (typeof ed.party === 'string') fillBillTo(getState().parties.find(p => p.id === ed.party));
}

// The PDF is generated the moment an invoice is issued and filed against it (Drive or Storage,
// whichever Settings says), so the copy sent is the copy kept. A failure here never undoes the
// invoice — it says so, and "Save PDF" under Manage tries again.
async function storePdf(id) {
  const inv = getState().invoices.find(i => i.id === id);
  if (!inv) return false;
  const blob = await renderInvoicePdf(modelFor(inv));
  const name = String(inv.invoiceNo || id).replace(/\//g, '-') + '.pdf';
  const up = await SY.uploadAttachment(new File([blob], name, { type: 'application/pdf' }), 'invoice-' + id);
  await SY.attachInvoicePdf(id, up.url, 'pdfPath');
  return true;
}

function manageBody(inv) {
  const s = getState();
  const entry = inv.txnId ? s.txns.find(t => t.id === inv.txnId) : null;
  const deals = [...s.deals].sort((a, b) => String(a.nickname || '').localeCompare(String(b.nickname || '')));
  const cn = inv.kind === 'creditnote';
  const entries = inv.unposted ? SY.entriesForInvoice(inv) : [];
  return `
    <p class="small muted" style="margin-top:0">${esc(pname(inv.partyId))} · ${fmt(inv.total)} · ${esc(inv.date)}</p>
    <h3>In the books</h3>
    ${inv.unposted ? `
      <p>Issued as a document only — not in your income, what is owed, or GST yet.</p>
      <div class="row2">
        <div class="field"><label for="mg_acc">Income head</label>
          <select id="mg_acc">${INVOICE_ACCS.map(c => `<option value="${c}" ${(inv.acc || '4020') === c ? 'selected' : ''}>${c} · ${esc(A[c]?.name || c)}</option>`).join('')}</select></div>
        <div class="field"><label for="mg_via">Received</label>
          <select id="mg_via"><option value="later">Not yet — the client will pay later</option>
            <option value="1000">Already — into Bank</option><option value="1010">Already — into Petty cash</option></select></div>
      </div>
      <div class="actions"><button class="btn primary" type="button" onclick="finInvoices.post('${esc(inv.id)}')">Record it in the books</button></div>
      ${entries.length ? `
        <div class="field" style="margin-top:16px"><label for="mg_entry">…or attach it to income already recorded</label>
          <select id="mg_entry">${entries.slice(0, 40).map(t => `<option value="${esc(t.id)}">#${esc(t.no ?? '')} · ${esc(t.date)} · ${esc(t.desc)} · ${fmt((t.lines || []).filter(l => /^4/.test(String(l.acc))).reduce((a, l) => a + num(l.cr), 0))}</option>`).join('')}</select>
          <div class="hint">Nothing new is posted — the entry already says it. Use this when the income was recorded before the invoice was made.</div></div>
        <div class="actions"><button class="btn" type="button" onclick="finInvoices.attach('${esc(inv.id)}')">Attach to this entry</button></div>` : ''}`
    : cn ? `<p>A credit note — it is in the books through the reversal that raised it.</p>`
      : `<p>Recorded${entry ? ` in entry <b>#${esc(entry.no ?? '')}</b> — ${esc(entry.desc || '')}` : ''}.
        <button class="btn ghost sm" type="button" onclick="fin.closeModal();fin.openTxn('${esc(inv.txnId || '')}')" ${inv.txnId ? '' : 'disabled'}>Open the entry</button></p>
        ${inv.linkedEntry ? `<div class="actions"><button class="btn ghost" type="button" onclick="finInvoices.detach('${esc(inv.id)}')">Detach from the entry</button></div>` : ''}`}

    ${cn ? '' : `<h3>Deal</h3>
    <div class="field"><select id="mg_deal" aria-label="Deal"><option value="">— none —</option>
      ${deals.map(d => `<option value="${esc(d.id)}" ${inv.dealId === d.id ? 'selected' : ''}>${esc(d.nickname || d.propertyName || d.id)}</option>`).join('')}
    </select><div class="hint">A label on the invoice. An entry already posted keeps its own lines.</div></div>
    <div class="actions"><button class="btn" type="button" onclick="finInvoices.setDeal('${esc(inv.id)}')">Save deal</button></div>`}

    <h3>PDF</h3>
    <p class="small">${inv.pdfPath ? `Saved copy: <a href="${esc(inv.pdfPath)}" target="_blank" rel="noopener">open</a>.` : 'No saved copy yet.'}
      ${inv.uploadedPath ? ` Your own: <a href="${esc(inv.uploadedPath)}" target="_blank" rel="noopener">open</a>.` : ''}</p>
    <div class="actions">
      <button class="btn" type="button" onclick="finInvoices.store('${esc(inv.id)}')">${inv.pdfPath ? 'Save a fresh PDF' : 'Save PDF'}</button>
      <button class="btn ghost" type="button" onclick="fin.closeModal();finInvoices.upload('${esc(inv.id)}')">Upload my own</button>
    </div>`;
}

// The clients, with what prints on their invoices — so a missing address or GSTIN is seen
// here, not on a PDF already sent. Anyone billed so far counts, whatever their type.
function clientsSection() {
  const s = getState();
  const billed = new Set(s.invoices.map(i => i.partyId));
  const list = s.parties.filter(p => !p.__pending && p.name && p.name !== '__account_request' && (p.type === 'client' || billed.has(p.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const todo = KNOWN_CLIENTS.filter(k => !s.parties.some(p => k.match.test(p.name || '')));
  return `
    <h2 style="margin-top:32px">Your clients <span class="muted">(${list.length})</span></h2>
    ${todo.length ? note(`<b>${esc(todo.map(k => k.name).join(', '))}</b> ${todo.length === 1 ? 'is' : 'are'} on your hand-made invoices but not here yet.
      <div class="actions" style="margin:10px 0 0">${todo.map(k => `<button class="btn" type="button" onclick="finInvoices.addKnown(${esc(JSON.stringify(k.name))})">Add ${esc(k.name)}</button>`).join('')}</div>`, 'info') : ''}
    ${list.length ? table(
    `<th>Client</th><th>GSTIN</th><th>Address</th><th>Phone</th><th></th>`,
    list.map(p => `<tr>
        <td class="lead">${esc(p.name)}</td>
        <td class="small" data-label="GSTIN">${p.gstin ? esc(p.gstin) : '<span class="faint">—</span>'}</td>
        <td class="small" data-label="Address">${p.address ? esc(p.address) : '<span class="faint">missing</span>'}</td>
        <td class="small" data-label="Phone">${esc(p.phone || '—')}</td>
        <td class="n nowrap">
          <button class="btn ghost sm" type="button" onclick="finAdmin.editParty('${esc(p.id)}')">Edit</button>
          <button class="btn ghost sm" type="button" onclick="finInvoices.create({party:'${esc(p.id)}'})">Invoice</button>
        </td></tr>`).join(''), '', { stack: true })
    : empty('No clients yet. Add one, or pick “Add client” on a new invoice.', '<button class="btn" type="button" onclick="finAdmin.editParty()">Add a client</button>')}`;
}

export function mountInvoices() {
  const input = document.getElementById('invUpload');
  if (!input) return;
  input.onchange = async e => {
    const file = e.target.files[0];
    const id = input.dataset.invoiceId;
    e.target.value = '';
    if (!file || !id) return;
    toast('Uploading…');
    try {
      const up = await SY.uploadAttachment(file, 'invoice-' + id);
      await SY.attachInvoicePdf(id, up.url, 'uploadedPath');
      toast('Your invoice is attached — the generated one is kept too');
    } catch (err) {
      toast(err.message || 'Upload failed');
    }
  };
}

if (typeof window !== 'undefined') {
  window.finInvoices = {
    create(preset) { openEditor(preset); },

    async preview() {
      if (!ed) return;
      const v = edValues();
      const t = invoiceTotals(v.items, v.gstRate, v.placeOfSupply);
      const s = getState();
      try {
        await downloadInvoice(invoiceModel({
          invoice: { kind: 'direct', ...v, items: t.items, base: t.base, cgst: t.cgst, sgst: t.sgst, igst: t.igst, total: t.total, partyId: typeof v.party === 'string' ? v.party : null },
          party: typeof v.party === 'string' ? s.parties.find(p => p.id === v.party) : { name: v.billTo.name },
          deal: v.dealId ? deal(v.dealId) : null,
          settings: s.settings,
        }));
      } catch (e) { toast(e.message || 'Could not build the PDF'); }
    },

    async issue() {
      if (!ed || ed.busy) return;
      const v = edValues();
      const problems = validateEvent('raiseinv', v).filter(p => !p.warn);
      const box = document.getElementById('edProblems');
      if (problems.length) {
        box.innerHTML = problems.map(p => `<div class="ferr err" style="margin-bottom:8px">${esc(p.msg)}</div>`).join('');
        return;
      }
      box.innerHTML = '';
      ed.busy = true;
      const btn = document.getElementById('edIssue');
      if (btn) { btn.disabled = true; btn.textContent = 'Issuing…'; }
      try {
        const r = ed.record === 'yes' ? await SY.save('raiseinv', v) : await SY.issueInvoice(v);
        closeModal();
        toast(`${r.invoiceNo} issued — saving its PDF…`);
        try {
          await storePdf(r.invoiceId);
          toast(`${r.invoiceNo} issued and its PDF saved`, { label: 'View', run: () => window.finInvoices.view(r.invoiceId) });
        } catch (e) {
          toast(`${r.invoiceNo} issued, but the PDF could not be saved: ${e.message || 'try Manage → Save PDF'}`);
        }
      } catch (e) {
        if (ed) ed.busy = false;
        if (btn) { btn.disabled = false; redrawTotals(); }
        box.innerHTML = `<div class="ferr err">${esc(e.message || 'Could not issue the invoice')}</div>`;
      }
    },

    // A client from the hand-made invoices, added with what those invoices print.
    async addKnown(name) {
      const k = knownClient(name);
      if (!k) return;
      try {
        await SY.saveParty(null, { name: k.name, type: k.type, address: k.address, gstin: k.gstin, state: k.state });
        toast(`${k.name} added`);
      } catch (e) { toast(e.message || 'Could not add them'); }
    },

    manage(id) {
      const inv = getState().invoices.find(i => i.id === id);
      if (!inv) return;
      modal({ title: inv.invoiceNo || 'Invoice', body: manageBody(inv) });
    },

    // Record a document-only invoice in the books: the same event a new one goes through, told
    // which invoice it is, so it keeps its number and nothing is issued twice.
    async post(id) {
      const inv = getState().invoices.find(i => i.id === id);
      if (!inv) return;
      try {
        await SY.save('raiseinv', {
          invoiceId: inv.id, party: inv.partyId, date: inv.date, dueDate: inv.dueDate,
          items: inv.items, gstRate: inv.gstRate, placeOfSupply: inv.placeOfSupply, billTo: inv.billTo,
          dealId: inv.dealId, notes: inv.notes,
          acc: document.getElementById('mg_acc')?.value || inv.acc || '4020',
          via: document.getElementById('mg_via')?.value || 'later',
        });
        closeModal();
        toast(`${inv.invoiceNo} is in the books`);
      } catch (e) { toast(e.message || 'Could not record it'); }
    },

    async attach(id) {
      const txnId = document.getElementById('mg_entry')?.value;
      if (!txnId) return;
      try {
        await SY.linkInvoiceToEntry(id, txnId);
        closeModal();
        toast('Attached to the entry');
      } catch (e) { toast(e.message || 'Could not attach it'); }
    },

    async detach(id) {
      try {
        await SY.detachInvoice(id);
        closeModal();
        toast('Detached — it is a document only again');
      } catch (e) { toast(e.message || 'Could not detach it'); }
    },

    async setDeal(id) {
      try {
        await SY.setInvoiceDeal(id, document.getElementById('mg_deal')?.value || null);
        closeModal();
        toast('Deal saved');
      } catch (e) { toast(e.message || 'Could not save the deal'); }
    },
    async view(id) {
      const inv = getState().invoices.find(i => i.id === id);
      if (!inv) return;
      // An invoice the user uploaded themselves wins over the generated one — they replaced it
      // for a reason.
      if (inv.uploadedPath) { window.open(inv.uploadedPath, '_blank', 'noopener'); return; }
      toast('Building the PDF…');
      try {
        await downloadInvoice(modelFor(inv));
      } catch (e) { toast(e.message || 'Could not build the PDF'); }
    },

    async share(id) {
      const inv = getState().invoices.find(i => i.id === id);
      if (!inv) return;
      try {
        const how = await shareInvoice(modelFor(inv));
        toast(how === 'shared' ? 'Shared' : 'Downloaded');
      } catch (e) { toast(e.message || 'Could not share'); }
    },

    async renumber(id) {
      const inv = getState().invoices.find(i => i.id === id);
      if (!inv) return;
      const ok = await confirmDialog({
        title: `Give ${inv.invoiceNo} a new number?`,
        message: `This ${inv.kind === 'creditnote' ? 'credit note' : 'invoice'} for <b>${esc(pname(inv.partyId))}</b> (${fmt(inv.total)}, ${esc(inv.date)})
          shares its number with an earlier one. It takes the next free number; the old one is noted on it.
          If you have already sent this PDF, send the client the new one.`,
        confirmLabel: 'Give it a new number',
      });
      if (!ok) return;
      try {
        const no = await SY.renumberInvoice(id);
        toast(`Now ${no}`);
      } catch (e) { toast(e.message || 'Could not renumber'); }
    },

    upload(id) {
      const input = document.getElementById('invUpload');
      input.dataset.invoiceId = id;
      input.click();
    },

    // Generates the PDF and files it in Storage/Drive against the invoice, so the same
    // document is retrievable later rather than only living in the browser's downloads.
    async store(id) {
      toast('Saving the PDF…');
      try {
        await storePdf(id);
        closeModal();
        toast('PDF saved');
      } catch (e) { toast(e.message || 'Could not save the PDF'); }
    },
  };
}
