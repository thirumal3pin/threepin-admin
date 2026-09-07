// ═══════ INVOICES ═══════
//
// Invoices are created automatically when a deal is closed with GST on it — the number comes
// from a counter incremented inside a Firestore transaction, so it can never be duplicated.
// This view is where they are viewed, shared and, if you raised one elsewhere, replaced.

import {
  fmt, esc, num, today, getState, bal, pname, dname, deal,
  invoiceOutstanding,
} from './finance-core.js';
import { empty, note, tag, table, toast, modal, closeModal, dueCell } from './ui.js';
import { invoiceModel, downloadInvoice, shareInvoice, renderInvoicePdf } from './finance-invoice.js';
import * as SY from './finance-sync.js';

// An invoice's status is derived from the payments allocated to it (its `paid` figure). An
// invoice from before allocations existed has no such figure, so for those it falls back to
// whatever the client still owes on that deal.
function statusOf(inv) {
  if (inv.kind === 'creditnote') return { key: 'cn', label: 'Credit note', cls: 'rev' };
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
      ${note('An invoice is raised for you automatically when you record <b>Deal closed</b> with GST on it. You do not create one by hand.', 'info')}
      ${empty('<b>No invoices yet.</b><br>Close a deal and the GST invoice is generated, numbered and stored for you.',
      '<button class="btn primary" type="button" onclick="fin.record(\'invoice\')">Record a closed deal</button>')}`;
  }

  // A missing GSTIN or bank account does not block anything, but it does make the PDF wrong,
  // so it is surfaced here rather than discovered by a client.
  const gaps = modelFor(s.invoices[0]).missing || [];
  const rows = [...s.invoices].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.invoiceNo).localeCompare(String(a.invoiceNo)));
  const isCn = i => i.kind === 'creditnote';
  const total = rows.filter(i => !isCn(i)).reduce((a, i) => a + num(i.total), 0) - rows.filter(isCn).reduce((a, i) => a + num(i.total), 0);
  // What is still to come in is what each invoice has left on it, not its face value — a
  // part-paid invoice is not still owed in full.
  const unpaid = rows
    .filter(i => !isCn(i) && !['paid', 'void'].includes(statusOf(i).key))
    .reduce((a, i) => a + (i.paid !== undefined ? invoiceOutstanding(i) : num(i.total)), 0);

  return `
    <h1>Invoices</h1>
    <p class="lead">${rows.filter(i => !isCn(i)).length} invoices${rows.some(isCn) ? ` and ${rows.filter(isCn).length} credit note${rows.filter(isCn).length === 1 ? '' : 's'}` : ''}, ${fmt(total)} net. Deal brokerage and other income both raise invoices; reversing an invoiced entry issues a credit note against it.</p>
    ${gaps.length ? note(
    `<b>Your invoices are missing ${gaps.length === 1 ? 'a detail' : 'some details'}:</b> ${esc(gaps.join(', '))}.
       Fill these in on the <a href="#profile" onclick="fin.go('profile');return false">Profile tab</a> — every PDF you
       generate until then will be incomplete.`) : ''}

    ${table(
    `<th>Number</th><th>Date</th><th>Client</th><th>Deal</th><th class="n">Total</th><th>Due</th><th>Status</th><th></th>`,
    rows.map(inv => {
      const st = statusOf(inv);
      return `<tr>
          <td class="lead nowrap">${esc(inv.invoiceNo || '—')}
            ${inv.kind === 'creditnote' ? `<br><span class="small faint">against ${esc(inv.against || '')}</span>` : inv.kind === 'other' ? tag('other income') : tag('brokerage')}
            ${s.parties.find(p => p.id === inv.partyId)?.gstin ? tag('B2B', 'ok') : ''}</td>
          <td class="nowrap small" data-label="Date">${esc(inv.date)}</td>
          <td data-label="Client">${esc(pname(inv.partyId))}</td>
          <td class="small" data-label="For">${inv.dealId ? esc(dname(inv.dealId)) : esc(inv.desc || '—')}</td>
          <td class="n" data-label="Total">${fmt(inv.total)}
            ${inv.paid > 0.005 && st.key !== 'paid' ? `<br><span class="small neg">${fmt(invoiceOutstanding(inv))} left</span>` : ''}
            <br><span class="small faint">${inv.igst ? 'IGST' : 'CGST+SGST'}</span></td>
          <td class="small nowrap" data-label="Due">${isCn(inv) || !inv.dueDate ? '—' : dueCell(inv.dueDate)}</td>
          <td data-label="Status">${tag(st.label, st.cls)}
            ${paymentsFor(inv)}</td>
          <td class="n nowrap">
            <button class="btn ghost sm" type="button" onclick="finInvoices.view('${esc(inv.id)}')">View PDF</button>
            <button class="btn ghost sm" type="button" onclick="finInvoices.share('${esc(inv.id)}')">Share</button>
            <button class="btn ghost sm" type="button" onclick="finInvoices.upload('${esc(inv.id)}')">Upload my own</button>
          </td></tr>`;
    }).join(''),
    `<tr><td colspan="4" data-label="Total raised">Total raised</td><td class="n">${fmt(total)}</td><td colspan="3"></td></tr>
       <tr><td colspan="4" data-label="Still to collect">Still to collect</td><td class="n">${fmt(unpaid)}</td><td colspan="3"></td></tr>`, { stack: true })}

    <input type="file" id="invUpload" accept="application/pdf" hidden>`;
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

    upload(id) {
      const input = document.getElementById('invUpload');
      input.dataset.invoiceId = id;
      input.click();
    },

    // Generates the PDF and files it in Storage/Drive against the invoice, so the same
    // document is retrievable later rather than only living in the browser's downloads.
    async store(id) {
      const inv = getState().invoices.find(i => i.id === id);
      if (!inv) return;
      toast('Storing…');
      try {
        const blob = await renderInvoicePdf(modelFor(inv));
        const name = String(inv.invoiceNo || id).replace(/\//g, '-') + '.pdf';
        const file = new File([blob], name, { type: 'application/pdf' });
        const up = await SY.uploadAttachment(file, 'invoice-' + id);
        await SY.attachInvoicePdf(id, up.url, 'pdfPath');
        toast('Stored');
      } catch (e) { toast(e.message || 'Could not store the PDF'); }
    },
  };
}
