// ═══════ GUIDE — START HERE, HOW-TO, ACTIONS, SCENARIOS, CHARTS, FAQ & GLOSSARY ═══════
//
// One section holding everything somebody needs to run these books — whether they have never
// kept books before or are the chartered accountant checking them. Written in two registers on
// purpose: every explanation starts in plain words and, where it matters, ends with the rule
// an accountant would want to see (the account, the section, the circular).
//
// Nothing in the reference or the worked examples is typed by hand. The ACTIONS tab reads the
// real event definitions (title, direction, the fields and their hints) and the SCENARIOS tab
// runs the REAL event builders and validators against a small set of sample books — the same
// build() and check() the Record screen calls. Change the engine and the guide changes with
// it, or breaks loudly. The sample books are swapped in and out around each call and never
// touch real data.

import {
  A, fmt, esc, num, ym, addMonths, mlabel, today,
  getState, setState, blank, defaultSettings, schedule, allocate, openBills, openInvoices,
  billOutstanding, invoiceOutstanding, serviceMonths, expectedFor,
} from './finance-core.js';
import { EV, CHOOSER, fieldsFor, validateEvent, dirOf } from './finance-events.js';
import { note, tag, table, empty } from './ui.js';

let tab = 'start';
let query = '';

// ═══════ SAMPLE BOOKS ═══════
//
// A small but complete set of books, frozen in mid-November 2026: one deal holding a token,
// a vendor owed money on a bill, an annual plan, a monthly plan that has just been upgraded
// with a prorated invoice still unpaid, a loan mid-repayment and an asset part-depreciated.

const S_START = '2026-09';

function sampleState() {
  const s = blank();
  s.settings = { ...defaultSettings(), booksStartDate: '2026-09-01', tdsEnabled: false };
  s.parties = [
    { id: 'P1', name: 'Mr. Karthik', type: 'client', phone: '98400 11111', state: 'Tamil Nadu' },
    { id: 'P2', name: 'Balaji & Co', type: 'vendor', phone: '98400 22222' },
    { id: 'P3', name: 'Priya', type: 'employee', phone: '98400 33333' },
    { id: 'P4', name: 'Card EMI', type: 'lender' },
    { id: 'P5', name: 'Anthropic', type: 'vendor' },
    { id: 'P6', name: 'Zoho', type: 'vendor' },
    { id: 'P7', name: 'Prakash Builders', type: 'client', state: 'Karnataka' },
  ];
  s.deals = [{
    id: 'D1', nickname: 'Rajan — Nungambakkam 2BHK',
    propertyCode: 'NUNG002', propertyName: 'Sunrise Apts', propertyState: 'Tamil Nadu',
    seller: null, buyer: { partyId: 'P1', name: 'Mr. Karthik', phone: '98400 11111' },
    others: [], expSeller: 0, expBuyer: 100000, status: 'open', opened: '2026-09-09',
  }];
  const T = (id, date, event, desc, lines) => ({
    id, date, event, desc, lines,
    totals: { dr: lines.reduce((a, l) => a + num(l.dr), 0), cr: lines.reduce((a, l) => a + num(l.cr), 0) },
    meta: {}, attachments: [], auto: false, fy: '2026-27', createdBy: 'sample', createdAt: 0,
  });
  s.txns = [
    T('T0', '2026-09-01', 'funding', 'Share capital — Swaminathan', [{ acc: '1000', dr: 300000 }, { acc: '3000', cr: 300000 }]),
    T('T1', '2026-09-10', 'token', 'Token — Rajan (Mr. Karthik)', [{ acc: '1000', dr: 50000 }, { acc: '2100', cr: 50000, party: 'P1', deal: 'D1' }]),
    T('T2', '2026-09-12', 'bill', 'Title opinion — Balaji & Co', [{ acc: '5120', dr: 10000 }, { acc: '2000', cr: 10000, party: 'P2' }]),
    T('T3', '2026-09-15', 'transfer', 'Transfer: Bank → Petty cash', [{ acc: '1010', dr: 8000 }, { acc: '1000', cr: 8000 }]),
    T('T4', '2026-09-05', 'confirmcharge', 'Claude (Pro) — Sep 2026', [{ acc: '5080', dr: 1800 }, { acc: '1000', cr: 1800 }]),
    T('T5', '2026-10-05', 'confirmcharge', 'Claude (Pro) — Oct 2026', [{ acc: '5080', dr: 1800 }, { acc: '1000', cr: 1800 }]),
    T('T6', '2026-11-14', 'confirmcharge', 'Claude (Pro) — Nov 2026', [{ acc: '5080', dr: 4320 }, { acc: '1402', dr: 777.6 }, { acc: '2205', cr: 777.6 }, { acc: '2000', cr: 4320, party: 'P5' }]),
    T('T7', '2026-11-02', 'otherinc', 'Market study', [{ acc: '1100', dr: 23600, party: 'P7' }, { acc: '4020', cr: 20000, party: 'P7' }, { acc: '2202', cr: 3600 }]),
  ];
  s.bills = [
    { id: 'B1', partyId: 'P2', vendorName: 'Balaji & Co', billNo: 'BC/112', date: '2026-09-12', dueDate: '2026-10-12', desc: 'Title opinion', acc: '5120', taxable: 10000, gst: 0, total: 10000, net: 10000, paid: 0, status: 'open', txnId: 'T2', allocations: [], no: 3 },
    { id: 'B2', partyId: 'P5', vendorName: 'Anthropic', billNo: 'ANT-88213', date: '2026-11-14', dueDate: '2026-11-28', desc: 'Claude (Pro) — Nov 2026', acc: '5080', taxable: 4320, gst: 0, rcm: 777.6, total: 4320, net: 4320, paid: 0, status: 'open', serviceId: 'S2', month: '2026-11', txnId: 'T6', allocations: [], no: 7 },
    { id: 'B3', partyId: 'P5', vendorName: 'Anthropic', date: '2026-09-05', dueDate: '2026-09-05', desc: 'Claude (Pro) — Sep 2026', acc: '5080', taxable: 1800, total: 1800, net: 1800, paid: 1800, status: 'paid', serviceId: 'S2', month: '2026-09', txnId: 'T4', allocations: [], no: 5 },
    { id: 'B4', partyId: 'P5', vendorName: 'Anthropic', date: '2026-10-05', dueDate: '2026-10-05', desc: 'Claude (Pro) — Oct 2026', acc: '5080', taxable: 1800, total: 1800, net: 1800, paid: 1800, status: 'paid', serviceId: 'S2', month: '2026-10', txnId: 'T5', allocations: [], no: 6 },
  ];
  s.invoices = [{
    id: 'I1', kind: 'other', invoiceNo: '3PIN/26-27/004', partyId: 'P7', dealId: null, base: 20000, gstRate: 18, cgst: 0, sgst: 0, igst: 3600, total: 23600,
    paid: 0, status: 'open', dueDate: '2026-12-02', placeOfSupply: 'Karnataka', sac: '998311', desc: 'Market study', date: '2026-11-02', txnId: 'T7', allocations: [],
  }];
  s.subs = [
    {
      id: 'S1', name: 'Zoho CRM', plan: 'Standard', vendor: 'Zoho', vendorId: 'P6', use: 'Lead pipeline', payMode: 'upfront', billing: 'upfront',
      amount: 24000, monthly: 2000, via: '1000', start: S_START, end: '2027-08', months: 12,
      history: [{ from: S_START, amount: 2000, plan: 'Standard' }], amortized: [S_START, '2026-10'], charges: {}, status: 'active',
    },
    {
      id: 'S2', name: 'Claude', plan: 'Max', vendor: 'Anthropic', vendorId: 'P5', use: 'Content and drafting', payMode: 'monthly', billing: 'auto',
      amount: 1800, monthly: 10000, via: '1000', start: S_START, end: null, months: 1,
      history: [{ from: S_START, amount: 1800, plan: 'Pro' }, { from: '2026-12', amount: 10000, plan: 'Max' }],
      amortized: [],
      charges: {
        '2026-09': { actual: 1800, expected: 1800, variance: 0, paid: true, billId: 'B3', date: '2026-09-05' },
        '2026-10': { actual: 1800, expected: 1800, variance: 0, paid: true, billId: 'B4', date: '2026-10-05' },
        '2026-11': { actual: 4320, expected: 1800, variance: 2520, reason: 'prorate', note: 'Upgraded to Max on the 14th', paid: false, billId: 'B2', date: '2026-11-14' },
      },
      status: 'active',
    },
  ];
  s.loans = [{
    id: 'L1', lender: 'Card EMI', purpose: 'Sony A7 camera', principal: 80000,
    rate: 14, n: 12, start: '2026-10', schedule: schedule(80000, 14, 12, '2026-10'),
    paid: [], status: 'active', partyId: 'P4',
  }];
  s.assets = [{
    id: 'A1', name: 'MacBook Air', cost: 95000, date: '2026-09-03', start: S_START,
    life: 36, monthly: 95000 / 36, depreciated: [S_START, '2026-10'], status: 'in use',
  }];
  return s;
}

// Swap the sample books in, run something, put the real books back. Synchronous on purpose:
// nothing may await in between or a render could see the wrong state.
function withSample(fn) {
  const real = getState();
  try {
    setState(sampleState());
    return fn();
  } finally {
    setState(real);
  }
}

const DIR_LABEL = { in: 'Money in', out: 'Money out', move: 'Move money', fix: 'Correction', setup: 'Set up' };
const dirTag = key => `<span class="dirtag dir-${dirOf(key)}">${DIR_LABEL[dirOf(key)]}</span>`;

// ═══════ SCENARIOS ═══════
//
// Each one is a real situation, the button to press, and the values to press it with. The
// journal and the consequences are produced by the engine, not typed here. `values` may be a
// function, evaluated inside the sample books, for anything that has to be worked out from
// them (an allocation across open bills).

const SCENARIOS = [
  // ── Deals
  {
    group: 'Deals — from token to cash', id: 'token',
    situation: 'A buyer hands you ₹50,000 as a token before registration.',
    event: 'token',
    values: { date: '2026-09-10', deal: 'D1', from: 'buyer', amt: 50000, via: '1000' },
    point: 'It is <b>not income</b>. The deal has not happened. It is held for the client and your profit does not move. <span class="small faint">(Cr 2100 Client advances held.)</span>',
  },
  {
    group: 'Deals — from token to cash', id: 'invoice', button: 'Deal closed — brokerage from the buyer',
    situation: 'The deal registers. Brokerage is ₹1,00,000 plus GST, the token comes off, the rest is owed.',
    event: 'invoice',
    values: { date: '2026-10-06', deal: 'D1', from: 'buyer', amt: 100000, gst: 'yes', gstRate: 18, gstAmt: 18000, total: 118000, tds: 0, adv: 50000, recv: 'later', dueDate: '2026-11-05' },
    point: '<b>This is the moment income exists.</b> Profit rises by the brokerage; the GST is the government\'s; a numbered invoice with a due date is created and the balance shows on Owed until it is paid. <span class="small faint">(Cr 4010 income, Cr 2200/2201 GST payable, Dr 2100 token, Dr 1100 receivable.)</span>',
  },
  {
    group: 'Deals — from token to cash', id: 'dealpay',
    situation: 'Prakash Builders pays the ₹23,600 market-study invoice, three weeks later.',
    event: 'dealpay',
    values: () => ({ date: '2026-10-27', party: 'P7', amt: 23600, via: '1000', alloc: allocate(23600, openInvoices('P7'), invoiceOutstanding).rows }),
    point: 'Cash in, receivable down, <b>profit unchanged</b> — it was counted at registration. The payment is <b>allocated to the invoice</b>, which is now marked paid. Pay half and the invoice shows part-paid; pay more and the extra is held for the client. <span class="small faint">(Dr 1000, Cr 1100; allocation recorded on the invoice.)</span>',
  },
  {
    group: 'Deals — from token to cash', id: 'settle-refund',
    situation: 'The deal falls through and the client wants the token back.',
    event: 'settle',
    values: { date: '2026-10-20', deal: 'D1', from: 'buyer', refund: 50000, via: '1000', keep: 0, gst: 18, move: '', drop: 'yes' },
    point: 'Cash out, and nothing else. A refund is not a loss because the token was never income.',
  },
  {
    group: 'Deals — from token to cash', id: 'settle-keep',
    situation: 'The client backed out and agreed you keep the token.',
    event: 'settle',
    values: { date: '2026-10-20', deal: 'D1', from: 'buyer', refund: 0, keep: 50000, gst: 18, move: '', drop: 'yes' },
    point: 'Now it becomes income — <b>net of GST</b>, because the app assumes the forfeiture is taxable. Your CA may say it is not a supply (CBIC Circular 178/10/2022); enter 0 in the GST box if so.',
  },
  {
    group: 'Deals — from token to cash', id: 'dealcost',
    situation: 'You pay ₹5,000 for the EC on the client\'s behalf, to recover from them later.',
    event: 'dealcost',
    values: { date: '2026-10-08', deal: 'D1', what: 'EC extract', amt: 5000, gst: 'no', bear: 'buyer', how: '1000' },
    point: 'Not your expense — a <b>recoverable</b>. It joins what the client owes and goes onto their settlement. Choose "Company" instead and it becomes a deal expense that reduces the deal\'s net.',
  },
  {
    group: 'Deals — from token to cash', id: 'writeoff',
    situation: 'Six months on, a client will never pay the ₹25,000 they owe.',
    event: 'writeoff',
    prepare: s => s.txns.push({ id: 'T9', date: '2026-10-06', event: 'invoice', desc: 'Brokerage — Rajan', lines: [{ acc: '1100', dr: 25000, party: 'P1', deal: 'D1' }, { acc: '4010', cr: 25000, party: 'P1', deal: 'D1' }], totals: { dr: 25000, cr: 25000 }, meta: {}, attachments: [], auto: false, fy: '2026-27', createdBy: 'sample', createdAt: 0 }),
    values: { date: '2026-11-25', deal: 'D1', from: 'buyer', amt: 20000, why: 'Client unreachable since August' },
    point: 'The receivable goes and the loss is booked, so your books stop claiming money you do not have. The reason is kept — an auditor will ask.',
  },

  // ── Services
  {
    group: 'Services — the Claude Pro story', id: 'subnew',
    situation: 'You take a Claude Pro subscription at ₹1,800 a month, auto-charged to the bank.',
    event: 'subnew',
    values: { date: '2026-09-01', name: 'Claude', plan: 'Pro', vendor: 'P5', use: 'Content and drafting', payMode: 'monthly', billing: 'auto', amt: 1800, via: '1000' },
    point: 'Nothing is posted. A service is a <b>commitment</b> — what you expect each month — and the books only move when a month\'s bill is recorded. The vendor is named so every month\'s bill can be raised against them.',
  },
  {
    group: 'Services — the Claude Pro story', id: 'confirm-normal',
    situation: 'September: charged ₹1,800 as expected.',
    event: 'confirmcharge',
    prepare: s => { delete s.subs[1].charges['2026-09']; },
    values: { sub: 'S2', month: '2026-09', date: '2026-09-05', result: 'paid', via: '1000', amt: 1800, gst: 'no', rcm: 'no', newPlan: 'no' },
    point: 'The month\'s cost is booked, the money leaves the bank, and a paid bill goes on record for the month. Expected 1,800, billed 1,800 — <b>no variance</b>.',
  },
  {
    group: 'Services — the Claude Pro story', id: 'confirm-upgrade',
    situation: 'Mid-November you upgrade to Max. Anthropic invoices ₹4,320 for the prorated difference, payable by the 28th, and from December the full ₹10,000 applies. They bill from abroad, so there is no Indian GST on it.',
    event: 'confirmcharge',
    prepare: s => { const c = s.subs[1]; delete c.charges['2026-11']; c.history = c.history.slice(0, 1); c.plan = 'Pro'; c.monthly = 1800; s.bills = s.bills.filter(b => b.id !== 'B2'); },
    values: { sub: 'S2', month: '2026-11', date: '2026-11-14', result: 'invoice', dueDate: '2026-11-28', amt: 4320, gst: 'no', rcm: 'yes', rcmRate: 18, rcmType: 'inter', reason: 'prorate', note: 'Upgraded to Max on the 14th', newPlan: 'yes', newAmount: 10000, newPlanName: 'Max', newFrom: '2026-12' },
    point: 'One form does all of it. November\'s cost is the real ₹4,320 with the variance and its reason recorded; the invoice sits on Owed with its due date; from December the service <b>expects ₹10,000</b> and every earlier month keeps its old expectation. Because the vendor is abroad, the GST is paid by you under <b>reverse charge</b> (IGST Act s.5(3); import of services) and claimed back as credit — it is neither owed to Anthropic nor a cost.',
  },
  {
    group: 'Services — the Claude Pro story', id: 'paybill-anthropic',
    situation: 'On the 20th you pay the prorated invoice.',
    event: 'paybill',
    values: () => ({ date: '2026-11-20', party: 'P5', amt: 4320, via: '1000', useAdvance: 'no', alloc: allocate(4320, openBills('P5'), billOutstanding).rows }),
    point: 'The payment is <b>matched to that bill</b>; the Services tab now shows November as billed, paid, +₹2,520 against expected, "plan changed mid-month". Profit does not move — the cost was counted when the invoice came in.',
  },
  {
    group: 'Services — the Claude Pro story', id: 'confirm-skipped',
    situation: 'A month the vendor did not charge at all.',
    event: 'confirmcharge',
    values: { sub: 'S2', month: '2026-12', date: '2026-12-05', result: 'skipped' },
    point: 'Marked "not charged" so the month is not left looking <b>missing</b>. Nothing posts.',
  },
  {
    group: 'Services — the Claude Pro story', id: 'subchange',
    situation: 'You already know a price rise takes effect from March — no bill yet.',
    event: 'subchange',
    values: { from: '2027-03', sub: 'S2', plan: 'Max', payMode: 'monthly', amt: 12000 },
    point: 'Use this when there is nothing to record yet. It only changes what the months ahead <b>expect</b>. When there IS a bill — a prorated one, say — record the month instead and set the new plan there.',
  },
  {
    group: 'Services — the Claude Pro story', id: 'subnew-upfront',
    situation: 'A CRM paid ₹24,000 upfront for the year.',
    event: 'subnew',
    values: { date: '2026-10-05', name: 'Zoho CRM', plan: 'Standard', vendor: 'P6', use: 'Lead pipeline', payMode: 'upfront', amt: 24000, gst: 'yes', gstRate: 18, gstAmt: 4320, total: 28320, gstType: 'intra', vgstin: '33AAACZ1234A1Z5', vinv: 'ZH-991', months: 12, via: '1000' },
    point: 'Cash out now, but <b>not all this month\'s cost</b>. It sits as prepaid and ₹2,000 is released each month-end. The GST is input credit. <span class="small faint">(Dr 1200 Prepaid, Dr 1400/1401 GST input, Cr 1000.)</span>',
  },

  // ── Money out
  {
    group: 'Money out — expenses, bills, payments', id: 'expense',
    situation: 'Office rent, ₹35,000, paid by bank transfer today.',
    event: 'expense',
    values: { date: '2026-10-01', desc: 'Office rent — Oct', acc: '5000', amt: 35000, gst: 'no', via: '1000' },
    point: 'Used and paid in the same moment: cost now, cash now. <b>If you will pay later, this is the wrong button</b> — use "Bill received".',
  },
  {
    group: 'Money out — expenses, bills, payments', id: 'bill',
    situation: 'A lawyer bills ₹10,000 + GST for a title opinion, due in 30 days.',
    event: 'bill',
    values: { date: '2026-10-12', vendor: 'P2', desc: 'Title opinion — Adyar', acc: '5120', dueDate: '2026-11-11', rcm: 'no', amt: 10000, gst: 'yes', gstRate: 18, gstAmt: 1800, total: 11800, gstType: 'intra', vgstin: '33AABCB1234A1Z5', vinv: 'BC/118' },
    point: 'The cost belongs to <b>now</b> — profit goes down now — but no cash has moved. The bill goes on record with its due date and shows on Owed. The GST on it is credit you will set off against what you collect. <span class="small faint">(Dr 5120, Dr 1400/1401, Cr 2000 Accounts payable — a bill document is created.)</span>',
  },
  {
    group: 'Money out — expenses, bills, payments', id: 'paybill-part',
    situation: 'You pay Balaji & Co ₹6,000 of the ₹10,000 you owe them.',
    event: 'paybill',
    values: () => ({ date: '2026-10-30', party: 'P2', amt: 6000, via: '1000', useAdvance: 'no', alloc: allocate(6000, openBills('P2'), billOutstanding).rows }),
    point: 'The bill becomes <b>part-paid</b>, with ₹4,000 still open. Profit does not move. The Owed tab shows exactly which bill is still outstanding and by how much.',
  },
  {
    group: 'Money out — expenses, bills, payments', id: 'paybill-over',
    situation: 'You accidentally pay Balaji & Co ₹12,000 against a ₹10,000 bill.',
    event: 'paybill',
    values: () => ({ date: '2026-10-30', party: 'P2', amt: 12000, via: '1000', useAdvance: 'no', over: 'advance', alloc: allocate(12000, openBills('P2'), billOutstanding).rows }),
    point: 'The bill is paid and the extra ₹2,000 is an <b>advance</b> with the vendor — your money, used first the next time you pay them. Or choose "Do not allow" and the form refuses until the amount is corrected. <span class="small faint">(Dr 2000, Dr 1550 Advances to vendors, Cr 1000.)</span>',
  },
  {
    group: 'Money out — expenses, bills, payments', id: 'vendorrefund',
    situation: 'The vendor issues a ₹1,000 + GST credit note against an unpaid bill.',
    event: 'vendorrefund',
    values: () => ({ date: '2026-10-15', vendor: 'P2', desc: 'Title opinion — page count reduced', acc: '5120', amt: 1000, gst: 'yes', gstRate: 18, gstAmt: 180, total: 1180, gstType: 'intra', how: 'credit', alloc: allocate(1180, openBills('P2'), billOutstanding).rows }),
    point: 'Reduces the original cost — <b>not income</b> — and gives back the GST credit claimed on it. Applied to the bill, so what you owe drops and the bill shows the reduced balance.',
  },
  {
    group: 'Money out — expenses, bills, payments', id: 'petty',
    situation: 'Tea for clients ₹120 and a courier ₹300, from the cash box.',
    event: 'petty',
    values: { date: '2026-10-11', a1: 120, c1: '5030', d1: 'Tea for clients', a2: 300, c2: '5100', d2: 'Courier', a3: 0 },
    point: 'Up to three spends at once. The box has to hold enough — the form refuses if it does not. Top it up with "Move money".',
  },
  {
    group: 'Money out — expenses, bills, payments', id: 'expense-card',
    situation: 'Meta ads ₹4,000 + IGST on the credit card. Meta bills from Karnataka.',
    event: 'expense',
    values: { date: '2026-10-12', desc: 'Meta ads', acc: '5090', vendor: { __new: true, name: 'Meta', type: 'vendor' }, amt: 4000, gst: 'yes', gstRate: 18, gstAmt: 720, total: 4720, gstType: 'inter', vgstin: '29AABCF1234A1Z5', vinv: 'FB-2211', via: '2300' },
    point: 'Cost now; the card balance grows. Paying the card bill later is a <b>transfer</b>, not another expense. Out-of-state vendor → the credit is <b>IGST</b>.',
  },
  {
    group: 'Money out — expenses, bills, payments', id: 'expense-lunch',
    situation: 'Team lunch ₹800 + 5% GST, paid by UPI.',
    event: 'expense',
    values: { date: '2026-10-12', desc: 'Team lunch', acc: '5030', amt: 800, gst: 'yes', gstRate: 5, gstAmt: 40, total: 840, via: '1000' },
    point: 'Input credit on food is <b>blocked</b> (CGST Act s.17(5)(b)), so the tax is part of the cost rather than a claim the government would refuse.',
  },
  {
    group: 'Money out — expenses, bills, payments', id: 'salary',
    situation: 'Priya\'s salary, ₹25,000, paid by bank.',
    event: 'salary',
    values: { date: '2026-10-28', emp: 'P3', kind: '5010', gross: 25000, tds: 0, pf: 0, via: '1000' },
    point: 'The gross is the cost. Anything withheld — TDS, PF — is held until you deposit it.',
  },
  {
    group: 'Money out — expenses, bills, payments', id: 'asset',
    situation: 'A ₹95,000 laptop, bought on credit from a dealer.',
    event: 'asset',
    values: { date: '2026-10-03', name: 'MacBook Air', vendor: 'P2', amt: 95000, gst: 'no', life: 36, how: 'bill', dueDate: '2026-11-02' },
    point: 'Not an expense — an asset, with the cost released as depreciation over 36 months at each month-end. On credit, it is also a <b>bill</b> on Owed until you pay it.',
  },

  // ── Money in
  {
    group: 'Money in — other than deals', id: 'otherinc',
    situation: 'A ₹20,000 market study for a Bengaluru builder, invoiced with GST, payable in 30 days.',
    event: 'otherinc',
    values: { date: '2026-11-02', party: 'P7', desc: 'Market study', acc: '4020', amt: 20000, gst: 'yes', gstRate: 18, gstAmt: 3600, total: 23600, sac: '998311', via: 'later', dueDate: '2026-12-02' },
    point: 'Any income can carry a numbered tax invoice. For a <b>service</b> the place of supply is where the client is (IGST Act s.12(2)) — Karnataka, so IGST — unlike brokerage, which follows the property.',
  },
  {
    group: 'Money in — other than deals', id: 'funding',
    situation: 'The director puts ₹3,00,000 in as share capital.',
    event: 'funding',
    values: { date: '2026-09-01', kind: '3000', who: 'Swaminathan N G', amt: 300000, via: '1000' },
    point: '<b>Never income.</b> Ownership, or a loan — either way profit is unchanged.',
  },
  {
    group: 'Money in — other than deals', id: 'bankloan',
    situation: 'A ₹5,00,000 NBFC loan at 12% over 24 months, ₹5,000 processing fee.',
    event: 'bankloan',
    values: { date: '2026-11-01', lender: { __new: true, name: 'Bajaj Finance', type: 'lender' }, purpose: 'Working capital', amt: 500000, rate: 12, n: 24, fee: 5000 },
    point: 'Cash in, but a liability, not income. The schedule is built so each EMI splits into principal (not a cost) and interest (the cost).',
  },

  // ── Move money
  {
    group: 'Move money — never a cost', id: 'transfer',
    situation: 'Paying the card bill from the bank.',
    event: 'transfer',
    prepare: s => s.txns.push({ id: 'T8', date: '2026-10-12', event: 'expense', desc: 'Meta ads', lines: [{ acc: '5090', dr: 4000 }, { acc: '1402', dr: 720 }, { acc: '2300', cr: 4720 }], totals: { dr: 4720, cr: 4720 }, meta: {}, attachments: [], auto: false, fy: '2026-27', createdBy: 'sample', createdAt: 0 }),
    values: { date: '2026-10-25', kind: '1000>2300', amt: 4720 },
    point: 'Money moving between your own pockets. Nothing is earned or spent.',
  },
  {
    group: 'Move money — never a cost', id: 'emi',
    situation: 'The first EMI on the camera loan.',
    event: 'emi',
    values: { date: '2026-10-05', loan: 'L1', via: '1000', extra: 0 },
    point: 'Most of it returns borrowed money. <b>Only the interest is a cost.</b>',
  },
  {
    group: 'Move money — never a cost', id: 'statutory',
    situation: 'Paying November\'s GST with the return — IGST collected on the market study, IGST credit from the reverse-charge subscription.',
    event: 'statutory',
    values: () => { const v = { date: '2026-12-18', kind: 'gst', month: '2026-11', late: 0 }; EV.statutory.onchange('month', v); return v; },
    point: 'Remitting what you collected. Credit is set off the way GSTR-3B does it (Rule 88A): IGST credit first, then CGST against CGST and SGST against SGST — never across. Reverse-charge tax must be paid in cash.',
  },
];

// Things the forms refuse. Each runs the real validator, so the message shown is the one the
// form would show.
const GUARDS = [
  { title: 'An expense from petty cash the box cannot cover', event: 'expense', values: { date: '2026-11-01', desc: 'Auto fares', acc: '5050', amt: 25000, gst: 'no', via: '1010' } },
  { title: 'Paying a vendor more than you owe, with "do not allow"', event: 'paybill', values: { date: '2026-11-01', party: 'P2', amt: 50000, via: '1000', useAdvance: 'no', over: 'stop' } },
  { title: 'A client who owes nothing "paying"', event: 'dealpay', values: { date: '2026-11-01', party: 'P1', amt: 500, via: '1000' } },
  { title: 'Recording the same service month twice', event: 'confirmcharge', values: { sub: 'S2', month: '2026-10', date: '2026-10-06', result: 'paid', amt: 1800, gst: 'no', rcm: 'no' } },
  { title: 'A new plan starting before the month being recorded', event: 'confirmcharge', values: { sub: 'S2', month: '2026-12', date: '2026-12-05', result: 'paid', amt: 10000, gst: 'no', rcm: 'no', newPlan: 'yes', newAmount: 12000, newFrom: '2026-10' } },
  { title: 'GST figures that do not add up', event: 'expense', values: { date: '2026-11-01', desc: 'Printer', acc: '5100', amt: 1000, gst: 'yes', gstRate: 18, gstAmt: 180, total: 2000, via: '1000' } },
  { title: 'A GSTIN that is not 15 characters', event: 'bill', values: { date: '2026-11-01', vendor: 'P2', desc: 'x', acc: '5120', rcm: 'no', amt: 1000, gst: 'yes', gstRate: 18, gstAmt: 180, total: 1180, vgstin: 'ABC123' } },
  { title: 'A write-off with no reason', event: 'writeoff', values: { date: '2026-11-01', deal: 'D1', from: 'buyer', amt: 1000, why: '' } },
  { title: 'An "asset" below your capitalisation threshold', event: 'asset', values: { date: '2026-11-01', name: 'Mouse', amt: 800, gst: 'no', life: 36, how: '1000' } },
  { title: 'A date a year in the future (a typo in the year)', event: 'expense', values: { date: '2028-01-01', desc: 'x', acc: '5100', amt: 10, gst: 'no', via: '1000' } },
  { title: 'A GST purchase with no vendor — allowed, with a warning', event: 'expense', values: { date: '2026-11-01', desc: 'Stationery', acc: '5100', amt: 500, gst: 'yes', gstRate: 18, gstAmt: 90, total: 590, via: '1000' } },
];

// ═══════ RENDER ═══════

export function renderGuide() {
  const tabs = [
    ['start', 'Start here'],
    ['sop', 'How-to'],
    ['actions', 'Every action'],
    ['scenarios', 'Worked examples'],
    ['charts', 'Pictures'],
    ['faq', 'FAQ & glossary'],
  ];
  const q = query.trim().toLowerCase();
  const body = q ? searchAll(q) : (({ start: startHere, sop: sopTab, actions: actionsTab, scenarios: scenariosTab, charts: chartsTab, faq: faqTab })[tab] || startHere)();
  return `
    <h1>Guide</h1>
    <p class="lead">You record what happened; the books keep themselves. This is the manual — for
    someone who has never kept books, and for the accountant checking them.</p>

    <div class="guide-bar">
      <div class="seg" role="tablist">
        ${tabs.map(([k, l]) =>
    `<button type="button" role="tab" aria-selected="${tab === k && !q}" class="${tab === k && !q ? 'on' : ''}"
           onclick="finGuide.setTab('${k}')">${esc(l)}</button>`).join('')}
      </div>
      <input type="search" id="guideFind" value="${esc(query)}" placeholder="Search the guide — token, GST, upgrade, petty cash…"
        aria-label="Search the guide" oninput="finGuide.find(this.value)" autocomplete="off">
    </div>

    ${body}`;
}

// Every tab is a list of items {title, html, text}; search filters across all of them.
function searchAll(q) {
  const all = [
    ['Start here', startItems()], ['How-to', sopItems()], ['Every action', actionItems()],
    ['Worked examples', scenarioItems()], ['FAQ & glossary', faqItems()],
  ];
  const hits = all.map(([name, items]) => [name, items.filter(it => it.text.includes(q))]).filter(([, items]) => items.length);
  if (!hits.length) return empty(`Nothing in the guide matches "<b>${esc(q)}</b>". Try a different word, or clear the search.`);
  return hits.map(([name, items]) => `<h2>${esc(name)}</h2>${items.map(it => it.html).join('')}`).join('');
}

const strip = html => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
const item = (title, html) => ({ title, html, text: strip(title + ' ' + html) });

// ═══════ 1. START HERE ═══════

function startItems() {
  return [
    item('The one idea', note('<b>The one idea.</b> Money moving and cost happening are two different things. A ₹24,000 annual plan is cash out once, but ₹2,000 of cost a month. A ₹15,000 EMI is ₹15,000 of cash out, but only the interest is a cost. A token is cash in that is not income. Keeping those apart is the whole point — it is what makes the profit figure honest.', 'info')),
    item('Three layers', `
      <h2>Three layers, one story</h2>
      <p>Every rupee in these books passes through up to three linked records. Most people only ever wrote down the last one.</p>
      <div class="grid g3">
        <div class="card"><h3>1. Commitment</h3><p class="small muted" style="margin:0">What you <b>expect</b>. A service at ₹1,800 a month. A deal with ₹1,00,000 of brokerage in the pipeline. A loan schedule. Nothing is posted yet.</p></div>
        <div class="card"><h3>2. Document</h3><p class="small muted" style="margin:0">What was <b>billed</b>. A vendor's bill or your own invoice — with a number, a date, a due date, GST, and what has been paid on it so far. This is when profit moves.</p></div>
        <div class="card"><h3>3. Settlement</h3><p class="small muted" style="margin:0">What was <b>paid</b>, matched to the documents it settles. Pay half a bill and it shows part-paid; pay too much and the extra is an advance. Profit does not move.</p></div>
      </div>
      <p class="small muted">The difference between layers is where the answers live. <i>Expected vs billed</i> is the variance on the Services tab. <i>Billed vs paid</i> is the Owed tab. <i>Cash vs profit</i> is the Overview.</p>`),
    item('Colours', `
      <h2>Green in, red out</h2>
      <p>Every action is marked by direction before you read a word of it: <span class="dirtag dir-in">Money in</span> <span class="dirtag dir-out">Money out</span> <span class="dirtag dir-move">Move money</span> <span class="dirtag dir-fix">Correction</span> <span class="dirtag dir-setup">Set up</span>. The same colour runs down the edge of the form and the confirmation, so a red form is always money leaving and a green one always money arriving. Grey moves your own money between pockets — never a cost. Amber corrects something already recorded.</p>`),
    item('What each tab is for', `
      <h2>What each tab is for</h2>
      ${table(`<th>Tab</th><th>What you do there</th>`, [
      ['Overview', 'Your position at a glance — this month\'s profit, what cash is genuinely free to spend, who owes whom, what is due soon.'],
      ['Record', '<b>The only place anything is entered.</b> Pick what happened; the bookkeeping is worked out for you and shown before you save.'],
      ['Transactions', 'Everything recorded, newest first. Tap a row to see both sides of the entry, its attachments, and to reverse it.'],
      ['Owed', 'The weekly worklist: who to chase and who to pay — bill by bill, invoice by invoice, with due dates.'],
      ['Services', 'Every subscription, month by month: what you expected, what was billed, what is paid, why they differ.'],
      ['Deals', 'The pipeline and each deal\'s money — tokens, brokerage, costs, net.'],
      ['Loans', 'Each loan with its principal and interest kept apart, and the next EMI ready to record.'],
      ['Assets', 'What you own and how much value is left in it.'],
      ['Invoices', 'Tax invoices and credit notes, numbered automatically. Download or share the PDF.'],
      ['GST', 'The month\'s liability, credit, set-off and cash due — GSTR-3B the way the rules do it — plus the ITC and GSTR-1 registers.'],
      ['Bank', 'Import the statement and prove your books match reality.'],
      ['Reports / Analytics', 'Profit and loss, trends, where the money went — with filters.'],
      ['Books', 'The accountant\'s view: trial balance, balance sheet, ledgers. The CSV here is what you send your CA.'],
      ['Profile / Settings', 'Who the company is, and how the engine behaves.'],
    ].map(([a, b]) => `<tr><td style="width:26%"><b>${esc(a)}</b></td><td>${b}</td></tr>`).join(''))}`),
    item('The three things to get right', `
      <h2>The three things to get right</h2>
      <div class="grid g1">
        <div class="card"><h3>1. Record it the same day</h3><p class="small muted" style="margin:0">Memory is the weak link, not the software. Open Record, pick what happened, photograph the bill into the entry. Thirty seconds while you still remember what it was for.</p></div>
        <div class="card"><h3>2. Record the bill, then the payment — not one entry for both</h3><p class="small muted" style="margin:0">A bill you will pay later is "Bill received". The payment, when it goes, is "Pay a bill", matched to it. Recording a client payment as fresh income, on top of the invoice, is the single easiest way to believe you earned more than you did.</p></div>
        <div class="card"><h3>3. Reconcile before you close a month</h3><p class="small muted" style="margin:0">The bank statement is the only external check that exists. Twenty minutes a month is what separates books you can rely on from books you hope are right.</p></div>
      </div>`),
    item('Fixing a mistake', `
      <h2>Fixing a mistake</h2>
      <p>Nothing is ever edited or deleted. You post the opposite entry instead, from <b>Transactions → Reverse</b>, and then record it correctly. Both entries stay visible. Reversing a payment gives the bill back its balance; reversing a bill voids it; reversing a service month lets the month be recorded again.</p>
      ${note('That is deliberate, not a limitation. Books you can silently edit are books nobody can trust — including a tax officer, and including you in a year\'s time.')}`),
    item('Warnings and errors', `
      <h2>Warnings and errors on a form</h2>
      <p>Every field is checked as you type. A <span class="ferr err" style="display:inline;padding:2px 8px">red note</span> blocks saving — an amount of zero, a GSTIN of the wrong shape, a petty-cash spend the box cannot cover, the same service month twice. An <span class="ferr warn" style="display:inline;padding:2px 8px">amber note</span> lets you save but tells you what an accountant would ask: a GST purchase with no vendor behind it, a date more than a month ahead.</p>`),
  ];
}
const startHere = () => startItems().map(i => i.html).join('');

// ═══════ 2. HOW-TO (SOP) ═══════

function step(n, title, body, who) {
  return `
    <div class="card" style="display:flex;gap:14px;align-items:flex-start">
      <div style="flex:none;width:30px;height:30px;border-radius:50%;background:var(--brand);color:#fff;
        display:grid;place-items:center;font-weight:700;font-size:14px">${n}</div>
      <div style="flex:1">
        <h3 style="margin:0 0 4px">${esc(title)}</h3>
        <p class="small muted" style="margin:0">${body}</p>
        ${who ? `<p class="small faint" style="margin:6px 0 0">${esc(who)}</p>` : ''}
      </div>
    </div>`;
}

function sopItems() {
  return [
    item('Every day', `<h2>Every day</h2>${step(1, 'Record what happened, as it happens',
      'Money in or out, a bill received, a token taken — open <b>Record</b> and enter it. Attach a photo of the bill to the entry itself, so the evidence and the number never get separated. The form checks every field and shows you the double entry before you save.', 'Under a minute per entry.')}`),
    item('Every week', `<h2>Every week</h2>
      ${step(2, 'Empty the petty cash box', 'Record → <b>Petty cash vouchers</b>. Up to three at once. Then check the box balance on Overview matches the notes in the drawer.')}
      ${step(3, 'Record each service\'s month', 'Services tab → <b>Record a month</b> on anything showing "not yet". Enter the real amount from the card or bank statement; if it differs from what you expected, say why. If the plan is changing, set the new expected amount there and then. Months you skip show as <b>missing</b> until they are recorded or marked not charged.')}
      ${step(4, 'Work the Owed list, both ways', 'Chase the oldest receivable first — overdue invoices are flagged with their due date. Then pay what is due; the payment is matched to the bills it settles, and you can change the split.')}`),
    item('Every month', `<h2>Every month</h2>
      ${step(5, 'Import the bank and card statements', 'Bank tab → pick the account → upload the CSV. The first import asks you to confirm the columns; after that it is one tap.')}
      ${step(6, 'Clear everything unmatched', 'On the statement but not in your books means you forgot to record it — tap <b>Create entry</b>. In your books but not on the statement means it never went through (reverse it) or lands next month (leave it).')}
      ${step(7, 'Run month-end', 'Only once the month shows <b>Reconciled ✓</b>. This posts depreciation and releases the monthly slice of anything paid upfront. Running it twice is harmless — the second run posts nothing.')}
      ${step(8, 'GST by the 20th, TDS by the 7th', 'GST tab → check the month → <b>Pay GST</b> opens the payment with the set-off already worked out. Reverse-charge tax is paid in cash. Then Books → <b>Download journal CSV</b> for your CA.', 'Check current due dates with your CA — they move.')}`),
    item('Once a year', `<h2>Once a year</h2>${step(9, 'Close the financial year',
      'Reports → switch to <b>By financial year</b> and download the P&L. Books → export the year\'s journal and the JSON backup. Hand both to your CA with the bank statements. Ask them about the items listed under "What to confirm with your CA" in the FAQ.')}
      ${note('<b>If you only do one thing:</b> reconcile monthly. Everything else can be caught up later from bills and statements. Books that have never been checked against a bank statement cannot be caught up — you have no way of knowing what is missing.')}`),
    item('Which button', `<h2>Which button? — money out</h2>
      ${table(`<th>What happened</th><th>Use</th>`, [
      ['Paid on the spot — rent, fuel, a print job', '<b>Expense paid now</b>'],
      ['Got a bill, will pay later', '<b>Bill received — pay later</b>, then <b>Pay a bill</b> when you do'],
      ['A subscription was charged or invoiced this month', '<b>Service — record this month\'s bill</b>'],
      ['Spent on one particular deal (EC, patta, lawyer)', '<b>Cost for a deal</b> — choose who bears it'],
      ['Bought something that lasts over a year', '<b>Buy an asset</b>'],
      ['Small cash from the box', '<b>Petty cash vouchers</b>'],
      ['Paid from your own pocket for the company', '<b>Director paid a cost personally</b>'],
      ['Paid the card bill / moved cash to the box', '<b>Move money</b> — not a cost'],
      ['Paid an EMI', '<b>Pay an EMI</b> — only the interest is a cost'],
      ['Paid GST, TDS or PF', '<b>Pay to government</b> — not a cost'],
      ['Vendor refunded you or sent a credit note', '<b>Vendor refunded you / credit note</b>'],
    ].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join(''))}
      <h2>Which button? — money in</h2>
      ${table(`<th>What happened</th><th>Use</th>`, [
      ['A client gave a token or advance before registration', '<b>Token / advance received</b> — not income'],
      ['The deal registered', '<b>Deal closed — brokerage earned</b> — this is the income; the invoice is raised'],
      ['A client paid what they owe', '<b>Client pays what they owe</b> — matched to their invoices'],
      ['Consultancy, a referral fee, interest', '<b>Other income</b> — invoice optional'],
      ['Capital or a director\'s loan came in', '<b>Capital / director loan received</b> — never income'],
      ['A bank or NBFC loan came in', '<b>Bank / NBFC loan</b> — creates the EMI schedule'],
    ].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join(''))}`),
  ];
}
const sopTab = () => sopItems().map(i => i.html).join('');

// ═══════ 3. EVERY ACTION — GENERATED FROM THE ENGINE ═══════
//
// For each button on the Record screen: what it is for, its direction, and every field with its
// hint, read from the live definitions inside the sample books. Fields that only appear for
// certain answers are listed under the answer that reveals them, so nothing is hidden.

function actionItems() {
  const out = [];
  for (const [group, items] of CHOOSER) {
    for (const it of items) {
      const ev = EV[it.key];
      if (!ev) continue;
      const fields = withSample(() => describeFields(it.key, it.preset || {}));
      const html = `
        <div class="card guide-action">
          <h3 style="margin:0 0 4px">${esc(it.label || ev.title)} ${dirTag(it.key)}</h3>
          <p class="small faint" style="margin:0 0 8px">${esc(group)}${it.sub ? ' · ' + esc(it.sub) : ''}</p>
          <div class="when" style="margin:0 0 10px">${ev.when}</div>
          <details class="journal"><summary>The fields on this form (${fields.length})</summary>
            <div class="tbl-wrap"><table><thead><tr><th>Field</th><th>What to enter</th></tr></thead>
            <tbody>${fields.map(f => `<tr><td style="width:34%"><b>${esc(f.label)}</b>${f.appears ? `<br><span class="small faint">appears when ${esc(f.appears)}</span>` : ''}</td><td class="small">${f.hint || (f.type === 'select' ? 'Choose one: ' + esc(f.opts) : f.type === 'alloc' ? 'Which bills or invoices the payment settles. Proposed oldest-first; edit any row.' : f.type === 'party' ? 'Pick from your parties or add a new one by name.' : f.type === 'deal' ? 'Pick the deal.' : f.type === 'property' ? 'Search your dashboard by code or name.' : '')}</td></tr>`).join('')}</tbody></table></div>
          </details>
        </div>`;
      out.push(item(it.label || ev.title, html));
    }
  }
  return out;
}

// Walk the form the way a person would: default answers first, then flip each select to its
// other options to surface the fields they reveal.
function describeFields(key, preset) {
  const seen = new Map();
  const add = (f, vals, appears) => {
    if (seen.has(f.k)) return;
    const hint = typeof f.hint === 'function' ? (safe(() => f.hint(vals)) || '') : (f.hint || '');
    const opts = f.type === 'select' ? (typeof f.opts === 'function' ? safe(() => f.opts(vals)) || [] : f.opts || []).map(o => o[1]).join(' / ') : '';
    seen.set(f.k, { label: f.label, type: f.type, hint, opts, appears });
  };
  const seed = vals => {
    for (const f of fieldsFor(key, vals)) {
      if (vals[f.k] !== undefined) continue;
      if (f.type === 'select') { const o = typeof f.opts === 'function' ? safe(() => f.opts(vals)) || [] : f.opts || []; vals[f.k] = f.def ?? (o[0] ? o[0][0] : ''); }
      else if (f.def !== undefined) vals[f.k] = f.def;
    }
    return vals;
  };
  const base = seed({ ...preset });
  for (const f of fieldsFor(key, base)) add(f, base, '');
  // Reveal: for each select, try every other option.
  for (const f of fieldsFor(key, base)) {
    if (f.type !== 'select') continue;
    const o = typeof f.opts === 'function' ? safe(() => f.opts(base)) || [] : f.opts || [];
    for (const [val, lbl] of o) {
      if (String(val) === String(base[f.k])) continue;
      const v = seed({ ...base, [f.k]: val });
      for (const g of fieldsFor(key, v)) add(g, v, `${f.label} = ${lbl}`);
    }
  }
  return [...seen.values()];
}
const safe = fn => { try { return fn(); } catch { return null; } };
const actionsTab = () => `<p class="lead">Every button on the Record screen, with every field it can show — read from the app itself, so this list is always current.</p>${actionItems().map(i => i.html).join('')}`;

// ═══════ 4. WORKED EXAMPLES ═══════

function scenarioItems() {
  const groups = [];
  for (const sc of SCENARIOS) {
    let g = groups.find(x => x.name === sc.group);
    if (!g) groups.push(g = { name: sc.group, items: [] });
    g.items.push(sc);
  }
  const out = [];
  for (const g of groups) {
    out.push(item(g.name, `<h2>${esc(g.name)}</h2>`));
    for (const sc of g.items) out.push(item(sc.situation, renderScenario(sc)));
  }
  out.push(item('What the forms refuse', `<h2>What the forms refuse</h2>
    <p class="small muted">Each of these is run through the real validator. Red blocks the save; amber lets it through with a note.</p>
    ${GUARDS.map(renderGuard).join('')}`));
  return out;
}

function scenariosTab() {
  return `
    <p class="lead">Every example is run through the real engine on a sample set of books, so what you see is exactly what the app would do. The sample books are frozen in mid-November 2026: one open deal holding a ₹50,000 token, a lawyer owed ₹10,000 on a bill, an annual CRM plan, a Claude subscription just upgraded with its prorated invoice still unpaid, a camera loan and a laptop.</p>
    ${scenarioItems().map(i => i.html).join('')}`;
}

function renderScenario(sc) {
  const res = withSample(() => {
    try {
      if (sc.prepare) sc.prepare(getState());
      const values = typeof sc.values === 'function' ? sc.values() : { ...sc.values };
      const problems = validateEvent(sc.event, values);
      const out = EV[sc.event].build(values);
      const s = getState();
      const names = {};
      (out.lines || []).forEach(l => {
        if (l.party) names['p' + l.party] = s.parties.find(p => p.id === l.party)?.name || l.party;
      });
      return { out, problems, names };
    } catch (e) { return { error: e.message }; }
  });

  if (!res || res.error) {
    return `<div class="card">${note(`This example could not be built: ${esc(res?.error || 'unknown')}`)}</div>`;
  }
  const { out, problems, names } = res;
  const lines = (out.lines || []).filter(l => num(l.dr) || num(l.cr));
  const dr = lines.reduce((a, l) => a + num(l.dr), 0);
  const cr = lines.reduce((a, l) => a + num(l.cr), 0);
  const balanced = Math.abs(dr - cr) < 0.5;
  const blocking = problems.filter(p => !p.warn);

  return `
    <div class="card guide-scenario dir-${dirOf(sc.event)}">
      <h3>${esc(sc.situation)}</h3>
      <p class="small muted" style="margin:2px 0 12px">Record → <b>${esc(sc.button || EV[sc.event].title)}</b> ${dirTag(sc.event)}</p>
      ${blocking.length ? note('The form would refuse this: ' + esc(blocking[0].msg)) : ''}
      <ul class="effects" style="margin-bottom:10px">${(out.effects || []).map(e => `<li>${e}</li>`).join('')}</ul>
      ${lines.length ? `
        <details class="journal">
          <summary>The double entry this creates</summary>
          <div class="tbl-wrap"><table>
            <thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead>
            <tbody>${lines.map(l => `<tr>
              <td>${esc(A[l.acc]?.name || l.acc)} <span class="small faint">${esc(l.acc)}</span>
                ${l.party ? `<br><span class="small faint">${esc(names['p' + l.party] || '')}</span>` : ''}</td>
              <td class="n">${l.dr ? fmt(l.dr) : ''}</td>
              <td class="n">${l.cr ? fmt(l.cr) : ''}</td></tr>`).join('')}</tbody>
            <tfoot><tr>
              <td class="${balanced ? 'balanced ok' : 'balanced no'}">${balanced ? 'Balanced ✓' : 'Does not balance'}</td>
              <td class="n">${fmt(dr)}</td><td class="n">${fmt(cr)}</td></tr></tfoot>
          </table></div>
        </details>` : '<p class="small faint">Nothing is posted to the ledger — this only sets something up or records an expectation.</p>'}
      ${(out.docs || []).length || (out.allocations || []).length ? `<p class="small muted" style="margin:8px 0 0">${(out.docs || []).map(d => `Creates a <b>${esc(d.coll === 'bills' ? 'bill' : d.coll.replace(/s$/, ''))}</b> record. `).join('')}${(out.allocations || []).length ? `Applied to ${out.allocations.length} document${out.allocations.length === 1 ? '' : 's'}.` : ''}</p>` : ''}
      <div class="when" style="margin:12px 0 0"><b>The point.</b> ${sc.point}</div>
    </div>`;
}

function renderGuard(g) {
  const problems = withSample(() => safe(() => validateEvent(g.event, { ...g.values })) || []);
  return `
    <div class="card" style="padding:12px 16px">
      <b>${esc(g.title)}</b> <span class="small faint">— ${esc(EV[g.event].title)}</span>
      ${problems.length ? problems.map(p => `<div class="ferr ${p.warn ? 'warn' : 'err'}" style="margin-top:6px">${esc(p.msg)}</div>`).join('') : '<div class="ferr warn" style="margin-top:6px">Accepted — no problem found.</div>'}
    </div>`;
}

// ═══════ 5. PICTURES ═══════

function chartsTab() {
  return `
    <p class="lead">Six pictures for the six things that confuse people most about their own books.</p>

    <h2>Expected, billed, paid</h2>
    <div class="card">
      ${serviceStoryChart()}
      <p class="small muted" style="margin:10px 0 0">The Claude subscription across seven months. The grey line is what you <b>expected</b> — ₹1,800, then ₹10,000 from December after the upgrade. The bars are what was <b>billed</b>: the prorated November invoice sits above the line with its reason, and the empty January is a month nobody recorded — which is exactly what the Services tab flags. Hatched means billed but not yet paid.</p>
    </div>

    <h2>Cash is not profit</h2>
    <div class="card">
      ${cashVsProfitChart()}
      <p class="small muted" style="margin:10px 0 0">The same three months, measured two ways.
      October looks terrible on cash because a ₹95,000 laptop was bought and a year of software paid
      for — but almost none of that is October's <i>cost</i>. Judging the business on the cash line
      alone would have you believe you had a disastrous month when you had your best one.</p>
    </div>

    <h2>Paying once, using it all year</h2>
    <div class="card">
      ${prepaidChart()}
      <p class="small muted" style="margin:10px 0 0">₹24,000 leaves your bank in September.
      The cost does not. Each month-end releases ₹2,000, so every month carries the share it used.
      The bar is what you paid; the line is what it actually costs you as you go.</p>
    </div>

    <h2>An EMI is mostly not a cost</h2>
    <div class="card">
      ${emiChart()}
      <p class="small muted" style="margin:10px 0 0">Twelve instalments on the ₹80,000 camera loan.
      Only the small orange slice is an expense — the rest is you giving back money you borrowed.
      Notice the interest shrinking: early EMIs cost you more than later ones.</p>
    </div>

    <h2>What happens to a token</h2>
    <div class="card">
      ${tokenFlowChart()}
      <p class="small muted" style="margin:10px 0 0">A token sits in a holding account, not in income.
      Only one of the three exits turns it into earnings — and even then GST comes out of it first.</p>
    </div>

    <h2>Where a deal's money actually goes</h2>
    <div class="card">
      ${waterfallChart()}
      <p class="small muted" style="margin:10px 0 0">₹1,00,000 of brokerage is not ₹1,00,000 of profit.
      GST was never yours, the referral fee and the EC cost came out of it, and what is left is the
      real number.</p>
    </div>`;
}

// Bars of what was billed against a stepped line of what was expected, straight from the
// sample subscription's month records.
function serviceStoryChart() {
  const rows = withSample(() => {
    const sub = getState().subs.find(x => x.id === 'S2');
    return serviceMonths(sub, '2027-03');
  });
  const W = 620, H = 250, pad = 34, base = 180, top = 30;
  const peak = 12000;
  const step = (W - pad * 2) / rows.length;
  const y = v => base - (v / peak) * (base - top);
  const line = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${pad + i * step},${y(r.expected)} L${pad + (i + 1) * step},${y(r.expected)}`).join(' ');
  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>Expected versus billed for a subscription across seven months, with a prorated upgrade month and a missing month.</title>
      <defs><pattern id="gHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#F58A07"/><line x1="0" y1="0" x2="0" y2="6" stroke="#FFFFFF" stroke-width="2"/></pattern></defs>
      <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="#E7E1D7"/>
      ${rows.map((r, i) => {
    const x = pad + i * step + 8, w = step - 16;
    const billed = r.rec && !r.rec.skipped ? r.actual : 0;
    const h = billed ? Math.max(3, base - y(billed)) : 0;
    const fill = r.status === 'billed' ? 'url(#gHatch)' : '#F58A07';
    const lbl = r.status === 'missing' || r.status === 'due' ? 'missing' : r.status === 'skipped' ? 'skipped' : fmt(billed);
    return `${billed ? `<rect x="${x}" y="${y(billed)}" width="${w}" height="${h}" rx="3" fill="${fill}"/>` : `<rect x="${x}" y="${base - 3}" width="${w}" height="3" fill="#EBC7C3"/>`}
      <text x="${x + w / 2}" y="${(billed ? y(billed) : base) - 7}" text-anchor="middle" font-size="10" font-weight="600" fill="${billed ? '#5A5348' : '#B3261E'}">${esc(lbl)}</text>
      <text x="${x + w / 2}" y="${base + 15}" text-anchor="middle" font-size="10" fill="#8A8174">${esc(mlabel(r.month).slice(0, 3))}</text>
      ${r.rec?.reason ? `<text x="${x + w / 2}" y="${base + 28}" text-anchor="middle" font-size="9" fill="#8A5A00">${esc(r.rec.reason === 'prorate' ? 'prorated' : r.rec.reason)}</text>` : ''}`;
  }).join('')}
      <path d="${line}" fill="none" stroke="#5A5348" stroke-width="2" stroke-dasharray="4 3"/>
      <text x="${pad}" y="${top - 10}" font-size="11" fill="#8A8174">Dashed line: expected. Bars: billed. Hatched: billed, not yet paid.</text>
    </svg>`;
}

// Grouped bars: cash movement against profit for the same months.
function cashVsProfitChart() {
  const data = [
    { m: 'Sep', cash: 120000, profit: -18000 },
    { m: 'Oct', cash: -142000, profit: 64000 },
    { m: 'Nov', cash: 38000, profit: 41000 },
  ];
  const W = 620, H = 280, pad = 34, mid = 118;
  const peak = 150000;
  const groupW = (W - pad * 2) / data.length;
  const bw = 46;

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>Cash movement versus profit for September, October and November. October has the worst cash and the best profit.</title>
      <line x1="${pad}" y1="${mid}" x2="${W - pad}" y2="${mid}" stroke="#E7E1D7"/>
      ${data.map((d, i) => {
    const cx = pad + i * groupW + groupW / 2;
    const bars = [
      { v: d.cash, x: cx - bw - 5, fill: '#17150F', label: 'Cash' },
      { v: d.profit, x: cx + 5, fill: '#F58A07', label: 'Profit' },
    ];
    return bars.map(b => {
      const h = Math.max(2, Math.abs(b.v) / peak * 92);
      const y = b.v >= 0 ? mid - h : mid;
      return `<rect x="${b.x}" y="${y}" width="${bw}" height="${h}" rx="3" fill="${b.fill}"/>
                <text x="${b.x + bw / 2}" y="${b.v >= 0 ? y - 6 : y + h + 14}" text-anchor="middle"
                  font-size="10.5" fill="#5A5348" font-weight="600">${esc(fmt(b.v))}</text>`;
    }).join('') + `<text x="${cx}" y="246" text-anchor="middle" font-size="12" fill="#8A8174">${d.m}</text>`;
  }).join('')}
      <rect x="${pad}" y="264" width="11" height="11" rx="2" fill="#17150F"/>
      <text x="${pad + 17}" y="273" font-size="11" fill="#8A8174">Cash in / out</text>
      <rect x="${pad + 110}" y="264" width="11" height="11" rx="2" fill="#F58A07"/>
      <text x="${pad + 127}" y="273" font-size="11" fill="#8A8174">Profit</text>
    </svg>`;
}

// One tall bar of cash out, then a flat line of monthly cost.
function prepaidChart() {
  const W = 620, H = 210, pad = 34, base = 150;
  const months = Array.from({ length: 12 }, (_, i) => addMonths('2026-09', i));
  const step = (W - pad * 2 - 60) / 12;
  const cashH = 110, costH = cashH * (2000 / 24000) * 6; // exaggerated so ₹2,000 stays visible

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>Twenty-four thousand rupees paid once in September, released as two thousand rupees of cost each month for twelve months.</title>
      <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="#E7E1D7"/>
      <rect x="${pad}" y="${base - cashH}" width="34" height="${cashH}" rx="3" fill="#17150F"/>
      <text x="${pad + 17}" y="${base - cashH - 7}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#5A5348">${esc(fmt(24000))}</text>
      <text x="${pad + 17}" y="${base + 15}" text-anchor="middle" font-size="10.5" fill="#8A8174">paid</text>
      ${months.map((m, i) => {
    const x = pad + 60 + i * step;
    return `<rect x="${x}" y="${base - costH}" width="${step - 5}" height="${costH}" rx="2" fill="#F58A07"/>
              <text x="${x + (step - 5) / 2}" y="${base + 15}" text-anchor="middle" font-size="9" fill="#8A8174">${esc(mlabel(m).slice(0, 3))}</text>`;
  }).join('')}
      <text x="${pad + 60}" y="${base - costH - 8}" font-size="10.5" font-weight="600" fill="#5A5348">${esc(fmt(2000))} of cost a month</text>
      <rect x="${pad}" y="${H - 18}" width="11" height="11" rx="2" fill="#17150F"/>
      <text x="${pad + 17}" y="${H - 9}" font-size="11" fill="#8A8174">Cash out</text>
      <rect x="${pad + 100}" y="${H - 18}" width="11" height="11" rx="2" fill="#F58A07"/>
      <text x="${pad + 117}" y="${H - 9}" font-size="11" fill="#8A8174">Actual monthly cost</text>
    </svg>`;
}

// Stacked bars: principal (not a cost) under interest (the only cost).
function emiChart() {
  const sch = schedule(80000, 14, 12, '2026-10');
  const W = 620, H = 230, pad = 34, base = 165;
  const step = (W - pad * 2) / 12;
  const peak = Math.max(...sch.map(s => s.emi));

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>Twelve EMIs on an eighty thousand rupee loan. Each instalment is mostly principal, with a shrinking slice of interest that is the only real cost.</title>
      <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="#E7E1D7"/>
      ${sch.map((s, i) => {
    const x = pad + i * step;
    const w = step - 6;
    const total = (s.emi / peak) * 120;
    const ih = Math.max(2, (s.int / peak) * 120);
    const ph = Math.max(2, total - ih);
    return `<rect x="${x}" y="${base - ph}" width="${w}" height="${ph}" rx="2" fill="#D3CABC"/>
              <rect x="${x}" y="${base - ph - ih}" width="${w}" height="${ih}" rx="2" fill="#F58A07"/>
              <text x="${x + w / 2}" y="${base + 14}" text-anchor="middle" font-size="9" fill="#8A8174">${s.n}</text>`;
  }).join('')}
      <text x="${pad}" y="${base - 135}" font-size="11" fill="#8A8174">Interest falls from ${esc(fmt(sch[0].int))} to ${esc(fmt(sch.at(-1).int))} a month</text>
      <rect x="${pad}" y="${H - 18}" width="11" height="11" rx="2" fill="#D3CABC"/>
      <text x="${pad + 17}" y="${H - 9}" font-size="11" fill="#8A8174">Principal — not a cost</text>
      <rect x="${pad + 160}" y="${H - 18}" width="11" height="11" rx="2" fill="#F58A07"/>
      <text x="${pad + 177}" y="${H - 9}" font-size="11" fill="#8A8174">Interest — the only cost</text>
    </svg>`;
}

// A small flow diagram. Boxes and arrows, no library.
function tokenFlowChart() {
  const W = 620, H = 210;
  const box = (x, y, w, h, fill, stroke, label, sub, textFill = '#17150F') => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}"/>
    <text x="${x + w / 2}" y="${y + (sub ? 24 : h / 2 + 4)}" text-anchor="middle" font-size="12.5" font-weight="600" fill="${textFill}">${esc(label)}</text>
    ${sub ? `<text x="${x + w / 2}" y="${y + 42}" text-anchor="middle" font-size="10.5" fill="#8A8174">${esc(sub)}</text>` : ''}`;
  const arrow = (x1, y1, x2, y2) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#B3ABA0" stroke-width="1.5" marker-end="url(#gArrow)"/>`;

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>A token is received into a holding account, and leaves it in one of three ways: refunded, adjusted against the invoice, or forfeited to income.</title>
      <defs><marker id="gArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M0,0 L10,5 L0,10 z" fill="#B3ABA0"/></marker></defs>

      ${box(14, 78, 130, 54, '#FDF1E3', '#F9C88A', 'Token received', 'Cash in')}
      ${arrow(148, 105, 196, 105)}
      ${box(200, 70, 140, 70, '#17150F', '#17150F', 'Held for client', 'Not income', '#FAF7F2')}

      ${arrow(344, 92, 396, 42)}
      ${arrow(344, 105, 396, 105)}
      ${arrow(344, 118, 396, 168)}

      ${box(400, 16, 206, 50, '#FFFFFF', '#E7E1D7', 'Refunded', 'Cash out · profit untouched')}
      ${box(400, 80, 206, 50, '#FFFFFF', '#E7E1D7', 'Adjusted on the invoice', 'Becomes income at registration')}
      ${box(400, 144, 206, 50, '#FDF1E3', '#F9C88A', 'Forfeited', 'Income now, less GST')}
    </svg>`;
}

// Waterfall from gross brokerage down to what you keep.
function waterfallChart() {
  const steps = [
    { label: 'Invoiced', v: 118000, kind: 'start' },
    { label: 'GST', v: -18000, kind: 'down' },
    { label: 'Referral fee', v: -15000, kind: 'down' },
    { label: 'EC & legal', v: -10000, kind: 'down' },
    { label: 'You keep', v: 75000, kind: 'end' },
  ];
  const W = 620, H = 235, pad = 34, base = 170, top = 26;
  const step = (W - pad * 2) / steps.length;
  const peak = 118000;
  const h = v => (Math.abs(v) / peak) * (base - top);

  let running = 0;
  const bars = steps.map((s, i) => {
    const x = pad + i * step + 10;
    const w = step - 26;
    let y, height, fill;
    if (s.kind === 'start') { height = h(s.v); y = base - height; running = s.v; fill = '#17150F'; }
    else if (s.kind === 'end') { height = h(s.v); y = base - height; fill = '#F58A07'; }
    else { height = h(s.v); running += s.v; y = base - h(running) - height; fill = '#D3CABC'; }
    return `<rect x="${x}" y="${y}" width="${w}" height="${height}" rx="3" fill="${fill}"/>
      <text x="${x + w / 2}" y="${y - 6}" text-anchor="middle" font-size="10.5" font-weight="600"
        fill="${s.kind === 'down' ? '#B3261E' : '#5A5348'}">${s.kind === 'down' ? '−' : ''}${esc(fmt(Math.abs(s.v)))}</text>
      <text x="${x + w / 2}" y="${base + 16}" text-anchor="middle" font-size="10.5" fill="#8A8174">${esc(s.label)}</text>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>A one lakh eighteen thousand rupee invoice reduces to seventy-five thousand kept, after GST, a referral fee and deal costs.</title>
      <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="#E7E1D7"/>
      ${bars}
      <text x="${pad}" y="${H - 8}" font-size="11" fill="#8A8174">GST was never yours — you collected it for the government.</text>
    </svg>`;
}

// ═══════ 6. FAQ & GLOSSARY ═══════

const FAQ = [
  ['Basics', [
    ['A client paid me. Why has my profit not gone up?',
      'Because it already did, on the day the deal registered and you raised the invoice. That is when you earned the money. The payment is just the cash arriving afterwards, matched to that invoice. If receiving it increased profit too, you would be counting the same brokerage twice. <span class="small faint">Accrual basis — income is recognised when earned, not when received.</span>'],
    ['My bank balance is healthy but the app says I made a loss. Which is right?',
      'Both. Cash includes money that is not yours — client tokens you are holding, GST you owe the government, bills you have not paid yet. That is what <b>"free to use"</b> on the Overview is for: it strips those out. A loss with cash in the bank usually means you are holding other people\'s money.'],
    ['What is the difference between an expense and a bill?',
      'Timing. An <b>expense</b> is used and paid in the same moment. A <b>bill</b> is a cost you have incurred but not yet paid — it goes on Owed with a due date, and the payment is a separate entry matched to it. Both hit profit on the day of the cost; only the cash timing differs.'],
    ['What does "allocated" mean on a payment?',
      'Which bills (or invoices) the money settled. When you pay a vendor the form proposes the split oldest-first and you can change it — "this ₹3,000 is for the October bill". Each bill then shows open, part-paid or paid, and the Owed tab lists exactly what is still outstanding. Reversing the payment gives the bills their balance back.'],
    ['I paid a vendor more than I owed. Where did the extra go?',
      'Into <b>Advances to vendors</b> — your money, shown on Owed. The next time you pay them the advance is used first. If it was a typo, reverse the payment and record it again; or choose "Do not allow" on the form and it refuses until the amount matches.'],
    ['Why can\'t I record a payment from a client who owes nothing?',
      'Because there is nothing to pay. Money that arrives ahead of a deal is a <b>token</b> — record it as one and it is held for the client until the invoice is raised. This stops an advance being mistaken for income.'],
    ['What do the green and red edges mean?',
      'Direction. Green is money arriving, red is money leaving, grey is money moving between your own pockets (never a cost), amber is a correction, plain is set-up. The colour follows the entry from the button to the form to the confirmation.'],
    ['What is the INR / USD toggle?',
      'A reading aid only. It converts every displayed rupee figure at today\'s rate so a figure can be sized for someone who thinks in dollars. Nothing is stored in dollars; invoices and exports stay in rupees.'],
  ]],
  ['Services and subscriptions', [
    ['I upgraded a plan mid-month and got a prorated invoice. How do I record all of it?',
      'One form: Services → <b>Record a month</b>. Enter the real invoice amount, choose "Invoice received — I will pay it later" (or "paid" if it was auto-charged), pick the reason "Plan changed mid-month", and answer <b>yes</b> to "Does the expected amount change from here?" with the new price and the month it starts. The month is recorded with its variance, the invoice sits on Owed with its due date, and every month from the start month expects the new amount. Earlier months keep the old expectation. Pay the invoice later with "Pay a bill" and it is matched to that month.'],
    ['The price is changing next quarter but there is no bill yet.',
      '<b>Change a plan (no bill yet)</b>. It only alters what the months ahead expect. Nothing is posted.'],
    ['A month shows as "missing" on the Services tab.',
      'The service was running but nothing was recorded for that month — so the books do not know that cost. Either record it (from the card statement) or mark it "Not charged this month". Missing months quietly make the run-rate and profit wrong, which is why they are flagged.'],
    ['Anthropic, Google and Meta bill me from abroad with no GST. Do I owe GST?',
      'Yes — an import of services is taxed in your hands under <b>reverse charge</b> (IGST Act s.5(3) with Notification 10/2017-IT(R)). Switch "Reverse charge" on when recording the month. The app books IGST as a liability you pay in cash with the return and, at the same time, as your input credit. It is neither owed to the vendor nor a cost. Meta billed from its Indian entity charges GST normally — check the invoice.'],
    ['A subscription paid for a year — why does only a twelfth show as cost each month?',
      'Because you used a twelfth of it. The rest is <b>prepaid</b> — an asset, money with the vendor. Month-end releases each month\'s slice. Cancel early and the unused part is refunded or written off.'],
    ['I recorded a service month with the wrong amount.',
      'Transactions → Reverse the entry. The bill behind it is voided, the month is unmarked, and you can record it again correctly.'],
  ]],
  ['Money out', [
    ['I bought a laptop. Why is it not an expense?',
      'It will still be working in two years, so charging the whole cost to one month would make that month look far worse than it was and every later month better. Instead it becomes an asset and a slice of it becomes a cost each month at month-end. Anything under your capitalisation threshold in Settings is just an expense — the form will say so.'],
    ['I paid a ₹15,000 EMI. Why did my costs only go up by about ₹900?',
      'Because most of an EMI is you repaying money you borrowed — that was never income, so giving it back is not a cost. Only the interest is. The Loans tab shows each instalment\'s split.'],
    ['The vendor gave me a credit note. Is that income?',
      'No — it reduces the original cost, and gives back the GST credit claimed on it. Record it with <b>Vendor refunded you / credit note</b>. Against an unpaid bill it is applied to that bill, so what you owe drops; as a refund it comes back into the bank or the card.'],
    ['The petty cash form refused my entry.',
      'The box does not hold enough. Top it up first with <b>Move money → Bank → petty cash</b>, then enter the vouchers. The form never lets the box go negative, because a negative box means an entry was missed.'],
    ['I paid something on my personal card for the company.',
      '<b>Director paid a cost personally</b>. The cost is recorded now and the company owes you; reimburse yourself later with Move money. GST on it is still input credit if the invoice is in the company\'s name.'],
  ]],
  ['Deals and tokens', [
    ['When does a token become my money?',
      'When the deal registers and you record <b>Deal closed</b> — it comes off what the client owes you. Or if they walk away and agree you keep it, in which case use <b>Settle a token</b> → Keep, and it becomes income under Forfeited advances, less GST.'],
    ['A client paid half the invoice.',
      'Record the half with <b>Client pays what they owe</b>. The invoice shows part-paid with the balance still on Owed, ageing from the due date. Record the rest when it comes; it is matched to the same invoice.'],
    ['What happens to the invoice if I reverse a closed deal?',
      'A <b>credit note</b> is issued automatically against the original invoice number, because GST does not allow an invoice to simply disappear. Both appear on the Invoices tab and in the GSTR-1 register.'],
    ['Why does a client from Bengaluru still get CGST+SGST on brokerage?',
      'Because for brokerage the place of supply is where the <b>property</b> is, not where the client lives (IGST Act s.12(3)(a)). A Chennai flat sold to a Bengaluru buyer is a Tamil Nadu supply. IGST only arises when the property itself is in another state — set that on the deal. For a consultancy service the opposite holds: it follows the client (s.12(2)).'],
  ]],
  ['GST', [
    ['Where do I see what GST to pay this month?',
      'The <b>GST tab</b>. Pick the month and it shows the liability per head, the credit available, the set-off in the order the rules allow (IGST credit first, then CGST against CGST and SGST against SGST — never across; Rule 88A), and the cash due. Reverse-charge tax is always cash. <b>Pay GST</b> opens the payment already filled in.'],
    ['I entered GST on a purchase. Why is it marked "at risk" / a warning?',
      'A credit claim rests on a tax invoice from a registered vendor. Enter the <b>vendor GSTIN and invoice number</b> when you record the bill — that is what GSTR-2B matches against (s.16(2)(aa)). Without them the credit is a figure in your books the government will never accept. The form warns you; the ITC register shows it as ineligible until the details are on it.'],
    ['I paid GST on lunch for the team. Why is it not showing as input credit?',
      'Input credit on food and beverages, and on running vehicles, is blocked by s.17(5). The app knows this: on Staff welfare & food and Conveyance & fuel the tax is added to the cost instead of being parked as a claim you could never make.'],
    ['The lawyer\'s bill had no GST. Do I still owe some?',
      'Under <b>reverse charge</b>, yes. Legal services from an advocate are taxed in the recipient\'s hands (Notification 13/2017-CT(R)): choose "Reverse charge — yes" on the bill and the app books the tax as a liability you pay in cash with the return, and at the same time as your input credit. The vendor is owed only the bare fee.'],
    ['Can I invoice something that is not a deal?',
      'Yes. <b>Other income</b> with GST on and a client named raises a numbered tax invoice like a deal does, with its own SAC code (998311 for consultancy). Choose "Not yet — the client will pay later" and it becomes a receivable on Owed with a due date.'],
  ]],
  ['Fixing things, month-end and your CA', [
    ['I recorded something wrong. Can I just fix the number?',
      'No, and that is on purpose. Go to Transactions, open the entry, and press <b>Reverse</b>. That posts a mirror-image entry so the two cancel out, then you record it correctly. Both stay visible. Reversal also unwinds what the entry touched: a payment gives its bills their balance back; a bill is voided; a service month is unmarked.'],
    ['Do I have to reconcile every month?',
      'You should. It is the only check on your books that comes from outside them. Month-end will warn you if the month is not reconciled, and you can override — but the override is recorded against your name.'],
    ['What happens if I run month-end twice?',
      'Nothing. It knows which months each asset and prepaid plan have already been processed for, so a second run posts no entries at all.'],
    ['What do I actually send my accountant?',
      'Books tab → <b>Download journal CSV</b>. That is every entry with both sides and account names. There is a Tally-shaped export next to it, the GST registers export from the GST tab, and <b>Export everything (JSON)</b> is the backup to take before any big change.'],
    ['What should I confirm with my CA?',
      '<b>Forfeited tokens</b> — the app charges GST on a kept token by default; CBIC Circular 178/10/2022 treats many forfeitures as not a supply, so your CA may say to enter 0. <b>Foreign subscriptions</b> — confirm which vendors bill from abroad (reverse charge) and which from an Indian entity (normal GST). <b>TDS</b> — switch the fields on in Settings when your CA says to start deducting; the app applies the rate you enter and shows the year\'s running total against the threshold. <b>Depreciation</b> — the books use straight-line over useful life; the tax computation uses WDV blocks, which your CA redoes. <b>Tokens</b> — held for the client and not taxed; if any part is really your own advance brokerage, GST is due on receipt (s.13(2)).'],
    ['Where do my bill photos go?',
      'Into a <b>3PIN Finance</b> folder in your Google Drive, inside the Sales Properties folder, organised as financial year then entry. You can change the folder in Settings → Attachments.'],
    ['I have not entered my opening balances yet. Does it matter?',
      'Yes — until you do, the books think you started from nothing, so your balance sheet and cash figures are wrong. Go to Overview → Enter opening balances. That screen locks after one use, so do it carefully, ideally with your CA.'],
  ]],
];

const GLOSSARY = [
  ['Accrual', 'Recording a cost or income when it happens, not when the cash moves. A bill dated the 28th is a cost of that month even if paid in the next.'],
  ['Advance (to a vendor)', 'Money you paid a vendor beyond their bills. Yours until a bill uses it. Account 1550.'],
  ['Allocation', 'Matching a payment to the specific bills or invoices it settles. What makes "part-paid" and "which bill is still open" possible.'],
  ['Bill', 'A vendor\'s demand for payment — a document with a number, a date, a due date, GST and what has been paid on it. Created by "Bill received", a deal cost on credit, an asset on credit, or a service month.'],
  ['Credit note', 'A document reducing an earlier invoice or bill. Issued by you when a deal is reversed; received from a vendor when they reduce what you owe.'],
  ['Depreciation', 'The slice of an asset\'s cost that becomes an expense each month over its useful life. Posted automatically at month-end. Account 5200 against 1350.'],
  ['Expected vs billed (variance)', 'The difference between what a service was expected to cost this month and what the vendor actually billed — with a reason. Shown on the Services tab.'],
  ['Input tax credit (ITC)', 'GST you paid on purchases that you may set off against GST you collected. Needs a proper tax invoice with the vendor\'s GSTIN. Accounts 1400–1402.'],
  ['Invoice', 'Your demand for payment — numbered, with GST, a due date, and what has been paid on it. Raised when a deal closes or on other income.'],
  ['Month-end', 'The routine that posts depreciation and releases prepaid slices for a month. Safe to repeat.'],
  ['Place of supply', 'Where a supply is taxed: for brokerage, where the property is; for a service, where the client is. Decides CGST+SGST (same state) or IGST (another state).'],
  ['Prepaid', 'Something paid for ahead of using it — an annual plan. An asset until each month\'s slice is released. Account 1200.'],
  ['Receivable / payable', 'What clients owe you (1100) and what you owe vendors (2000). Both are lists of documents on Owed.'],
  ['Reconcile', 'Proving the books match the bank statement, line by line.'],
  ['Reverse charge (RCM)', 'GST paid by the buyer instead of the seller — advocates, goods transport, and vendors abroad. Paid in cash with the return and claimed back as credit. Account 2205.'],
  ['Reversal', 'The mirror-image entry that cancels a wrong one. Nothing is ever deleted.'],
  ['Run-rate', 'What your services are expected to cost per month, plan changes included.'],
  ['TDS', 'Tax deducted at source — withheld from a payment and deposited with the government on the payee\'s behalf. Off by default; switch on in Settings.'],
  ['Token', 'Money a client hands over before a deal registers. Held for them (2100), not income, until the invoice adjusts it or they forfeit it.'],
  ['Trial balance', 'Every account\'s balance in one list; debits must equal credits. Books tab.'],
];

function faqItems() {
  const out = [];
  for (const [group, qs] of FAQ) {
    out.push(item(group, `<h2>${esc(group)}</h2>`));
    for (const [q, a] of qs) {
      out.push(item(q, `
        <details class="journal guide-faq">
          <summary>${esc(q)}</summary>
          <p class="small muted" style="margin:8px 0 0">${a}</p>
        </details>`));
    }
  }
  out.push(item('Glossary', `<h2>Glossary</h2>${table(`<th>Term</th><th>Meaning</th>`, GLOSSARY.map(([t, d]) => `<tr><td style="width:26%"><b>${esc(t)}</b></td><td class="small">${d}</td></tr>`).join(''))}`));
  return out;
}

function faqTab() {
  return `
    <p class="lead">The questions that come up first, in plain words — with the rule an accountant would cite where it matters.</p>
    ${faqItems().map(i => i.html).join('')}
    ${note('Still stuck, or something looks wrong? Export the JSON backup from the Books tab before changing anything, then ask. A backup costs nothing and makes every problem reversible.')}`;
}

// ═══════ TAB STATE ═══════

if (typeof window !== 'undefined') {
  window.finGuide = {
    setTab(t) { tab = t; query = ''; window.fin.repaint(); },
    find(q) {
      query = q;
      // Re-render without losing the caret: only the body below the bar changes.
      window.fin.repaint();
      const el = typeof document !== 'undefined' ? document.getElementById('guideFind') : null;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    },
  };
}
