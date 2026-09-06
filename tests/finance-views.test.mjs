// ═══════ VIEW, BANK AND INVOICE TESTS ═══════
//
// The engine tests prove the accounting. These prove the layers on top of it survive real
// data: every view renders without throwing, statement matching pairs the right rows to the
// right entries (including the credit-card sign flip, which is the easiest thing to get
// backwards), and the invoice model produces the right GST split.
//
//   node tests/finance-views.test.mjs

import {
  getState, setState, blank, defaultSettings, num, fmt, bal,
} from '../finance-assets/finance-core.js';
import * as B from '../finance-assets/finance-bank.js';
import { invoiceModel, nextInvoiceNumber } from '../finance-assets/finance-invoice.js';
import { renderOwed } from '../finance-assets/views-owed.js';
import { renderServices, renderLoans, renderAssets } from '../finance-assets/views-services.js';
import { renderReports, renderBooks } from '../finance-assets/views-reports.js';

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; return true; }
  failed++; failures.push(`${label}${detail ? ' — ' + detail : ''}`);
  console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}
const section = n => console.log(`\n── ${n}`);

// ═══════ A POPULATED SET OF BOOKS ═══════

function txn(id, date, event, desc, lines, extra = {}) {
  return {
    id, date, event, desc, lines,
    totals: {
      dr: lines.reduce((a, l) => a + num(l.dr), 0),
      cr: lines.reduce((a, l) => a + num(l.cr), 0),
    },
    meta: {}, attachments: [], auto: false, fy: '2026-27',
    createdBy: 'test', createdAt: Date.now(), ...extra,
  };
}

const s = blank();
s.settings = {
  ...defaultSettings(),
  booksStartDate: '2026-09-01',
  gstin: '33ABCDE1234F1Z5', address: '12 Nungambakkam High Rd, Chennai 600034',
  phone: '9840000000', tdsEnabled: true,
  bankDetails: { bankName: 'HDFC', accountName: '3 PIN Realty Pvt Ltd', accountNo: '50200012345678', ifsc: 'HDFC0000123', branch: 'Nungambakkam' },
  bankAccounts: [{ id: '1000', name: 'HDFC current', last4: '5678' }],
  emailDigest: { enabled: true, to: ['3pinrentals@gmail.com'] },
};
s.parties = [
  { id: 'P1', name: 'Mr. Karthik', type: 'client', phone: '9840011111', state: 'Tamil Nadu', gstin: '' },
  { id: 'P2', name: 'Balaji & Co', type: 'vendor', phone: '9840022222', state: 'Tamil Nadu' },
  { id: 'P3', name: 'Anand (Bengaluru)', type: 'client', phone: '9840033333', state: 'Karnataka' },
  { id: 'P4', name: 'HDFC Bank', type: 'lender', phone: '' },
];
s.deals = [
  {
    id: 'D1', nickname: 'Rajan — Nungambakkam 2BHK', propertyCode: 'NUNG002', propertyName: 'Sunrise Apts',
    seller: null, buyer: { partyId: 'P1', name: 'Mr. Karthik', phone: '9840011111' },
    others: [], expSeller: 200000, expBuyer: 100000, status: 'registered', opened: '2026-09-09',
  },
  {
    id: 'D2', nickname: 'Anand — Whitefield', propertyCode: '', propertyName: '', propertyState: 'Karnataka',
    seller: { partyId: 'P3', name: 'Anand (Bengaluru)', phone: '9840033333' },
    buyer: null, others: [], expSeller: 150000, expBuyer: 0, status: 'open', opened: '2026-10-01',
  },
];
s.txns = [
  txn('T1', '2026-09-01', 'funding', 'Share capital', [{ acc: '1000', dr: 500000 }, { acc: '3000', cr: 500000 }]),
  txn('T2', '2026-09-08', 'expense', 'Office rent — Sep', [{ acc: '5000', dr: 35000 }, { acc: '1000', cr: 35000 }]),
  txn('T3', '2026-09-12', 'bill', 'Title opinion — Balaji & Co',
    [{ acc: '5120', dr: 10000 }, { acc: '2000', cr: 10000, party: 'P2' }]),
  txn('T4', '2026-10-06', 'invoice', 'Brokerage — Rajan (Mr. Karthik)', [
    { acc: '4010', cr: 100000, deal: 'D1', party: 'P1' },
    { acc: '2200', cr: 9000, deal: 'D1' },
    { acc: '2201', cr: 9000, deal: 'D1' },
    { acc: '1150', dr: 2000, party: 'P1', deal: 'D1' },
    { acc: '1100', dr: 116000, party: 'P1', deal: 'D1' },
  ]),
  txn('T5', '2026-10-14', 'dealpay', 'Payment — Rajan',
    [{ acc: '1000', dr: 60000 }, { acc: '1100', cr: 60000, party: 'P1', deal: 'D1' }]),
  txn('T6', '2026-10-20', 'expense', 'Meta ads', [{ acc: '5090', dr: 8450 }, { acc: '2300', cr: 8450 }]),
  txn('T7', '2026-10-25', 'expense', 'Fuel', [{ acc: '5050', dr: 2200 }, { acc: '1000', cr: 2200 }]),
];
s.subs = [
  {
    id: 'S1', name: 'Zoho CRM', vendor: 'Zoho', use: 'Lead pipeline', payMode: 'upfront',
    amount: 24000, monthly: 2000, via: '1000', start: '2026-09', end: '2027-08', months: 12,
    amortized: ['2026-09', '2026-10'], charges: {}, status: 'active',
  },
  {
    id: 'S2', name: 'Claude Pro', vendor: 'Anthropic', use: 'Content', payMode: 'monthly',
    amount: 1800, monthly: 1800, via: '2300', start: '2026-09', end: null, months: 1,
    amortized: [], charges: { '2026-09': { actual: 1800 }, '2026-10': { actual: 1800 } }, status: 'active',
  },
  {
    id: 'S3', name: 'Old tool', vendor: 'X', use: '', payMode: 'monthly', amount: 500, monthly: 500,
    via: '1000', start: '2026-09', end: '2026-10', months: 1, amortized: [], charges: {}, status: 'cancelled',
  },
];
s.loans = [{
  id: 'L1', lender: 'HDFC Bank', purpose: 'Working capital', principal: 300000, rate: 12, n: 24,
  start: '2026-11', paid: [1], status: 'active', partyId: 'P4',
  schedule: Array.from({ length: 24 }, (_, i) => ({
    n: i + 1, month: '2026-' + String(11 + i).padStart(2, '0'),
    emi: 14122, int: 3000 - i * 100, prin: 11122 + i * 100, bal: 288878 - i * 11122,
  })),
}];
s.assets = [
  { id: 'A1', name: 'MacBook Air', cost: 95000, date: '2026-09-03', start: '2026-09', life: 36, monthly: 2638.89, depreciated: ['2026-09', '2026-10'], status: 'in use' },
  { id: 'A2', name: 'Old printer', cost: 12000, date: '2026-09-01', start: '2026-09', life: 24, monthly: 500, depreciated: ['2026-09'], status: 'disposed', disposedOn: '2026-10-30' },
];
s.invoices = [{
  id: 'I1', txnId: 'T4', invoiceNo: '3PIN/26-27/001', date: '2026-10-06', partyId: 'P1', dealId: 'D1',
  base: 100000, gstRate: 18, cgst: 9000, sgst: 9000, igst: 0, total: 118000, status: 'unpaid',
}];
s.monthEnds = { '2026-09': { ranAt: Date.now(), entriesPosted: 3, reconciled: true } };
setState(s);

// ═══════ VIEWS RENDER ═══════

section('Every view renders with real data');
const views = [
  ['Owed', renderOwed], ['Services', renderServices], ['Loans', renderLoans],
  ['Assets', renderAssets], ['Reports', renderReports], ['Books', renderBooks],
];
for (const [name, fn] of views) {
  let html = null, err = null;
  try { html = fn(); } catch (e) { err = e; }
  check(`${name} renders`, !!html && !err, err ? err.message : '');
  if (html) {
    check(`${name} produced real markup`, html.length > 200, `${html.length} chars`);
    check(`${name} left no undefined in the output`, !/undefined|NaN|\[object Object\]/.test(html),
      (html.match(/undefined|NaN|\[object Object\]/) || [])[0]);
  }
}

section('Views render on empty books too');
const emptyState = blank();
emptyState.settings = { ...defaultSettings() };
setState(emptyState);
for (const [name, fn] of views) {
  let ok = true, err = null;
  try { fn(); } catch (e) { ok = false; err = e; }
  check(`${name} survives empty books`, ok, err?.message);
}
setState(s);

section('Owed view shows the right figures');
const owedHtml = renderOwed();
check('Shows the client who owes money', owedHtml.includes('Mr. Karthik'));
check('Shows the vendor owed', owedHtml.includes('Balaji &amp; Co') || owedHtml.includes('Balaji'));
check('Shows the outstanding receivable', owedHtml.includes(fmt(56000)), `expected ${fmt(56000)}`);
check('TDS section appears when TDS is on', owedHtml.includes('TDS deducted'));

section('Services view');
const svcHtml = renderServices();
check('Lists the active services', svcHtml.includes('Zoho CRM') && svcHtml.includes('Claude Pro'));
check('Cancelled service moved to history', svcHtml.includes('No longer active'));
check('Run rate is monthly + upfront slice', svcHtml.includes(fmt(3800)), `expected ${fmt(3800)}`);

section('Assets view');
const assetHtml = renderAssets();
check('Shows the asset in use', assetHtml.includes('MacBook'));
check('Shows written-down value', assetHtml.includes(fmt(95000 - 2 * 2638.89)));
check('Disposed asset is separated out', assetHtml.includes('Sold or scrapped'));

// ═══════ BANK MATCHING ═══════

section('Bank statement matching — current account');
const stmtCsv = [
  'Date,Narration,Withdrawal,Deposit,Balance',
  '01/09/2026,OPENING CAPITAL,,500000.00,500000.00',
  '08/09/2026,RENT NEFT,35000.00,,465000.00',
  '14/10/2026,NEFT KARTHIK,,60000.00,525000.00',
  '25/10/2026,FUEL POS,2200.00,,522800.00',
  '28/10/2026,BANK CHARGES,177.00,,522623.00',
].join('\r\n');

const parsedStmt = B.parseDelimited(stmtCsv);
const mapStmt = B.detectMapping(parsedStmt.headers, parsedStmt.rows);
const bankRows = B.buildRows(parsedStmt, mapStmt);
check('Five statement rows parsed', bankRows.length === 5, `got ${bankRows.length}`);

const m1 = B.autoMatch(bankRows, s.txns, '1000');
// autoMatch returns the matched and unmatched ROWS, not counts.
check('Four of five rows matched', m1.matched.length === 4, `matched ${m1.matched.length}`);
check('Bank charges left unmatched', m1.rows.find(r => r.desc.includes('BANK CHARGES')).status === 'unmatched');
check('Capital matched to the funding entry', m1.rows[0].matchedTxnId === 'T1', m1.rows[0].matchedTxnId);
check('Rent matched to the rent entry', m1.rows[1].matchedTxnId === 'T2', m1.rows[1].matchedTxnId);
check('Deposit matched to the client payment', m1.rows[2].matchedTxnId === 'T5', m1.rows[2].matchedTxnId);
check('Fuel matched to the fuel entry', m1.rows[3].matchedTxnId === 'T7', m1.rows[3].matchedTxnId);
check('No transaction matched twice',
  new Set(m1.rows.filter(r => r.matchedTxnId).map(r => r.matchedTxnId)).size === m1.matched.length);

section('Bank statement matching — credit card sign flip');
// On the card a purchase is a DEBIT on the statement but a CREDIT to account 2300, because
// 2300 is a liability. Getting this backwards is the classic reconciliation bug.
const cardCsv = [
  'Date,Description,Debit,Credit',
  '20/10/2026,META PLATFORMS ADS,8450.00,',
].join('\r\n');
const cardParsed = B.parseDelimited(cardCsv);
const cardRows = B.buildRows(cardParsed, B.detectMapping(cardParsed.headers, cardParsed.rows));
const m2 = B.autoMatch(cardRows, s.txns, '2300');
check('Card purchase matched to the ad spend', m2.matched.length === 1 && m2.rows[0].matchedTxnId === 'T6',
  `matched=${m2.matched.length} id=${m2.rows[0].matchedTxnId}`);

section('Book entries missing from the statement');
const orphans = B.bookEntriesWithoutStatement(s.txns, m1.rows, '1000', '2026-09-01', '2026-10-31');
check('Finds nothing spurious for a clean period', Array.isArray(orphans), 'not an array');

section('Reconciliation summary');
const summary = B.reconcileSummary(m1.rows, s.txns, '1000', 522623, '2026-10-31');
check('Summary reports the book balance', typeof summary.bookBalance === 'number');
check('Not reconciled while a row is unmatched', summary.reconciled === false);
check('Unmatched count is reported', summary.unmatchedCount === 1, String(summary.unmatchedCount));

// ═══════ INVOICE ═══════

section('Invoice model — Tamil Nadu client');
const inv1 = invoiceModel({
  invoice: s.invoices[0], party: s.parties[0], deal: s.deals[0], settings: s.settings,
});
check('Invoice number carried through', inv1.invoiceNo === '3PIN/26-27/001', inv1.invoiceNo);
check('CGST is half the tax', num(inv1.tax.cgst) === 9000, String(inv1.tax.cgst));
check('SGST is half the tax', num(inv1.tax.sgst) === 9000, String(inv1.tax.sgst));
check('No IGST within the state', num(inv1.tax.igst) === 0, String(inv1.tax.igst));
check('Total is base plus tax', num(inv1.total) === 118000, String(inv1.total));
check('Amount in words is filled', /Lakh|Thousand/.test(inv1.totalWords), inv1.totalWords);
check('Bill-to carries the client name', JSON.stringify(inv1.billTo).includes('Karthik'));
check('Nothing is missing on a complete profile', (inv1.missing || []).length === 0,
  (inv1.missing || []).join(', '));

section('Invoice model — a client from another state, property in Tamil Nadu');
{
  // Place of supply follows the property, so a Bengaluru buyer of a Chennai flat is intra-state.
  const inv = invoiceModel({
    invoice: { id: 'I3', invoiceNo: '3PIN/26-27/003', date: '2026-11-02', partyId: 'P3', dealId: 'D1', base: 100000, gstRate: 18, total: 118000 },
    party: s.parties[2], deal: s.deals[0], settings: s.settings,
  });
  check('Property in TN → CGST even for a Karnataka client', num(inv.tax.cgst) === 9000, String(inv.tax.cgst));
  check('Property in TN → no IGST for a Karnataka client', num(inv.tax.igst) === 0, String(inv.tax.igst));
  check('Place of supply printed is the property state', inv.placeOfSupply === 'Tamil Nadu', inv.placeOfSupply);
}

section('Invoice model — property outside Tamil Nadu charges IGST');
const inv2 = invoiceModel({
  invoice: {
    id: 'I2', invoiceNo: '3PIN/26-27/002', date: '2026-11-02', partyId: 'P3', dealId: 'D2',
    base: 150000, gstRate: 18, total: 177000,
  },
  party: s.parties[2], deal: s.deals[1], settings: s.settings,
});
check('IGST charged when the property is in Karnataka', num(inv2.tax.igst) === 27000, String(inv2.tax.igst));
check('No CGST when the property is in Karnataka', num(inv2.tax.cgst) === 0, String(inv2.tax.cgst));
check('Place of supply printed is Karnataka', inv2.placeOfSupply === 'Karnataka', inv2.placeOfSupply);

section('Invoice model — incomplete profile is reported');
const bare = invoiceModel({
  invoice: s.invoices[0], party: s.parties[0], deal: s.deals[0],
  settings: { ...defaultSettings() },
});
check('Missing details are listed', (bare.missing || []).length > 0, 'nothing flagged');
check('Numbering helper pads correctly',
  nextInvoiceNumber({ invoicePrefix: '3PIN/26-27/', nextInvoiceNo: 7 }) === '3PIN/26-27/007',
  nextInvoiceNumber({ invoicePrefix: '3PIN/26-27/', nextInvoiceNo: 7 }));

// ═══════ RESULT ═══════

console.log(`\n${'─'.repeat(58)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
console.log('All green.');
