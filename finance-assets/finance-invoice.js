// ═══════ 3 PIN REALTY — FINANCE INVOICE ═══════
//
// The printable half of the invoice event. finance-events.js decides WHAT is invoiced (and
// leaves an `invoice` object on the transaction); this module turns that object into a
// one-page A4 GST tax invoice the client can be sent.
//
// Two layers on purpose:
//   invoiceModel()     pure — no jsPDF, no DOM, no Firestore. Runs under `node --test`
//                      beside the finance-core tests, so the numbers on the paper can be
//                      asserted without ever rendering a PDF.
//   renderInvoicePdf() the only part that needs a browser, because it needs jsPDF.
//
// Nothing here reads or writes Firestore: the caller passes in the documents it already
// holds in finance-core's in-memory state, and getState() is only a fallback for the bits
// it did not pass.

import {
  fmt, num, words, esc, splitGst, getState, pname, dname, today,
} from './finance-core.js';

// ═══════ jsPDF LOADER ═══════
//
// jsPDF is ~350 KB and only ever needed the moment someone actually prints an invoice —
// which most sessions never do. So it is not in the repo and not in index.html: it is
// fetched from the CDN on first use and then memoised for the life of the page.

const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

let jsPdfPromise = null;

async function loadJsPdf() {
  // Guarded rather than referenced at module top level: this file gets syntax-checked and
  // imported under Node, where `window` does not exist.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('PDF generation needs a browser — jsPDF cannot load here.');
  }

  // Already on the page (a previous call, or another module that loaded the same script).
  // Checking this first also stops us waiting forever on a 'load' event that already fired.
  if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;

  if (!jsPdfPromise) {
    jsPdfPromise = new Promise((resolve, reject) => {
      // Reuse the tag if one is already in flight, so a double click on "Print" injects once.
      const existing = document.querySelector('script[data-jspdf]');
      const tag = existing || document.createElement('script');

      tag.addEventListener('load', () => {
        if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
        else reject(new Error('jsPDF loaded but did not register window.jspdf — CDN file may have changed.'));
      });
      tag.addEventListener('error', () => {
        reject(new Error('Could not load jsPDF from ' + JSPDF_URL + ' — check the internet connection and try again.'));
      });

      if (!existing) {
        tag.dataset.jspdf = '1';
        tag.async = true;
        tag.src = JSPDF_URL;
        document.head.appendChild(tag);
      }
    });
    // Drop the memo on failure so the next attempt (back online) can retry instead of
    // replaying the same rejection forever.
    jsPdfPromise.catch(() => { jsPdfPromise = null; });
  }
  return jsPdfPromise;
}

// ═══════ NUMBER + DATE FORMATTING FOR PRINT ═══════

// Deliberately NOT fmt(). fmt() prefixes '₹' (U+20B9), and jsPDF's built-in Helvetica is a
// Latin-1 font with no rupee glyph — it silently prints garbage (usually a stray accent).
// Embedding a Unicode font would add ~400 KB to the CDN payload for one character, so the
// PDF says "Rs." instead. Same Indian digit grouping as fmt(), plus paise, because an
// invoice is read line by line by the client's accountant.
function money(n) {
  const v = num(n);
  const [whole, paise] = Math.abs(v).toFixed(2).split('.');
  const grouped = whole.length > 3
    ? whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3)
    : whole;
  return (v < 0 ? '-' : '') + 'Rs. ' + grouped + '.' + paise;
}

// Model dates stay ISO ('YYYY-MM-DD') like every other date in the finance module — the
// conversion to the dd-mm-yyyy an Indian invoice is expected to show happens at print time.
const dmy = iso => {
  const [y, m, d] = String(iso || '').split('-');
  return d ? `${d}-${m}-${y}` : String(iso || '');
};

// ═══════ INVOICE NUMBER ═══════

// Pure, so the Settings screen can preview the next number without touching the counter.
// A missing counter means the first invoice, not #000.
export function nextInvoiceNumber(settings = {}) {
  return (settings.invoicePrefix || '') + String(num(settings.nextInvoiceNo) || 1).padStart(3, '0');
}

// ═══════ MODEL ═══════
//
// Everything the paper needs, resolved once, as plain data. Keeping this separate from the
// drawing means a layout change can never quietly change a figure.

export function invoiceModel({ invoice, party, deal, settings } = {}) {
  const inv = invoice || {};
  const st = settings || getState().settings || {};
  const p = party || null;
  const d = deal || null;

  const company = {
    name: st.companyName || '3 PIN Realty Pvt Ltd',
    address: st.address || '',
    gstin: st.gstin || '',
    phone: st.phone || '',
    email: st.email || '',
    state: st.state || 'Tamil Nadu',
  };

  // A saved invoice keeps the number it was issued with; an unsaved preview shows the one
  // it would get. Never renumber a stored invoice — that is the whole point of the counter.
  const invoiceNo = inv.no || inv.invoiceNo || nextInvoiceNumber(st);
  const date = inv.date || today();

  const billTo = {
    name: p?.name || pname(inv.partyId),
    phone: p?.phone || '',
    gstin: p?.gstin || '',
    address: p?.address || '',
    state: p?.state || '',
  };

  // For brokerage the place of supply is where the PROPERTY is (IGST Act s.12(3)), not the
  // client's address. It is stored on the invoice when it is raised; older records fall back
  // to the deal, then to the company's own state.
  const placeOfSupply = inv.placeOfSupply || d?.propertyState || company.state;

  const dealInfo = {
    nickname: d?.nickname || (inv.dealId ? dname(inv.dealId) : ''),
    propertyCode: d?.propertyCode || '',
    propertyName: d?.propertyName || '',
  };

  const taxable = num(inv.base ?? inv.taxable);
  const rate = num(inv.gstRate ?? st.gstRate) || 18;

  const item = {
    desc: inv.desc || 'Brokerage / consultancy services',
    sac: inv.sac || st.sacCode || '997221',
    taxable,
  };

  // Prefer the split that was stored with the transaction: it is what was actually posted
  // to 2200 GST payable, and re-deriving it from today's settings could disagree with the
  // ledger if the client's state or the rate was edited after the fact.
  const stored = inv.cgst != null || inv.sgst != null || inv.igst != null;
  const split = stored
    ? { cgst: num(inv.cgst), sgst: num(inv.sgst), igst: num(inv.igst) }
    : splitGst(taxable, rate, placeOfSupply, company.state);

  const taxTotal = num(split.cgst) + num(split.sgst) + num(split.igst);
  const tax = {
    rate,
    cgst: num(split.cgst), sgst: num(split.sgst), igst: num(split.igst),
    // Half rates for the CGST/SGST pair, full rate on IGST — printed next to each amount.
    halfRate: rate / 2,
    total: taxTotal,
  };

  const total = num(inv.total) || taxable + taxTotal;
  const bd = st.bankDetails || {};
  const bank = {
    bankName: bd.bankName || '',
    accountName: bd.accountName || company.name,
    accountNo: bd.accountNo || '',
    ifsc: bd.ifsc || '',
    branch: bd.branch || '',
  };

  // Fields a GST invoice is not legally valid without, plus the account number the client
  // needs to pay us. Human-readable and HTML-safe because the UI drops these into a warning
  // banner the same way finance-events.js renders its `effects` strings.
  const missing = [];
  if (!company.gstin) missing.push('Company GSTIN');
  if (!company.address) missing.push('Company address');
  if (!item.sac) missing.push('SAC code');
  if (!bank.accountNo) {
    missing.push(bank.bankName ? `Bank account number (${esc(bank.bankName)})` : 'Bank account number');
  }

  return {
    company,
    placeOfSupply,
    docType: inv.kind === 'creditnote' ? 'CREDIT NOTE' : 'TAX INVOICE',
    against: inv.against || '', invoiceNo, date, billTo, deal: dealInfo, item, tax, total,
    totalWords: words(total),
    bank, missing,
  };
}

// ═══════ PDF LAYOUT ═══════
//
// A4 is 210 × 297 mm with 14 mm margins, so the content box is 14 → 196. Everything is
// positioned in mm from the top: one page is a hard constraint (a two-page brokerage
// invoice looks like a mistake), so the long free-text fields are wrapped AND capped.

const M = 14;          // left margin
const R = 196;         // right edge of the content box
const AMT_X = R - 3;   // right-aligned money column
const SAC_X = 129;     // SAC column, left aligned
const COL_AMT = 150;   // where the money column starts
const LBL_X = COL_AMT - 3; // totals labels are right-aligned to just left of the money

// jsPDF's own line spacing is derived from the point size; we step in mm ourselves so the
// block after a wrapped address always starts exactly where we expect it to.
const step = size => size * 0.42;

export async function renderInvoicePdf(model) {
  const JsPDF = await loadJsPdf();
  const m = model || {};
  const company = m.company || {};
  const billTo = m.billTo || {};
  const dl = m.deal || {};
  const item = m.item || {};
  const tax = m.tax || {};
  const bank = m.bank || {};

  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  doc.setProperties({ title: 'Tax invoice ' + (m.invoiceNo || ''), creator: company.name || '' });

  // jsPDF throws on undefined and happily prints "null", so every string goes through here.
  const put = (s, x, y, opt) => {
    const t = String(s ?? '').trim();
    if (t) doc.text(t, x, y, opt);
    return t;
  };
  // Wrapped text with a hard line cap — better a clipped address than a second page.
  const block = (s, x, y, width, size, maxLines = 3) => {
    const t = String(s ?? '').trim();
    if (!t) return y;
    const rows = doc.splitTextToSize(t, width).slice(0, maxLines);
    rows.forEach((row, i) => doc.text(row, x, y + i * step(size)));
    return y + rows.length * step(size);
  };
  const grey = () => doc.setTextColor(115, 115, 115);
  const dark = () => doc.setTextColor(33, 33, 33);
  const font = (weight, size) => { doc.setFont('helvetica', weight); doc.setFontSize(size); };

  // ── brand header band ──
  doc.setFillColor(254, 141, 0);   // #FE8D00
  doc.rect(0, 0, 210, 26, 'F');
  doc.setTextColor(255, 255, 255);
  font('bold', 16);
  put(company.name, M, 14);
  font('bold', 13);
  put(m.docType || 'TAX INVOICE', R, 13, { align: 'right' });
  font('normal', 7.5);
  put('Original for recipient', R, 18.5, { align: 'right' });

  // ── company details ──
  let y = 33;
  grey(); font('normal', 8);
  y = block(company.address, M, y, 112, 8, 2);
  const contact = [
    company.gstin && 'GSTIN: ' + company.gstin,
    company.phone && 'Phone: ' + company.phone,
    company.email,
  ].filter(Boolean).join('   |   ');
  if (contact) { put(contact, M, y); y += step(8); }

  y += 3;
  doc.setDrawColor(225, 225, 225); doc.setLineWidth(0.3);
  doc.line(M, y, R, y);
  y += 7;

  // ── bill to (left) + invoice meta (right) ──
  const top = y;
  grey(); font('bold', 7.5);
  put('BILL TO', M, top);
  dark(); font('bold', 10.5);
  put(billTo.name, M, top + 5.5);

  let ly = top + 10;
  grey(); font('normal', 8);
  const who = [billTo.phone, billTo.gstin && 'GSTIN: ' + billTo.gstin].filter(Boolean).join('   |   ');
  if (who) { put(who, M, ly); ly += step(8); }
  ly = block(billTo.address, M, ly, 100, 8, 3);
  if (billTo.state) { put(billTo.state, M, ly); ly += step(8); }

  // Right column: label left, value right-aligned, so the two values stack cleanly.
  let ry = top;
  const meta = (label, value) => {
    grey(); font('normal', 8);
    put(label, COL_AMT - 26, ry);
    dark(); font('bold', 9);
    put(value, R, ry, { align: 'right' });
    ry += 6;
  };
  meta('Invoice no.', m.invoiceNo);
  meta('Date', dmy(m.date));
  meta('Place of supply', m.placeOfSupply);
  if (m.against) meta('Against invoice', m.against);

  y = Math.max(ly, ry) + 4;

  // ── deal line ──
  const dealBits = [
    dl.nickname,
    [dl.propertyCode, dl.propertyName].filter(Boolean).join(' — '),
  ].filter(Boolean).join('   |   ');
  if (dealBits) {
    grey(); font('normal', 8);
    put('Deal: ' + dealBits, M, y);
    y += 6;
  }

  // ── line item table ──
  const HEAD_H = 8;
  doc.setFillColor(245, 245, 245);
  doc.setDrawColor(200, 200, 200); doc.setLineWidth(0.2);
  doc.rect(M, y, R - M, HEAD_H, 'FD');
  dark(); font('bold', 8.5);
  put('Description', M + 3, y + 5.4);
  put('SAC', SAC_X, y + 5.4);
  put('Taxable value', AMT_X, y + 5.4, { align: 'right' });
  y += HEAD_H;

  const ROW_H = 12;
  doc.rect(M, y, R - M, ROW_H, 'S');
  font('normal', 9); dark();
  block(item.desc, M + 3, y + 5.5, 108, 9, 2);
  font('normal', 8.5);
  put(item.sac, SAC_X, y + 5.5);
  font('normal', 9);
  put(money(item.taxable), AMT_X, y + 5.5, { align: 'right' });
  y += ROW_H + 1;

  // ── tax rows + total, right-aligned under the money column ──
  const rowsRight = [];
  if (num(tax.igst)) {
    rowsRight.push([`IGST @ ${num(tax.rate)}%`, tax.igst]);
  } else {
    rowsRight.push([`CGST @ ${num(tax.halfRate)}%`, tax.cgst]);
    rowsRight.push([`SGST @ ${num(tax.halfRate)}%`, tax.sgst]);
  }
  font('normal', 9); dark();
  for (const [label, amt] of rowsRight) {
    y += 5.5;
    put(label, LBL_X, y, { align: 'right' });
    put(money(amt), AMT_X, y, { align: 'right' });
  }

  y += 3;
  doc.setFillColor(254, 141, 0);
  doc.rect(COL_AMT - 46, y, R - (COL_AMT - 46), 9, 'F');
  doc.setTextColor(255, 255, 255); font('bold', 10);
  put('Total', LBL_X, y + 6, { align: 'right' });
  put(money(m.total), AMT_X, y + 6, { align: 'right' });
  y += 9 + 8;

  // ── amount in words ──
  grey(); font('normal', 8);
  put('Amount in words', M, y);
  dark(); font('bold', 9);
  y = block(m.totalWords, M, y + 5, R - M, 9, 2) + 8;

  // ── bank details ──
  const bankRows = [
    bank.accountName && ['Account name', bank.accountName],
    bank.bankName && ['Bank', bank.bankName + (bank.branch ? ', ' + bank.branch : '')],
    bank.accountNo && ['Account no.', bank.accountNo],
    bank.ifsc && ['IFSC', bank.ifsc],
  ].filter(Boolean);
  if (bankRows.length) {
    const boxH = 8 + bankRows.length * 4.6;
    doc.setDrawColor(225, 225, 225); doc.setLineWidth(0.3);
    doc.rect(M, y, 104, boxH, 'S');
    grey(); font('bold', 7.5);
    put('BANK DETAILS', M + 3, y + 5);
    let by = y + 10;
    for (const [k, v] of bankRows) {
      grey(); font('normal', 8); put(k, M + 3, by);
      dark(); font('normal', 8); put(v, M + 30, by);
      by += 4.6;
    }
    y += boxH;
  }

  // ── signature ──
  // Pinned near the foot of the page, but pushed down if the body ever runs long, so the
  // two blocks can never overlap on a wordy invoice.
  const sigY = Math.max(y + 16, 246);
  dark(); font('normal', 9);
  put('For ' + (company.name || ''), R, sigY, { align: 'right' });
  doc.setDrawColor(160, 160, 160); doc.setLineWidth(0.3);
  doc.line(R - 60, sigY + 18, R, sigY + 18);
  grey(); font('normal', 8);
  put('Authorised signatory', R, sigY + 23, { align: 'right' });

  grey(); font('normal', 7);
  put('This is a computer-generated invoice.', 105, 288, { align: 'center' });

  return doc.output('blob');
}

// ═══════ DELIVERY ═══════

const fileName = model => String(model?.invoiceNo || 'invoice').replace(/\//g, '-') + '.pdf';

// Rendered once and reused by both exits below, so the share fallback never pays to draw
// the same invoice twice.
async function renderNamed(model) {
  const blob = await renderInvoicePdf(model);
  return { blob, name: fileName(model) };
}

function saveBlob(blob, name) {
  if (typeof document === 'undefined') throw new Error('Downloads need a browser.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before the blob is dropped; revoking
  // synchronously cancels the save on Safari.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function downloadInvoice(model) {
  const { blob, name } = await renderNamed(model);
  saveBlob(blob, name);
  return name;
}

// On a phone this opens WhatsApp/Gmail with the PDF attached, which is how these invoices
// actually reach clients. Desktop browsers mostly cannot share files, hence the fallback.
export async function shareInvoice(model) {
  const { blob, name } = await renderNamed(model);

  if (typeof navigator !== 'undefined' && typeof File !== 'undefined' && navigator.canShare) {
    const file = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: 'Tax invoice ' + (model?.invoiceNo || ''),
          // fmt() is fine here (unlike on the PDF) — the OS share sheet renders '₹'.
          text: `Tax invoice ${model?.invoiceNo || ''} — ${fmt(model?.total)}`,
        });
        return 'shared';
      } catch (e) {
        // The user backing out of the share sheet is not a failure: downloading behind
        // their back would be a surprise. Any other error falls through to the download.
        if (e && e.name === 'AbortError') return 'shared';
      }
    }
  }

  saveBlob(blob, name);
  return 'downloaded';
}
