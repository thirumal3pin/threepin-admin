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
  fmtInr, num, words, esc, splitGst, getState, pname, dname, today, issueNumber,
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
// PDF says "Rs." / "INR" instead. Indian digit grouping like fmt(); paise only when there are
// any — "40,000", as the hand-made invoice wrote it.
function amount(n) {
  const v = num(n);
  const [whole, paise] = Math.abs(v).toFixed(2).split('.');
  const grouped = whole.length > 3
    ? whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3)
    : whole;
  return (v < 0 ? '-' : '') + grouped + (paise === '00' ? '' : '.' + paise);
}

// Model dates stay ISO ('YYYY-MM-DD') like every other date in the finance module — the
// conversion to the dd-mm-yyyy an Indian invoice is expected to show happens at print time.
const dmy = iso => {
  const [y, m, d] = String(iso || '').split('-');
  return d ? `${d}-${m}-${y}` : String(iso || '');
};

// ═══════ INVOICE NUMBER ═══════

// The number the next invoice will actually get — the counter's, stepped past any number a
// document already holds — without touching the counter. A missing counter means the first
// invoice, not #000.
export function nextInvoiceNumber(settings = {}, invoices = getState().invoices, date = today()) {
  return issueNumber(settings, 'invoice', invoices, date).no;
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
    name: st.companyName || '3 PIN Realty',
    address: st.address || '',
    gstin: st.gstin || '',
    pan: st.pan || '',
    phone: st.phone || '',
    email: st.email || '',
    state: st.state || 'Tamil Nadu',
  };

  // A saved invoice keeps the number it was issued with; an unsaved preview shows the one
  // it would get. Never renumber a stored invoice — that is the whole point of the counter.
  const date = inv.date || today();
  const invoiceNo = inv.no || inv.invoiceNo || nextInvoiceNumber(st, undefined, date);

  // An invoice raised on the Invoices tab carries the billing details it was issued with, so
  // editing the client later never rewrites an invoice already sent. Older invoices read the
  // client record as it is now.
  const bt = inv.billTo || {};
  const billTo = {
    name: bt.name || p?.name || pname(inv.partyId),
    phone: bt.phone ?? p?.phone ?? '',
    email: bt.email ?? p?.email ?? '',
    gstin: bt.gstin ?? p?.gstin ?? '',
    address: bt.address ?? p?.address ?? '',
    state: bt.state ?? p?.state ?? '',
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
  const rate = num(inv.gstRate ?? st.gstRate ?? 18);
  const sac = inv.sac || st.sacCode || '997221';

  const item = {
    desc: inv.desc || 'Brokerage / consultancy services',
    sac,
    taxable,
  };
  // Numbered lines. An invoice raised by a deal has one, made from its description.
  const items = (inv.items?.length ? inv.items : [{ desc: item.desc, sac, amt: taxable }])
    .map((x, i) => ({ n: i + 1, desc: x.desc || '', sac: x.sac || sac, amt: num(x.amt) }));

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
    // Cheques and DDs are written to this name; usually the account name.
    favour: st.chequeFavour || bd.accountName || company.name,
  };
  // A transparent PNG, uploaded or drawn on the Profile tab. Without one the line is left blank
  // to be signed by hand.
  const signature = /^data:image\/(png|jpeg);base64,/.test(String(st.signature || '')) ? st.signature : '';

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
    // A document with no tax on it is not a tax invoice. A registered person supplying
    // something exempt or outside GST issues a BILL OF SUPPLY (s.31(3)(c)); someone not
    // registered at all issues neither, just an invoice. This used to say TAX INVOICE on
    // everything, which was harmless while every invoice carried GST and wrong the moment one
    // did not — a withdrawal fee is usually compensation rather than a supply, so it carries
    // no tax and would otherwise print a tax invoice showing no tax.
    docType: inv.kind === 'creditnote' ? 'CREDIT NOTE'
      : taxTotal > 0.005 ? 'TAX INVOICE'
        : company.gstin ? 'BILL OF SUPPLY' : 'INVOICE',
    against: inv.against || '', invoiceNo, date, dueDate: inv.kind === 'creditnote' ? '' : (inv.dueDate || ''),
    billTo, deal: dealInfo, item, items, tax, total,
    totalWords: words(total),
    notes: inv.notes || '',
    bank, signature, missing,
  };
}

// ═══════ PDF LAYOUT ═══════
//
// After the invoice 3 PIN sent by hand before this existed: the document title and number
// top left, the logo top right, a dark rule, "Issued on" and "Billed to", a lined table, the
// tax rows and total under it, how to pay bottom left, the signature bottom right, and the
// office address in a band at the foot. In the brand's orange and near-black rather than the
// hand-made one's pastel, and with numbered lines and SAC codes the GST rules ask for.
//
// A4 is 210 × 297 mm with 14 mm margins, so the content box is 14 → 196. One page is a hard
// constraint (a two-page invoice looks like a mistake), so free text is wrapped AND capped.

const M = 14;          // left margin
const R = 196;         // right edge of the content box
const NO_X = M + 2;    // line number
const DESC_X = M + 12; // description
const SAC_X = 132;     // SAC column, left aligned
const AMT_X = R - 2;   // right-aligned money column
const LBL_X = 150;     // totals labels, right-aligned to just left of the money

const ORANGE = [254, 141, 0];   // #FE8D00, the brand orange
const INK = [33, 33, 33];       // #212121
const GREY = [115, 115, 115];
const RULE = [200, 200, 200];
const BAND = [238, 238, 238];

// jsPDF's own line spacing is derived from the point size; we step in mm ourselves so the
// block after a wrapped address always starts exactly where we expect it to.
const step = size => size * 0.42;

// The logo is the repo's logo.jpg, fetched once and held as a data URL for jsPDF. If it cannot
// be fetched (offline, moved) the invoice prints the company name in its place instead of
// failing — an invoice without a logo is still an invoice.
let logoPromise = null;
function loadLogo() {
  if (typeof fetch === 'undefined' || typeof FileReader === 'undefined') return Promise.resolve(null);
  if (!logoPromise) {
    logoPromise = fetch(new URL('../logo.jpg', import.meta.url))
      .then(r => (r.ok ? r.blob() : null))
      .then(blob => blob && new Promise(res => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => res(null);
        fr.readAsDataURL(blob);
      }))
      .catch(() => null);
    logoPromise.then(x => { if (!x) logoPromise = null; });
  }
  return logoPromise;
}

export async function renderInvoicePdf(model) {
  const [JsPDF, logo] = await Promise.all([loadJsPdf(), loadLogo()]);
  const m = model || {};
  const company = m.company || {};
  const billTo = m.billTo || {};
  const dl = m.deal || {};
  const tax = m.tax || {};
  const bank = m.bank || {};
  const items = m.items || [];

  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  doc.setProperties({ title: (m.docType || 'Invoice') + ' ' + (m.invoiceNo || ''), creator: company.name || '' });

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
  const color = c => doc.setTextColor(...c);
  const font = (weight, size) => { doc.setFont('helvetica', weight); doc.setFontSize(size); };
  const rule = (y, c = RULE, w = 0.4, x1 = M, x2 = R) => { doc.setDrawColor(...c); doc.setLineWidth(w); doc.line(x1, y, x2, y); };

  // ── title + number (left), logo (right) ──
  color(INK); font('bold', 26);
  put(m.docType === 'TAX INVOICE' ? 'INVOICE' : (m.docType || 'INVOICE'), M, 24);
  color(ORANGE); font('bold', 10);
  put('NUMBER : ' + (m.invoiceNo || ''), M, 32, { charSpace: 0.6 });
  if (m.docType === 'TAX INVOICE') { color(GREY); font('normal', 7.5); put('Tax invoice · original for recipient', M, 37); }
  if (logo) {
    // logo.jpg is a square with the mark in its middle; drawn large enough that the mark reads.
    doc.addImage(logo, 'JPEG', R - 34, 3, 38, 38);
  } else {
    color(INK); font('bold', 14); put(company.name, R, 24, { align: 'right' });
  }

  // ── the dark rule with an orange line under it ──
  doc.setFillColor(...INK); doc.rect(0, 42, 210, 3.2, 'F');
  doc.setFillColor(...ORANGE); doc.rect(0, 45.2, 210, 1, 'F');

  // ── issued on / due / place of supply ──
  let y = 55;
  const kv = (label, value, x, yy, align) => {
    color(GREY); font('bold', 9.5);
    const w = doc.getTextWidth(label + ' ');
    if (align === 'right') {
      color(INK); font('bold', 9.5); put(value, x, yy, { align: 'right' });
      const vw = doc.getTextWidth(String(value || ''));
      color(GREY); put(label, x - vw - 1.5, yy, { align: 'right' });
    } else {
      put(label, x, yy);
      color(INK); put(value, x + w, yy);
    }
  };
  kv('Issued on:', dmy(m.date), M, y);
  if (m.dueDate) kv('Due by:', dmy(m.dueDate), R, y, 'right');
  y += 6;
  if (m.against) { kv('Against invoice:', m.against, M, y); y += 6; }
  kv('Place of supply:', m.placeOfSupply, M, y);
  y += 9;

  // ── billed to ──
  color(GREY); font('bold', 9.5);
  put('Billed to:', M, y);
  y += 7;
  color(INK); font('bold', 15);
  y = block(billTo.name, M, y, R - M, 15, 2) + 1;
  color(INK); font('normal', 9.5);
  y = block([billTo.address, billTo.state].filter(Boolean).join(', '), M, y, R - M, 9.5, 3);
  const ids = [billTo.gstin && 'GSTIN - ' + billTo.gstin, billTo.phone, billTo.email].filter(Boolean).join('     ');
  if (ids) { y += 1.5; color(GREY); font('normal', 9); put(ids, M, y); y += step(9); }
  if (dl.nickname || dl.propertyName) {
    color(GREY); font('normal', 8.5);
    put('Deal: ' + [dl.nickname, [dl.propertyCode, dl.propertyName].filter(Boolean).join(' — ')].filter(Boolean).join('   |   '), M, y);
    y += step(8.5);
  }
  y += 5;

  // ── the lines ──
  rule(y, [140, 140, 140], 0.8);
  color(INK); font('bold', 9.5);
  put('NO.', NO_X, y + 6);
  put('DESCRIPTION', DESC_X, y + 6);
  put('SAC', SAC_X, y + 6);
  put('AMOUNT (INR)', AMT_X, y + 6, { align: 'right' });
  y += 9;
  rule(y, [140, 140, 140], 0.8);
  y += 7;

  // At most 8 lines on one page; a ninth would push the totals off it.
  const shown = items.slice(0, 8);
  for (const it of shown) {
    color(INK); font('normal', 10);
    put(String(it.n), NO_X, y);
    const end = block(it.desc, DESC_X, y, SAC_X - DESC_X - 6, 10, 4);
    font('normal', 9); color(GREY);
    put(it.sac, SAC_X, y);
    color(INK); font('bold', 10);
    put(amount(it.amt), AMT_X, y, { align: 'right' });
    y = Math.max(end, y + step(10)) + 4;
  }
  if (items.length > shown.length) {
    color(GREY); font('normal', 8.5);
    put(`+ ${items.length - shown.length} more line(s) — see the attached statement`, DESC_X, y);
    y += 5;
  }
  rule(y - 1, RULE, 0.3);
  y += 5;

  // ── sub total, tax, total ──
  const row = (label, amt, bold) => {
    color(INK); font(bold ? 'bold' : 'normal', 10);
    put(label, LBL_X, y, { align: 'right' });
    put(amount(amt), AMT_X, y, { align: 'right' });
    y += 6;
  };
  row('Sub total', m.item?.taxable ?? items.reduce((a, i) => a + num(i.amt), 0));
  if (num(tax.igst)) {
    row(`IGST ${num(tax.rate)}%`, tax.igst);
  } else if (num(tax.total)) {
    // The hand-made invoice lists SGST first; so does this one.
    row(`SGST ${num(tax.halfRate)}%`, tax.sgst);
    row(`CGST ${num(tax.halfRate)}%`, tax.cgst);
  }
  doc.setFillColor(...ORANGE); doc.rect(LBL_X - 30, y - 2.5, R - (LBL_X - 30), 1, 'F');
  y += 6;
  color(INK); font('bold', 13);
  put('TOTAL:', LBL_X, y, { align: 'right', charSpace: 0.8 });
  put('Rs. ' + amount(m.total), AMT_X, y, { align: 'right' });
  y += 9;

  // ── amount in words ──
  font('normal', 9.5); color(GREY);
  const lbl = 'Amount in words: ';
  put(lbl, M, y);
  color(INK); font('bold', 9.5);
  y = block(m.totalWords, M + doc.getTextWidth(lbl) + 1, y, R - M - doc.getTextWidth(lbl) - 1, 9.5, 2) + 3;
  if (m.notes) { color(GREY); font('normal', 8.5); y = block('Note: ' + m.notes, M, y, R - M, 8.5, 3) + 2; }
  rule(y, [140, 140, 140], 0.8);
  y += 7;

  // ── how to pay (left) + signature (right) ──
  const pay = [
    company.pan && ['Our PAN: ', company.pan],
    company.gstin && ['GSTIN: ', company.gstin],
    bank.favour && ['Cheque / DD in favour of: ', `"${bank.favour}"`],
    (bank.accountNo || bank.ifsc) && ['NEFT details', ''],
    bank.accountName && ['Account name: ', bank.accountName],
    bank.accountNo && ['Account number: ', bank.accountNo],
    bank.ifsc && ['IFSC: ', bank.ifsc],
    (bank.bankName || bank.branch) && ['Bank and branch: ', [bank.bankName, bank.branch].filter(Boolean).join(', ')],
  ].filter(Boolean);
  const top = y;
  for (const [k, v] of pay) {
    font('bold', 9.5); color(v ? GREY : INK);
    put(k, M, y);
    if (v) { color(INK); put(v, M + doc.getTextWidth(k), y); }
    y += 5.2;
  }

  // Pinned above the footer band, but pushed down if the body ever runs long.
  const sigY = Math.max(top + 4, 238);
  color(INK); font('normal', 9.5);
  put('For ' + (company.name || ''), R, sigY, { align: 'right' });
  if (m.signature) {
    // Fitted into the space above the line, right-aligned, keeping its shape. A broken image
    // leaves the line blank rather than losing the whole invoice.
    try {
      const ip = doc.getImageProperties(m.signature);
      const k = Math.min(56 / ip.width, 13 / ip.height);
      const w = ip.width * k, h = ip.height * k;
      doc.addImage(m.signature, /png/.test(m.signature.slice(0, 20)) ? 'PNG' : 'JPEG', R - w, sigY + 17 - h, w, h);
    } catch { /* print without it */ }
  }
  rule(sigY + 18, [160, 160, 160], 0.3, R - 58, R);
  color(GREY); font('normal', 8.5);
  put('Authorised signatory', R, sigY + 23, { align: 'right' });

  // ── footer band: the office address and how to reach it ──
  doc.setFillColor(...ORANGE); doc.rect(0, 271, 210, 1.2, 'F');
  doc.setFillColor(...BAND); doc.rect(0, 272.2, 210, 24.8, 'F');
  color(INK); font('bold', 8.5);
  let fy = 279;
  const addr = doc.splitTextToSize(String(company.address || '').trim(), 170).slice(0, 2);
  addr.forEach(line => { put(line, 105, fy, { align: 'center' }); fy += 4.2; });
  const reach = [company.phone && 'Contact: ' + company.phone, company.email && 'Email: ' + company.email].filter(Boolean).join('     ');
  if (reach) put(reach, 105, fy, { align: 'center' });
  color(GREY); font('normal', 6.5);
  put('This is a computer-generated invoice.', 105, 294, { align: 'center' });

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
          // The OS share sheet renders '₹' (unlike the PDF), but this must stay in rupees
          // whatever the display toggle says — an invoice is a record, not a reading.
          text: `Tax invoice ${model?.invoiceNo || ''} — ${fmtInr(model?.total)}`,
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
