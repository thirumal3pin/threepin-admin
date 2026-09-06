// ═══════ INVOICES ═══════
//
// Invoices are created automatically when a deal is closed with GST on it — the number comes
// from a counter incremented inside a Firestore transaction, so it can never be duplicated.
// This view is where they are viewed, shared and, if you raised one elsewhere, replaced.

import {
  fmt, esc, num, today, getState, bal, pname, dname, deal,
} from './finance-core.js';
import { empty, note, tag, table, toast, modal, closeModal } from './ui.js';
import { invoiceModel, downloadInvoice, shareInvoice, renderInvoicePdf } from './finance-invoice.js';
import * as SY from './finance-sync.js';

// Paid / part-paid / unpaid is not stored — it is whatever the client still owes on that deal
// right now. Storing it would mean two sources of truth that drift apart.
function statusOf(inv) {
  const outstanding = bal('1100', { party: inv.partyId, deal: inv.dealId });
  if (outstanding <= 0.5) return { key: 'paid', label: 'Paid', cls: 'ok' };
  if (outstanding < num(inv.total) - 0.5) return { key: 'part', label: 'Part paid', cls: 'warn' };
  return { key: 'unpaid', label: 'Unpaid', cls: '' };
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
  const rows = [...s.invoices].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const total = rows.reduce((a, i) => a + num(i.total), 0);
  const unpaid = rows.filter(i => statusOf(i).key !== 'paid').reduce((a, i) => a + num(i.total), 0);

  return `
    <h1>Invoices</h1>
    <p class="lead">${rows.length} raised, ${fmt(total)} in total.</p>
    ${gaps.length ? note(
    `<b>Your invoices are missing ${gaps.length === 1 ? 'a detail' : 'some details'}:</b> ${esc(gaps.join(', '))}.
       Fill these in on the <a href="#profile" onclick="fin.go('profile');return false">Profile tab</a> — every PDF you
       generate until then will be incomplete.`) : ''}

    ${table(
    `<th>Number</th><th>Date</th><th>Client</th><th>Deal</th><th class="n">Total</th><th>Status</th><th></th>`,
    rows.map(inv => {
      const st = statusOf(inv);
      return `<tr>
          <td class="nowrap"><b>${esc(inv.invoiceNo || '—')}</b></td>
          <td class="nowrap small">${esc(inv.date)}</td>
          <td>${esc(pname(inv.partyId))}</td>
          <td class="small">${esc(dname(inv.dealId))}</td>
          <td class="n">${fmt(inv.total)}
            <br><span class="small faint">${inv.igst ? 'IGST' : 'CGST+SGST'}</span></td>
          <td>${tag(st.label, st.cls)}</td>
          <td class="n nowrap">
            <button class="btn ghost sm" type="button" onclick="finInvoices.view('${esc(inv.id)}')">View PDF</button>
            <button class="btn ghost sm" type="button" onclick="finInvoices.share('${esc(inv.id)}')">Share</button>
            <button class="btn ghost sm" type="button" onclick="finInvoices.upload('${esc(inv.id)}')">Upload my own</button>
          </td></tr>`;
    }).join(''),
    `<tr><td colspan="4">Total raised</td><td class="n">${fmt(total)}</td><td colspan="2"></td></tr>
       <tr><td colspan="4">Still unpaid</td><td class="n">${fmt(unpaid)}</td><td colspan="2"></td></tr>`)}

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
