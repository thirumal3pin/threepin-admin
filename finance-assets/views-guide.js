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
  A, ACCOUNTS, fmt, esc, num, ym, addMonths, mlabel, today,
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
    T('T0a', '2026-09-04', 'asset', 'Asset — Sony A7 camera', [{ acc: '1300', dr: 80000 }, { acc: '2300', cr: 80000 }]),
    T('T0b', '2026-09-20', 'card2emi', 'Card → EMI: Sony A7 camera', [{ acc: '2300', dr: 80000 }, { acc: '2400', cr: 80000, party: 'P4' }]),
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

// The rent story the "A cost from guess to settled" examples run on: a landlord, a monthly
// commitment, then the same commitment at each later stage. Each example prepares only as
// much of it as it needs, so every card can be read on its own.
function rentSample(s) {
  s.parties.push({ id: 'P9', name: 'K. Raman (landlord)', type: 'vendor' });
  s.subs.push({
    id: 'S3', name: 'Office rent', kind: 'rent', acc: '5000', vendor: 'K. Raman (landlord)', vendorId: 'P9',
    use: 'The office', payMode: 'monthly', billing: 'invoice', amount: 20000, monthly: 20000, via: '1000',
    start: '2026-09', end: null, months: 1, history: [{ from: '2026-09', amount: 20000, plan: '' }],
    amortized: [], charges: {}, status: 'active',
  });
}
function rentAccrued(s) {
  rentSample(s);
  s.subs.find(x => x.id === 'S3').charges['2026-11'] = { actual: 20000, expected: 20000, variance: 0, paid: false, billId: 'B5', date: '2026-11-30' };
  s.bills.push({
    id: 'B5', partyId: 'P9', vendorName: 'K. Raman (landlord)', billNo: '', date: '2026-11-30', dueDate: null,
    desc: 'Office rent — Nov 2026', acc: '5000', taxable: 20000, gst: 0, rcm: 0, tds: 0, total: 20000, net: 20000,
    paid: 0, status: 'open', serviceId: 'S3', month: '2026-11', period: '2026-11', accrued: true,
    txnId: 'T10', allocations: [], no: 8,
  });
  s.txns.push({
    id: 'T10', date: '2026-11-30', event: 'confirmcharge', desc: 'Office rent — Nov 2026',
    lines: [{ acc: '5000', dr: 20000 }, { acc: '2000', cr: 20000, party: 'P9' }],
    totals: { dr: 20000, cr: 20000 }, meta: {}, attachments: [], auto: false, fy: '2026-27', createdBy: 'sample', createdAt: 0,
  });
}
function rentTrued(s) {
  rentAccrued(s);
  const b = s.bills.find(x => x.id === 'B5');
  Object.assign(b, { billNo: 'RENT/NOV', date: '2026-12-04', dueDate: '2026-12-15', taxable: 20500, total: 20500, net: 20500, accrued: false });
  s.txns.push({
    id: 'T11', date: '2026-11-30', event: 'billarrived', desc: 'Bill RENT/NOV — Office rent — Nov 2026 (more than recorded)',
    lines: [{ acc: '5000', dr: 500 }, { acc: '2000', cr: 500, party: 'P9' }],
    totals: { dr: 500, cr: 500 }, meta: { billId: 'B5' }, attachments: [], auto: false, fy: '2026-27', createdBy: 'sample', createdAt: 0,
  });
}
// The rent bill part-paid: 20,000 went out, 500 is still showing as owed. The state the
// "Discount on a bill" example starts from.
function rentPartPaid(s) {
  rentTrued(s);
  const b = s.bills.find(x => x.id === 'B5');
  Object.assign(b, { paid: 20000, status: 'part', allocations: [{ txnId: 'T12', amt: 20000, date: '2026-12-15' }] });
  s.txns.push({
    id: 'T12', date: '2026-12-15', event: 'paybill', desc: 'Paid K. Raman (landlord)',
    lines: [{ acc: '2000', dr: 20000, party: 'P9' }, { acc: '1000', cr: 20000 }],
    totals: { dr: 20000, cr: 20000 }, meta: {}, attachments: [], auto: false, fy: '2026-27', createdBy: 'sample', createdAt: 0,
    allocations: [{ coll: 'bills', id: 'B5', amt: 20000 }],
  });
}

const SCENARIOS = [
  // ── One cost through all four of its states
  {
    group: 'A cost from guess to settled', id: 'lc-event', button: 'Recurring — record this month',
    situation: 'The office rent is about 20,000 a month. All month it sits on This month as an estimate, in no account anywhere. Now November is over and you used the office; the landlord has sent nothing yet.',
    event: 'confirmcharge',
    prepare: s => rentSample(s),
    values: { sub: 'S3', month: '2026-11', date: '2026-11-30', result: 'invoice', amt: 20000, rcm: 'no' },
    point: 'The estimate becomes an <b>event</b>. November carries the cost and the landlord appears on Owed — and still no money has moved. The bill is marked <b>awaited</b> because it has no vendor bill number yet. An estimate is never posted; recording the month is what replaces it, so nothing is ever counted twice. <span class="small faint">(Dr 5000 Rent / Cr 2000 Payable.)</span>',
  },
  {
    group: 'A cost from guess to settled', id: 'lc-billarrived', button: 'Bill arrived for a month already recorded',
    situation: 'On 4 December the landlord\u2019s bill turns up. It says 20,500, payable by the 15th.',
    event: 'billarrived',
    prepare: s => rentAccrued(s),
    values: { billId: 'B5', vinv: 'RENT/NOV', date: '2026-12-04', dueDate: '2026-12-15', amt: 20500, gstAmt: 0 },
    point: 'The number and the due date go onto the record you already made. The extra 500 is posted <b>back into November</b> — the month the office was used — so November\u2019s profit is right and December is not made to carry it. December now shows the whole 20,500 under <b>Due this month</b>.',
  },
  {
    group: 'A cost from guess to settled', id: 'lc-paid', button: 'Pay a bill',
    situation: 'You pay it on the 15th, out of the bank.',
    event: 'paybill',
    prepare: s => rentTrued(s),
    values: () => ({ date: '2026-12-15', party: 'P9', amt: 20500, via: '1000', useAdvance: 'no', alloc: allocate(20500, openBills('P9'), billOutstanding).rows }),
    point: 'The money leaves and is matched to that bill, which closes. <b>Profit does not move</b> — it was counted in November. On This month the amount shifts from <b>Due</b> to <b>Paid</b>, and the cash book shows it on the 15th. Four screens, four states, one cost, counted once.',
  },
  {
    group: 'A cost from guess to settled', id: 'lc-discount', button: 'Pay a vendor bill',
    situation: 'The landlord takes ₹20,000 and lets the ₹500 go. Same moment, one entry.',
    event: 'paybill',
    prepare: s => rentTrued(s),
    values: () => ({ date: '2026-12-15', party: 'P9', amt: 20000, short: 500, shortWhy: 'discount', via: '1000', useAdvance: 'no', alloc: allocate(20500, openBills('P9'), billOutstanding).rows }),
    point: 'Put the ₹500 in <b>Amount not being paid</b> and say why. The bank shows ₹20,000 out and nothing more; the bill still closes in full; the ₹500 comes off the rent — the rent simply cost ₹20,000. It is not income: nothing came in. Had this bill carried GST, the credit on the ₹500 would come back in the same entry — you never paid it, so it cannot stand. <span class="small faint">(Dr 2000 20,500; Cr 1000 20,000; Cr 5000 500.)</span>',
  },
  {
    group: 'A cost from guess to settled', id: 'lc-discount-later', button: 'Close what is left on a bill',
    situation: 'You paid ₹20,000 last week; the ₹500 has been sitting on Owed since. Today the landlord says forget it.',
    event: 'billclose',
    prepare: s => rentPartPaid(s),
    values: { date: '2026-12-22', party: 'P9', bill: 'B5', amt: 500, why: 'discount' },
    point: '<b>No money moves.</b> The ₹500 leaves what you owe, the bill closes, and it never appears as money out. <b>Say why</b>: a waiver, a <b>credit note</b> and a <b>write-off</b> all come off the original cost — a bill let off is a smaller bill, not income — and the GST credit on that part comes back (Rule 37; s.34(2) for the note); <b>TDS</b> is owed to the government by the 7th and touches no credit at all. The button is on the bill\'s row on Owed and in the entry\'s drawer. <span class="small faint">(Dr 2000 500; Cr 5000 500 — plus the credit back if the bill had GST.)</span>',
  },
  // ── Deals
  {
    group: 'Deals — from token to cash', id: 'token',
    situation: 'A buyer hands you ₹50,000 as a token before registration.',
    event: 'token',
    values: { date: '2026-09-10', deal: 'D1', from: 'buyer', amt: 50000, via: '1000' },
    point: 'It is <b>not income</b>. The deal has not happened. It is held for the client and your profit does not move. <span class="small faint">(Cr 2100 Client advances held.)</span>',
  },
  {
    group: 'Deals — from token to cash', id: 'token-cash',
    situation: 'The same token, but handed over as ₹50,000 in notes across the desk.',
    event: 'token',
    values: { date: '2026-09-10', deal: 'D1', from: 'buyer', amt: 50000, via: '1010' },
    point: 'Identical entry, different account: it lands in the <b>cash box</b> rather than the bank. Every money question on a deal offers both, because half of what a brokerage takes never touches a bank the day it arrives. <span class="small faint">(Dr 1010 instead of Dr 1000.)</span>',
  },
  {
    group: 'Deals — from token to cash', id: 'invoice', button: 'Invoice the buyer',
    situation: 'The deal registered and the buyer\'s fee is due. Brokerage is ₹1,00,000 plus GST, the token comes off, the rest is owed.',
    event: 'invoice',
    values: { date: '2026-10-06', deal: 'D1', from: 'buyer', amt: 100000, gst: 'yes', gstRate: 18, gstAmt: 18000, total: 118000, tds: 0, adv: 50000, recv: 'later', dueDate: '2026-11-05' },
    point: '<b>This is the moment income exists</b> — because the fee is due, not because the deal changed status; mark registration separately with "Deal registered". Profit rises by the brokerage; the GST is the government\'s; a numbered invoice with a due date is created and the balance shows on Owed until it is paid. <span class="small faint">(Cr 4010 income, Cr 2200/2201 GST payable, Dr 2100 token, Dr 1100 receivable.)</span>',
  },
  {
    group: 'Deals — from token to cash', id: 'dealpay',
    situation: 'Prakash Builders pays the ₹23,600 market-study invoice, three weeks later.',
    event: 'dealpay',
    values: () => ({ date: '2026-10-27', party: 'P7', amt: 23600, via: '1000', alloc: allocate(23600, openInvoices('P7'), invoiceOutstanding).rows }),
    point: 'Cash in, receivable down, <b>profit unchanged</b> — it was counted when the invoice was raised. The payment is <b>allocated to the invoice</b>, which is now marked paid. Pay half and the invoice shows part-paid; pay more and the extra is held for the client. <span class="small faint">(Dr 1000, Cr 1100; allocation recorded on the invoice.)</span>',
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
    group: 'Deals — from token to cash', id: 'invoice-cash',
    situation: 'A smaller deal: the ₹40,000 brokerage is due and the client pays it in cash on the spot.',
    event: 'invoice',
    values: { date: '2026-10-06', deal: 'D1', from: 'buyer', amt: 40000, gst: 'no', tds: 0, adv: 0, recv: '1010', method: 'cash' },
    point: 'The invoice is raised and settled in the same breath, into the <b>cash box</b> — no receivable is ever created, and the invoice is marked paid from the first second. Choosing the bank instead would post the identical entry to 1000. <span class="small faint">(Cr 4010 income, Dr 1010 cash box.)</span>',
  },
  {
    group: 'Deals — from token to cash', id: 'dealfee-cancel',
    situation: 'The buyer walks away. Your agreement says a ₹25,000 withdrawal fee is due, and you are holding their ₹50,000 token.',
    event: 'dealfee',
    prepare: s => { s.deals[0].status = 'cancelled'; },
    values: { date: '2026-11-20', deal: 'D1', from: 'buyer', kind: 'cancel', what: '', amt: 25000, gst: 'no', tds: 0, adv: 25000, recv: 'later' },
    point: 'A <b>cancelled deal still earns</b>. The fee is income now, a numbered invoice is created for it, and ₹25,000 of the token converts to pay it — leaving ₹25,000 still held, to refund with "Settle a token". Before this existed the only way to book any of it was to forfeit the <i>whole</i> token, and a client who had paid no token could not be billed at all. <span class="small faint">(Cr 4030 Forfeited advances, Dr 2100 token.)</span>',
  },
  {
    group: 'Deals — from token to cash', id: 'dealfee-retainer',
    situation: 'Before showing anything, you take a ₹15,000 advisory retainer plus GST, paid by UPI.',
    event: 'dealfee',
    values: { date: '2026-09-09', deal: 'D1', from: 'buyer', kind: 'retainer', what: '', amt: 15000, gst: 'yes', gstRate: 18, gstAmt: 2700, total: 17700, tds: 0, adv: 0, recv: '1000', method: 'upi' },
    point: 'The same button, a different head: advisory work is <b>consultancy income</b> (4020), not brokerage, so the GST return and the income statement both read correctly. A retainer is a service like any other, so GST applies normally — unlike a withdrawal fee, which is usually compensation and often carries none.',
  },
  {
    group: 'Deals — from token to cash', id: 'dealcost-cash',
    situation: 'You pay ₹5,000 for the EC out of the cash box, on a deal that has already fallen through.',
    event: 'dealcost',
    prepare: s => { s.deals[0].status = 'cancelled'; },
    values: { date: '2026-11-22', deal: 'D1', what: 'EC extract', amt: 5000, gst: 'no', bear: 'self', how: '1010' },
    point: 'A dead deal still has bills to pay — you ordered the EC before the buyer walked, and it still has to be paid for. The cost lands on the deal so its true net is visible: a deal that lost you money should say so rather than disappear.',
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
    values: () => { const v = { date: '2026-10-05', loan: 'L1', via: '1000', charges: 0, extra: 0, prepay: 0, tds: 0 }; EV.emi.onchange('loan', v); return v; },
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
    ['start', 'Start here', 'The ideas the app is built on'],
    ['screens', 'The screens', 'Every page, and what each number means'],
    ['sop', 'How-to', 'What to do daily, weekly, monthly, yearly'],
    ['actions', 'Every action', 'Every button, with every field'],
    ['scenarios', 'Worked examples', 'Real situations, run through the real engine'],
    ['accounting', 'The accounting', 'Accounts, GST, TDS, statements — with the rule behind each'],
    ['charts', 'Pictures', 'The ideas that are easier drawn'],
    ['faq', 'FAQ & glossary', 'Questions, and what the words mean'],
  ];
  const q = query.trim().toLowerCase();
  const body = q ? searchAll(q) : (({ start: startHere, screens: screensTab, sop: sopTab, actions: actionsTab, scenarios: scenariosTab, accounting: accountingTab, charts: chartsTab, faq: faqTab })[tab] || startHere)();
  const here = tabs.find(t => t[0] === tab) || tabs[0];
  return `
    <h1>Guide</h1>
    <p class="lead">You record what happened; the books keep themselves. This is the manual — written twice over
    in the same words: plain enough for someone who has never kept books, complete enough for the chartered
    accountant who has to sign them.</p>

    <div class="guide-bar">
      <div class="seg" role="tablist">
        ${tabs.map(([k, l]) =>
    `<button type="button" role="tab" aria-selected="${tab === k && !q}" class="${tab === k && !q ? 'on' : ''}"
           onclick="finGuide.setTab('${k}')">${esc(l)}</button>`).join('')}
      </div>
      <input type="search" id="guideFind" value="${esc(query)}" placeholder="Search the guide — token, GST, reverse charge, petty cash…"
        aria-label="Search the guide" oninput="finGuide.find(this.value)" autocomplete="off">
    </div>

    ${q ? '' : `<p class="small muted" style="margin:-4px 0 14px"><b>${esc(here[1])}</b> — ${esc(here[2])}. Eight sections in all; the search box looks through every one of them at once.</p>`}
    ${body}`;
}

// Every tab is a list of items {title, html, text}; search filters across all of them.
function searchAll(q) {
  const all = [
    ['Start here', startItems()], ['The screens', screenItems()], ['How-to', sopItems()],
    ['Every action', actionItems()], ['Worked examples', scenarioItems()],
    ['The accounting', accountingItems()], ['FAQ & glossary', faqItems()],
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
      <h2>Green in, rust out</h2>
      <p>Every action is marked by direction before you read a word of it: <span class="dirtag dir-in">Money in</span> <span class="dirtag dir-out">Money out</span> <span class="dirtag dir-move">Move money</span> <span class="dirtag dir-fix">Correction</span> <span class="dirtag dir-setup">Set up</span>. The same colour sits in the tag beside the form's title, on the save bar and on the confirmation, so a rust-tagged form is always money leaving and a green one always money arriving. Grey moves your own money between pockets — never a cost. Amber corrects something already recorded.</p>`),
    item('Where to look for what', `
      <h2>Where to look for what</h2>
      ${table(`<th style="width:26%">If you want</th><th>Go to</th>`, [
      ['To learn a screen', '<b>The screens</b> — one card per page: the question it answers, what every number on it means, and what you are expected to do there.'],
      ['To know what to do today', '<b>How-to</b> — the daily, weekly, monthly and yearly routine, and two tables that answer "which button".'],
      ['To look up one button', '<b>Every action</b> — every button on Record with every field it can show, read from the app itself so it is never out of date.'],
      ['To see a real situation worked through', '<b>Worked examples</b> — each one run through the real engine on sample books, showing the actual journal.'],
      ['To check the accounting', '<b>The accounting</b> — the chart of accounts, when a cost is recognised, GST, TDS, assets, loans, the statements, and what the app refuses to do, each with the rule behind it.'],
      ['To understand an idea', '<b>Pictures</b> for the ones easier drawn, <b>FAQ & glossary</b> for the rest.'],
    ].map(([a, b]) => `<tr><td><b>${esc(a)}</b></td><td class="small">${b}</td></tr>`).join(''))}
      ${note('Searching looks through all eight sections at once, so if you do not know where something lives, type the word.')}`),
    item('The four states of a cost', `
      <h2>Four states, one cost, counted once</h2>
      <p>The single thing worth understanding before anything else. A cost you pay every month passes through four states, and the app keeps them apart so nothing is ever counted twice.</p>
      <div class="grid four-up">
        <div class="card"><h3>1. A guess</h3><p class="small muted" style="margin:0">The rent will be about 20,000. It shows on <b>This month</b> under "still a guess" and in the Budget. <b>Nothing is posted.</b></p></div>
        <div class="card"><h3>2. An event</h3><p class="small muted" style="margin:0">The month is over and you used the office. Record it: the cost belongs to that month, and the landlord goes on Owed. No money has moved.</p></div>
        <div class="card"><h3>3. A document</h3><p class="small muted" style="margin:0">The bill arrives on the 4th, payable on the 15th. Record <b>Bill arrived</b>: the number and due date go on, and any difference goes back into the month you used it.</p></div>
        <div class="card"><h3>4. Settled</h3><p class="small muted" style="margin:0">You pay on the 15th. Cash leaves and the bill closes. <b>Profit does not move</b> — it was counted in step 2.</p></div>
      </div>
      ${note('Worth reading twice: <b>profit moved in step 2, cash moved in step 4.</b> That gap is not an error, it is the whole reason the books are worth keeping. This month shows both at once.')}`),
    item('A deal is not a pipeline', `
      <h2>A deal's status never decides what you can record</h2>
      <p>A deal moves through <b>open → registered</b>, and sometimes to <b>cancelled</b>. That is a label on its timeline — it says where the deal got to. It does <b>not</b> say what may be recorded against it, because money does not wait for a milestone.</p>
      <p class="small muted">You take a token before anything is agreed. You pay for the EC the week after. The agreement says half the brokerage falls due on signing, not on registration, so you invoice while the deal is still open. The client pays in notes across the desk. Then the buyer walks away, and a withdrawal fee is due on a deal that will never register. Every one of those is normal, and every one of them is recordable at any point.</p>
      <div class="grid g3">
        <div class="card"><h3>Money in, any time</h3><p class="small muted" style="margin:0">Before an invoice exists it is a <b>token</b>, held for the client. Once one exists it is a <b>payment</b>, matched to it. Either way it lands in the bank <b>or the cash box</b>, and the form says how it moved — UPI, cheque, cash at the counter — so the statement match works later.</p></div>
        <div class="card"><h3>Billed when it falls due</h3><p class="small muted" style="margin:0">An invoice is raised when <b>your agreement</b> says the fee is due, which may be before registration, on it, or in stages after. Raising one does not change the deal's status, and the deal's status does not gate it.</p></div>
        <div class="card"><h3>A dead deal still earns</h3><p class="small muted" style="margin:0">A cancelled deal keeps every action. Collect what is still owed, pay the bill you had already run up, refund the token — and bill the <b>cancellation fee</b>, whether or not a token was ever paid.</p></div>
      </div>
      ${table(`<th style="width:34%">What happened</th><th>Which button</th>`, [
      ['Money arrived and you have not invoiced them yet', '<b>Token / advance received</b> — held for the client, not income. Bank or cash box.'],
      ['Money arrived against an invoice', '<b>Client pays what they owe</b> — matched to the invoice. Bank or cash box.'],
      ['A side\'s brokerage has fallen due', '<b>Invoice the buyer / seller</b> — at any status. Income now, GST payable now.'],
      ['You agreed a flat number, not a percentage', '<b>Charge a flat fee on a deal</b> — retainer, advisory, or a flat brokerage.'],
      ['The deal is off and a fee is due anyway', '<b>Charge a flat fee on a deal</b> → cancellation. Works with no token held.'],
      ['You are holding a token and the deal ended', '<b>Settle a token</b> — apply it to an invoice, refund it, keep it, or move it to another deal.'],
      ['You spent something on this deal', '<b>Cost on a deal</b> — bank, cash box, credit card, or a bill to pay later. Company bears it, or it is recoverable from a client.'],
    ].map(([a, b]) => `<tr><td><b>${esc(a)}</b></td><td class="small">${b}</td></tr>`).join(''))}
      ${note('Where a fee lands matters at year-end: a <b>cancellation fee</b> is Forfeited advances (4030), a <b>retainer</b> is Consultancy income (4020), a <b>flat brokerage</b> is the same buyer- or seller-side head the percentage would have used. Letting a client off part of any of them comes back off that same head — income is what came in.')}`),
    item('What each tab is for', `
      <h2>Every page at a glance</h2>
      <p class="small muted">One line each. The full card for any of them is in <b>The screens</b>.</p>
      ${table(`<th>Tab</th><th>What you do there</th>`, [
      ['Overview', 'Your position at a glance — this month\'s profit, what cash is genuinely free to spend, who owes whom, what is due soon.'],
      ['Record', '<b>The only place anything is entered.</b> Pick what happened; the bookkeeping is worked out for you and shown before you save.'],
      ['This month', 'One month in five states — paid, invoiced, due, late, still a guess — for money out and money in, and the answer to "can I spend?".'],
      ['Transactions', 'Everything recorded, newest first. Tap a row to see both sides of the entry, its attachments, and to reverse it.'],
      ['Owed', 'The weekly worklist: who to chase and who to pay — bill by bill, invoice by invoice, with due dates.'],
      ['Deals & invoices', 'The pipeline and each deal\'s money — tokens, brokerage, costs, net — and every invoice raised.'],
      ['Recurring', 'Rent, subscriptions, retainers, insurance — every monthly commitment: what you expected, what was billed, what is paid, why they differ.'],
      ['Budget', 'Next month set against last month. Expectations come from Recurring, Loans, Assets and Deals, plus anything you type. Nothing here is an entry.'],
      ['Petty cash', 'The cash box: what went in, what went out, what it paid for, what should be in the drawer.'],
      ['Loans', 'Each loan with its principal and interest kept apart, and the next EMI ready to record.'],
      ['Assets', 'What you own and how much value is left in it.'],
      ['Invoices', 'Tax invoices and credit notes, numbered automatically. Download or share the PDF.'],
      ['GST', 'The month\'s liability, credit, set-off and cash due — GSTR-3B the way the rules do it — plus the ITC and GSTR-1 registers.'],
      ['Bank & card statements', 'Import the statement. What you already recorded is matched; what you missed is suggested, one tap to create; duplicates are flagged.'],
      ['Reports / Analytics', 'Profit and loss, trends, where the money went — with filters.'],
      ['Books', 'The accountant\'s view: the check, trial balance, profit and loss, balance sheet, ledgers, registers and the journal. The CSVs here are what you send your CA.'],
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

// ═══════ 2. THE SCREENS — WHAT EVERY PAGE IS FOR ═══════
//
// One card per page in the app: the question it answers, what is on it, what to do there, and
// — folded away for anyone who wants it — which accounts and helpers the figures come from.
// Written so a first-time user can act on it and an accountant can audit it.

function screen(o) {
  return item(o.name, `
    <div class="card guide-screen">
      <h3 style="margin:0 0 2px">${esc(o.name)} <span class="small faint">${esc(o.group)}</span></h3>
      <p class="small" style="margin:0 0 10px"><b>${o.asks}</b></p>
      <p class="small muted" style="margin:0 0 10px">${o.body}</p>
      ${o.on ? `<div class="tbl-wrap"><table><thead><tr><th>On the page</th><th>What it means</th></tr></thead><tbody>
        ${o.on.map(([a, b]) => `<tr><td style="width:34%"><b>${esc(a)}</b></td><td class="small">${b}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
      ${o.doThis ? `<p class="small" style="margin:10px 0 0"><b>What to do here:</b> ${o.doThis}</p>` : ''}
      ${o.behind ? `<details class="journal" style="margin-top:10px"><summary>Where the figures come from</summary>
        <p class="small muted" style="margin:8px 0 0">${o.behind}</p></details>` : ''}
      ${o.watch ? note(o.watch, 'warn') : ''}
    </div>`);
}

function screenItems() {
  return [
    item('How to read this tab', `
      <h2>Every screen, one card each</h2>
      <p class="lead">What the page answers, what each number on it means, and what you are expected to do there.
      The fold at the bottom of each card names the accounts and the workings behind the figures — ignore it,
      or hand it to your accountant.</p>
      ${note('<b>Only one screen writes anything: Record.</b> Every other page reads the same entries back in a different shape. If a figure looks wrong, the fix is always an entry, never the page.')}`),

    item('Daily group', '<h2>Daily</h2>'),
    screen({
      name: 'Overview', group: 'Daily',
      asks: 'Where do I stand right now?',
      body: 'The first screen of the morning. This month earned and spent, what cash is genuinely free, who owes whom, what is coming, and what still has to be closed off.',
      on: [
        ['Income · Expenses · Profit', 'This calendar month, on the accrual basis — earned and incurred, whoever has actually paid.'],
        ['Free to use', 'Bank and box, less what you owe vendors, less client tokens you are holding. The honest answer to "is that mine".'],
        ['Where the money is', 'Bank, petty cash, credit card owed, loans outstanding.'],
        ['Who owes whom', 'Clients owe you, you owe vendors, tokens held, GST due after set-off.'],
        ['Services', 'What the recurring commitments cost a month, what is sitting prepaid with vendors, how many are running.'],
        ['Compliance dates', 'The next statutory dates that apply to you, nearest first.'],
        ['Cash needed soon', 'Every bill on its own due date, EMIs, GST and TDS — against the cash you hold.'],
        ['Month-end', 'Posts depreciation and releases prepaid slices. Safe to run twice.'],
      ],
      doThis: 'Read it. Act on <b>Cash needed soon</b> if it is larger than the cash beside it, and run <b>Month-end</b> once a month is reconciled.',
      behind: 'Profit from pl(month). Free to use from cashPosition(): 1000 + 1010 − 2000 − 2100. GST due nets 2200–2202 and 2205 against 1400–1402. Cash needed soon is upcomingCash(), which reads each open bill on its dueDate, the loan schedules, and the GST and TDS balances.',
    }),
    screen({
      name: 'Record', group: 'Daily',
      asks: 'Something happened — how do I put it in?',
      body: 'The only screen that writes to the books. Seven categories first — Money in, Money out, Bills, Invoices, Service costs, Deals, Fix something — then the action inside the one you picked. Or type a word and go straight to it. The colour on each button tells you which way money moves. Pick what happened in plain words; the double entry is worked out and shown before you save.',
      on: [
        ['Categories', 'The first choice. Tap one to see its actions; "All categories" brings the tiles back.'],
        ['Search', 'Type a word — rent, EMI, token — and the matching actions appear. Enter opens the first.'],
        ['Recent', 'What you have recorded most in the last month. Appears once there is history.'],
        ['The amount', 'The first box on every form, big enough to read across a desk.'],
        ['More details', 'The fold under the main fields: category, bill number, GST, note. Open it when the bill has those.'],
        ['Preview (phone)', 'The button beside Save opens what saving will do, with its own Save.'],
        ['The form', 'Only the fields that apply to your answers. A field appears when it becomes relevant and disappears when it stops.'],
        ['Posting strip', 'From which account, to which account, with codes, and what it does to profit — before you save.'],
        ['The journal preview', 'Both sides of the entry in full, for anyone who wants to check it.'],
        ['Red and amber notes', 'Red blocks saving. Amber saves but tells you what an accountant would ask about.'],
        ['Attach', 'A photo or PDF of the bill, stored with the entry, not in a folder somewhere else.'],
      ],
      doThis: 'Record on the same day. Attach the bill. Read the posting strip — if it says something you did not expect, the answer to one of the questions is wrong.',
      behind: 'Every button is one entry in EV[key] in finance-events.js. build() returns the description, the journal lines, the documents it creates and the plain-English effects. finance-sync.save() writes the entry, its documents, its allocations and any master record in a single Firestore transaction, so a half-saved deal cannot exist.',
    }),
    screen({
      name: 'This month', group: 'Daily',
      asks: 'Can I spend?',
      body: 'One month, with every commitment shown at whatever stage it has reached. Money out and money in are shown apart, in five boxes each, then combined. Nothing here is an entry.',
      on: [
        ['Yours to use today', 'Bank and box, less client tokens and what the card owes. One definition of cash, used everywhere.'],
        ['Still to pay', 'Due this month, plus arrears, plus what is still only expected.'],
        ['Coming in on invoices', 'Documents only. Deals you hope to close are counted separately and never in this figure.'],
        ['Paid', 'What actually moved through the bank and the box. Card purchases are named separately — they have not taken cash yet.'],
        ['Invoiced', 'Billed this month and still unsettled.'],
        ['Due this month / Already late', 'By due date. Late means it fell due before the 1st.'],
        ['Still a guess', 'A commitment with nothing recorded and no document. It never appears twice: the moment the month is recorded, the guess disappears.'],
        ['If nothing changes', 'Three months forward on what is already known, splitting what is certain from what is guessed, and naming the month you run short if you do.'],
      ],
      doThis: 'Before committing to any spend, read the top card. Commit against the lower figure, not the hopeful one.',
      behind: 'monthPicture(month) in finance-core.js. Estimates come from live commitments with no charges entry for the month, unpaid loan instalments, undeposited depreciation and typed budget lines — a typed figure replaces the app\'s own estimate for that account, exactly as the Budget page does. outlook(3) walks the same figures forward.',
      watch: '<b>Invoiced and Due overlap on purpose.</b> A bill dated this month and payable this month is in both, because they answer different questions. Only the last box in each row is a total.',
    }),
    screen({
      name: 'Transactions', group: 'Daily',
      asks: 'What has been recorded?',
      body: 'Every entry, newest first, with filters. Tap any row for both sides of the entry, its attachments, the documents it created, and the button to reverse it.',
      on: [
        ['Every entry / Money moved / Not paid yet', 'The switch that separates the books from the bank. A bill you have not paid is a real entry but no money moved.'],
        ['In and Out columns', 'What actually reached or left the bank, the box or the card on that entry.'],
        ['Method', 'UPI, debit card, NetBanking, cheque or cash — so a statement line can be matched by it.'],
        ['Reverse', 'Posts the mirror-image entry. Nothing is edited or deleted, ever.'],
      ],
      doThis: 'Use it to check a specific entry or to find something you half-remember. For chasing and paying, use Owed instead.',
      behind: 'movesMoney(t) is true when an entry touches 1000, 1010 or 2300. Reversal is finance-sync.reverse(), which reads the entry\'s documents from the server, refuses while a payment still stands against them, and voids rather than deletes.',
    }),
    screen({
      name: 'Owed', group: 'Daily',
      asks: 'Who do I chase, and who do I pay?',
      body: 'The weekly worklist, both directions, document by document — not a single lump per party.',
      on: [
        ['Clients owe you', 'Every open invoice with its due date and how late it is.'],
        ['Ageing tiles', '0–30, 31–60, 61–90, over 90 days. Over 90 on the payables side is where GST credit starts to be at risk.'],
        ['You owe vendors', 'Every open bill, with Pay, Entry and, where the vendor bill has not arrived, Bill arrived.'],
        ['Advances with vendors', 'Money already with a vendor. Used first the next time you pay them.'],
        ['Tokens held', 'Client money you are holding. Not yours until the deal registers.'],
      ],
      doThis: 'Chase the oldest receivable first. Pay what is due; the payment is matched to specific bills and you can change the split.',
      behind: 'agedReceivables() and agedPayables() count from the due date, per document. Anything owed with no document behind it — an opening balance, an entry from before documents were tracked — is shown as its own line rather than hidden.',
    }),

    item('Business group', '<h2>Business</h2>'),
    screen({
      name: 'Deals & invoices', group: 'Business',
      asks: 'What is each deal worth, and what has been invoiced?',
      body: 'Two tabs. Deals is the pipeline with each deal\'s money in one place: tokens held, brokerage earned, costs borne, what is left. Invoices is every tax invoice and credit note raised, numbered in sequence.',
      on: [
        ['Expected brokerage', 'Seller side and buyer side, and the month you expect it to close. Feeds the projection, never the books.'],
        ['Token held', 'Money taken before an invoice exists; adjusted against the invoice, refunded, or kept.'],
        ['Deal costs', 'EC, patta, legal, travel — with who bears them.'],
        ['Net on the deal', 'Brokerage earned less the costs booked against it.'],
        ['Invoice status', 'Open, part-paid, settled, or reversed by a credit note, with the outstanding amount, not the face value.'],
      ],
      doThis: 'Open a deal when you take it on. Record the token when it arrives. Mark it registered on the day the deed is signed. Invoice each side when its fee is due — usually that same day. Record each payment as it comes; the deal shows Settled when nothing is owed and nothing is held.',
      behind: 'Deals carry expSeller, expBuyer and expMonth. The invoice document holds base, CGST, SGST, IGST, total, paid, dueDate and its allocations. dealFigures() and dealFunnel() read them back.',
    }),
    screen({
      name: 'Recurring', group: 'Business',
      asks: 'What do I pay every month, and is this month recorded?',
      body: 'Every monthly commitment — rent, subscriptions, retainers, salaries, insurance, utilities — as a grid of months. Each cell says what happened: recorded, billed and unpaid, skipped, paused, or missing.',
      on: [
        ['Expected a month', 'What the plan says today. Plan changes are kept with the month they start, so old months keep their old expectation.'],
        ['Record this month', 'Opens the form with the month and the expected amount filled in. Salary lines open the salary form instead, because they carry TDS and PF, not GST.'],
        ['Billed — not paid yet', 'The month is a cost and the vendor is on Owed. Pay and Bill arrived sit right there.'],
        ['Variance and reason', 'What was actually billed against what you expected, and why they differ.'],
        ['Record all due', 'Every month that is due but not recorded, one after another.'],
      ],
      doThis: 'At month end, record each commitment. If the vendor has not billed you yet, choose <b>Not paid yet</b> — the cost belongs to the month you used the thing.',
      behind: 'A commitment is a subscriptions record with a history array; expectedFor(sub, month) reads the plan in force for that month. Each recorded month is stored under charges[month] with the bill it produced. recurringAcc(sub) decides which expense account the month posts to — rent to 5000, software to 5080, and so on.',
    }),
    screen({
      name: 'Budget', group: 'Business',
      asks: 'What do I expect this month to look like?',
      body: 'One month, account by account: what the app already expects, what you type over the top, and what actually happened. Nothing on this page is an entry.',
      on: [
        ['Expected', 'Empty box means the app\'s own figure, shown as the placeholder. Type one and yours replaces it for that account.'],
        ['Actual', 'What the books have for that account so far this month.'],
        ['Difference', 'Coloured by whether it is good news, not by its sign — a cost under budget is green, income under budget is red.'],
        ['Where from', 'Which commitment, loan, asset or deal produced the expectation.'],
      ],
      doThis: 'Set the figures you know the app cannot: a one-off marketing push, a deal you are confident about. Leave the rest empty.',
      behind: 'projection(month) reads recurring commitments, loan interest, depreciation and deals due to close, then lets a typed figure override the derived one for that account. Typed figures live on the settings document under budgets.month.account — no new collection, no rules change.',
    }),

    item('Money group', '<h2>Money</h2>'),
    screen({
      name: 'Bank & card statements', group: 'Money',
      asks: 'Do my books agree with the bank?',
      body: 'Import the statement CSV. Lines that match what you recorded are ticked off. Lines that do not are the ones you forgot — each with a suggestion and one button to create it.',
      on: [
        ['Column mapping', 'Asked once per account, then remembered.'],
        ['Matched', 'The statement line and your entry agree on amount and date.'],
        ['Not in your books', 'You missed it. The suggestion names the most likely entry — an open bill, a recurring cost, an EMI, a client paying an invoice — and opens that form filled in.'],
        ['Possible duplicate', 'This line looks like an entry another line has already claimed.'],
        ['In your books, not on the statement', 'Either it never went through, or it lands next month.'],
      ],
      doThis: 'Once a month, before month-end. Clear every unmatched line. Twenty minutes here is what makes the books trustworthy.',
      behind: 'suggestEntry() works down a list: a rule learned from a past match, an ATM withdrawal as a cash-box top-up, a card payment as a transfer, an open bill, a recurring month, an EMI, an open invoice, a named party, then a plain expense. Saving from a statement line learns the first three words of the narration for next time.',
    }),
    screen({
      name: 'Petty cash', group: 'Money',
      asks: 'What is in the drawer, and what did it pay for?',
      body: 'Account 1010 seen from the owner\'s side: top-ups in, vouchers out, what it paid for, and what should physically be there now.',
      on: [
        ['In the box now', 'What the books say the drawer holds. Count the notes and compare.'],
        ['Added from the bank', 'Top-ups, with the date of the last one.'],
        ['Spent from the box', 'Vouchers, by category.'],
        ['Sent back to the bank', 'Sweeps.'],
      ],
      doThis: 'Empty the box weekly into <b>Petty cash vouchers</b> — up to three at a time — then check the balance against the notes.',
      behind: 'pettyActivity() builds the running balance. The box is an account like the bank, so an entry is never refused for want of a balance; pettyRoom(date) is the lowest the box reaches from that date onwards, and a spend that takes it below zero — on its own day or any later one — is flagged as a warning so a missing top-up gets noticed.',
      watch: 'The <b>With / Without / Only</b> switch changes what Transactions, Reports, Analytics and their CSVs show — the file name and the first row of every export say which. It never changes the trial balance, the balance sheet or the Books check, which always show everything.',
    }),
    screen({
      name: 'Loans', group: 'Money',
      asks: 'What do I still owe, and what is this EMI made of?',
      body: 'Each loan with its schedule, how much principal is left, and the next instalment ready to record.',
      on: [
        ['Outstanding', 'Principal still owed. It is not a cost — only the interest is.'],
        ['Next EMI', 'Opens the form with principal and interest already split from the schedule.'],
        ['Lender charges and penalties', 'Charges are a cost (5140); a late-payment penalty is a cost that the tax computation adds back (5165).'],
        ['Prepayment', 'Pays down principal and rebuilds the rest of the schedule at the same rate and end date.'],
      ],
      doThis: 'Record the EMI from here, not as an expense. Recording the whole instalment as a cost overstates your expenses by the principal.',
      behind: 'One entry: Dr 2400 principal, Dr 5150 interest, Dr 5140 charges, Cr bank, with 194A TDS if it applies. regenerateSchedule() rebuilds the remaining rows after a prepayment rather than leaving a stale schedule.',
    }),
    screen({
      name: 'Assets', group: 'Money',
      asks: 'What do I own, and how much value is left in it?',
      body: 'Anything that lasts more than a year, with its cost spread over its useful life.',
      on: [
        ['Written-down value', 'Cost less depreciation charged so far.'],
        ['Monthly depreciation', 'The slice that becomes a cost each month, posted at month-end.'],
        ['Sell or scrap', 'Removes it and books the profit or loss on disposal.'],
      ],
      doThis: 'Buy an asset through <b>Buy an asset</b>, not as an expense. Below the threshold in Settings, record it as an expense instead.',
      behind: 'Dr 1300 at cost; each month Dr 5200 / Cr 1350. The final month releases whatever is left so the asset closes at exactly its cost. The balance sheet shows 1300 with 1350 beneath it as a deduction.',
    }),

    item('Tax and reports group', '<h2>Tax & reports</h2>'),
    screen({
      name: 'GST', group: 'Tax & reports',
      asks: 'What do I owe the government this month?',
      body: 'The month worked out the way the rules do it: tax collected, credit available, set-off in the order Rule 88A requires, and the cash actually payable. Plus the registers behind it.',
      on: [
        ['Output tax', 'CGST, SGST and IGST you charged.'],
        ['Input credit availed', 'What you may set off. Credit waiting for an invoice is not in here.'],
        ['Reverse charge', 'Tax you owe as the buyer. Always paid in cash, then claimed back as credit.'],
        ['Cash payable', 'After set-off. This is the number you pay.'],
        ['ITC register', 'Every purchase with credit, its invoice and the date the claim expires.'],
        ['GSTR-1 rows', 'Your outward supplies split into B2B, B2CL, B2CS, CDNR and CDNUR.'],
        ['Rule 37', 'Bills unpaid for 180 days, where credit has to be given back.'],
      ],
      doThis: 'Check it before the 20th, then use <b>Pay to government</b>, which opens with the set-off already worked out.',
      behind: 'gstComputation(month) with gstSetOff() implementing Rule 88A — IGST credit first, and against IGST liability before CGST or SGST. Heads are 2200/2201/2202 payable, 1400/1401/1402 credit, 2205 reverse charge, 1405 credit not yet claimable.',
    }),
    screen({
      name: 'Reports', group: 'Tax & reports',
      asks: 'How did the month or the year actually go?',
      body: 'Profit and loss by month or financial year, how this month compares with the last, what it costs to keep the doors open, why profit and cash differ, and the cash book.',
      on: [
        ['How this month compares', 'Income, costs and profit against last month and against what was expected, led by the three accounts that moved most.'],
        ['Keeping the lights on', 'Fixed cost a month, the margin this business actually trades at, and the income needed before the month makes anything.'],
        ['Profit is not cash', 'Starts at profit and walks through every real movement to the cash that moved. Anything unexplained is shown, not hidden.'],
        ['Income and expenses by category', 'With a share of the total, and a CSV.'],
        ['Money in and out', 'The cash book: opening, every movement, closing — with a switch for bank only, bank and box, or including the card.'],
        ['Cash flow', 'The same money grouped by what it was for.'],
      ],
      doThis: 'Read it monthly. Send the CSVs to your CA quarterly.',
      behind: 'plStatement(), monthCompare(), breakEven() on fixedMonthly(), cashProfitBridge() and cashBook(). The break-even margin comes from the last three months actually traded, not an assumption.',
    }),
    screen({
      name: 'Analytics', group: 'Tax & reports',
      asks: 'What do the patterns say?',
      body: 'The same entries with filters and charts: trends by month, quarter or year, where income came from, where money went, who the biggest clients and vendors are, how long clients take to pay, and deal by deal.',
      on: [
        ['Filters', 'Date range, deal, party, channel, category, type, amount, free text.'],
        ['Deltas', 'Compared with the period of the same length just before.'],
        ['Days to collect', 'Average days from invoice to payment, from the allocations.'],
      ],
      doThis: 'Use it to answer a specific question, not as a daily screen.',
      behind: 'finance-analytics.js. Every chart is drawn from filterTxns() over the same entries — there is no separate analytics store to fall out of step.',
    }),
    screen({
      name: 'Books', group: 'Tax & reports',
      asks: 'Would an accountant sign this?',
      body: 'The five statements, over one date range you choose, plus the check that has to pass before anything is filed. This is the tab to hand over.',
      on: [
        ['The check', 'Twelve tests that can actually fail — see The accounting tab for each one.'],
        ['Trial balance', 'Opening, debits, credits and closing for every account. P&L accounts open at nil each financial year.'],
        ['Profit and loss', 'Revenue, direct costs, gross profit, operating costs, EBITDA, depreciation, finance cost, exceptional items, profit before and after tax.'],
        ['Balance sheet', 'Grouped as a schedule reads, with fixed assets net of depreciation and profit split between earlier years and this one.'],
        ['Ledger', 'Any account, with the balance brought forward and a closing total.'],
        ['Registers', 'Every purchase and every sale in the period, with numbers, due dates and status.'],
        ['General journal', 'Every entry, both sides.'],
      ],
      doThis: 'Run the check before month-end and before filing. Send your CA the journal and the ledger CSVs.',
      behind: 'booksHealth(), trialBalanceDetail(from, upto), plStatement(), balanceSheetGrouped(). The statements always read both records together, whichever one the Record switch is showing.',
    }),

    item('Setup group', '<h2>Set up</h2>'),
    screen({
      name: 'Profile', group: 'Set up',
      asks: 'Who is the company, on paper?',
      body: 'Legal name, address, GSTIN, PAN, bank details and logo — everything that has to appear on a tax invoice.',
      doThis: 'Complete it before raising your first invoice. An invoice missing a mandatory field is not a valid tax invoice.',
      behind: 'Read by finance-invoice.js when an invoice is built; missing mandatory fields are reported rather than silently omitted.',
    }),
    screen({
      name: 'Settings', group: 'Set up',
      asks: 'How should the engine behave?',
      body: 'The date the books start, the financial year, your state, the capitalisation threshold, whether TDS is on, TDS thresholds, the income-tax rate for the estimate, and invoice numbering.',
      on: [
        ['Books start date', 'Nothing can be dated before it. Set it once.'],
        ['Capitalisation threshold', 'Below this, a purchase is an expense rather than an asset.'],
        ['TDS', 'Off by default. Switching it on adds the TDS questions to the forms that need them.'],
        ['Income-tax rate', 'Used for the estimate on Reports only. 26% is the rate without any election.'],
      ],
      doThis: 'Set the books start date and your state before recording anything. Ask your CA about the tax rate.',
    }),
  ];
}
const screensTab = () => screenItems().map(i => i.html).join('');

// ═══════ 3. HOW-TO (SOP) ═══════

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
      'A payment, a bill received, a token taken — open <b>Record</b>, type a word or tap it under Your usual, and enter the amount first. Attach a photo of the bill to the entry itself, so the evidence and the number never get separated. The form checks every field; on a phone the Preview button beside Save shows the double entry before you save.', 'Under a minute per entry.')}`),
    item('Every week', `<h2>Every week</h2>
      ${step(2, 'Empty the petty cash box', 'Record → <b>Petty cash vouchers</b>. Up to three at once. Then check the box balance on Overview matches the notes in the drawer.')}
      ${step(3, 'Record each recurring cost for the month', 'Recurring tab → <b>Record this month</b> (or <b>Record all due</b> at month-end). Paid, or not paid yet — put it on Owed. Enter the real amount; if it differs from what you expected, say why. If the price is changing, set the new expected amount there and then. Salaries open the salary form, because they carry TDS and PF rather than GST.')}
      ${step(4, 'Work the Owed list, both ways', 'Chase the oldest receivable first — overdue invoices are flagged with their due date. Then pay what is due; the payment is matched to the bills it settles, and you can change the split.')}`),
    item('Every month', `<h2>Every month</h2>
      ${step(5, 'Import the bank and card statements', 'Bank tab → pick the account → upload the CSV. The first import asks you to confirm the columns; after that it is one tap.')}
      ${step(6, 'Clear everything unmatched', 'On the statement but not in your books means you forgot to record it. Each line says what it most likely was — an open bill, a recurring cost, an EMI, a client paying an invoice — and the first button opens that form filled in. Save it and the line is matched. A line that looks like an entry another line already claimed is flagged as a possible duplicate. In your books but not on the statement means it never went through (reverse it) or lands next month (leave it).')}
      ${step(7, 'Run month-end', 'Only once the month shows <b>Reconciled ✓</b>. This posts depreciation and releases the monthly slice of anything paid upfront. Running it twice is harmless — the second run posts nothing.')}
      ${step(8, 'GST by the 20th, TDS by the 7th', 'GST tab → check the month → <b>Pay GST</b> opens the payment with the set-off already worked out. Reverse-charge tax is paid in cash. Then Books → <b>Download journal CSV</b> for your CA.', 'Check current due dates with your CA — they move.')}`),
    item('Once a year', `<h2>Once a year</h2>${step(9, 'Close the financial year',
      'Reports → switch to <b>By financial year</b> and download the P&L. Books → export the year\'s journal and the JSON backup. Hand both to your CA with the bank statements. Ask them about the items listed under "What to confirm with your CA" in the FAQ.')}
      ${note('<b>If you only do one thing:</b> reconcile monthly. Everything else can be caught up later from bills and statements. Books that have never been checked against a bank statement cannot be caught up — you have no way of knowing what is missing.')}`),
    item('Which button', `<h2>Which button? — expenses, bills and your own money</h2>
      ${table(`<th>What happened</th><th>Use</th>`, [
      ['Paid on the spot — rent, fuel, a print job', '<b>Expense — paid now</b>'],
      ['Got a bill, will pay later', '<b>Bill received — pay later</b>, then <b>Pay a vendor bill</b> when you do'],
      ['Part of a bill will never be paid — discount, TDS, credit note, written off', '<b>Pay a vendor bill</b> with "Amount not being paid"; or afterwards, <b>Close what is left on a bill</b>. Say which it is — each posts differently, and the GST credit follows'],
      ['A subscription was charged or invoiced this month', '<b>Record this month\'s recurring cost</b>'],
      ['Spent on one particular deal (EC, patta, lawyer)', '<b>Cost on a deal</b> — choose who bears it'],
      ['Bought something that lasts over a year', '<b>Buy an asset</b>'],
      ['Small cash from the box', '<b>Petty cash spends</b>'],
      ['Paid from your own pocket for the company', '<b>Paid personally by the director</b>'],
      ['Paid staff', '<b>Salary / bonus</b> — under Money out'],
      ['Paid GST, TDS or PF', '<b>Pay GST / TDS / PF to government</b> — under Money out; not a cost'],
      ['Paid the card bill / moved cash to the box', '<b>Transfer</b> — under Money out; not a cost'],
      ['Paid an EMI', '<b>Pay an EMI</b> — only the interest is a cost'],
      ['Vendor refunded you or sent a credit note', '<b>Vendor refund / credit note received</b>'],
    ].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join(''))}
      <h2>Which button? — deals and clients</h2>
      ${table(`<th>What happened</th><th>Use</th>`, [
      ['A client gave a token or advance before you invoiced them', '<b>Token / advance received</b> — not income. Bank or cash box'],
      ['The sale deed registered', '<b>Deal registered</b> — the date; no money, no income yet'],
      ['A side\'s brokerage is due', '<b>Invoice the buyer / seller</b> — this is the income; the invoice is raised. At any status, including before registration if the agreement says so'],
      ['A client paid what they owe', '<b>Client payment received</b> — matched to their invoices. Bank or cash box'],
      ['The client paid the brokerage in cash, there and then', '<b>Invoice the buyer / seller</b> → Payment: <i>received now, into the cash box</i>. One entry; no receivable is ever created'],
      ['The client paid by card machine or a payment gateway', 'Received into the <b>bank</b>, with "How it moved" set to <i>Card machine / payment gateway</i>. If the gateway kept a fee, record the payment with <b>Client payment received</b> and put the fee in "Discount you gave them" → <i>bank charges</i> — the invoice still closes in full'],
      ['You agreed a flat fee rather than a percentage', '<b>Charge a flat fee on a deal</b> → flat brokerage, or a retainer for advisory work'],
      ['The deal fell through and a cancellation fee is due', '<b>Charge a flat fee on a deal</b> → cancellation. Works on a cancelled deal, and with no token held'],
      ['The deal fell through and you are holding their token', '<b>Settle a token</b> — apply it to an invoice, refund it, keep it, or move it to another deal'],
      ['A cancelled deal still owes you money, or still has a bill to pay', 'Every deal action stays available on a cancelled deal — <b>Client payment received</b>, <b>Cost on a deal</b>, and the rest'],
      ['Consultancy, a referral fee, interest', '<b>Other income</b> — invoice optional'],
      ['Capital or a director\'s loan came in', '<b>Capital / director loan received</b> — under Money in; never income'],
      ['A bank or NBFC loan came in', '<b>New bank / NBFC loan</b> — creates the EMI schedule'],
    ].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join(''))}`),
  ];
}
const sopTab = () => sopItems().map(i => i.html).join('');

// ═══════ 4. EVERY ACTION — GENERATED FROM THE ENGINE ═══════
//
// For each button on the Record screen: what it is for, its direction, and every field with its
// hint, read from the live definitions inside the sample books. Fields that only appear for
// certain answers are listed under the answer that reveals them, so nothing is hidden.

function actionItems() {
  const out = [];
  // A button listed in two groups (dealcost) is documented once, under the first.
  const seen = new Set();
  for (const [group, items] of CHOOSER) {
    for (const it of items) {
      const ev = EV[it.key];
      if (!ev) continue;
      const sig = it.key + '|' + JSON.stringify(it.preset || {});
      if (seen.has(sig)) continue;
      seen.add(sig);
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

// ═══════ 5. WORKED EXAMPLES ═══════

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

// ═══════ 6. PICTURES ═══════

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
      ${box(400, 80, 206, 50, '#FFFFFF', '#E7E1D7', 'Adjusted on the invoice', 'Becomes income when invoiced')}
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

// ═══════ 7. THE ACCOUNTING — THE REFERENCE A CA READS ═══════
//
// Everything the engine decides, stated once, with the authority behind it. Written for
// someone who will be asked to sign the accounts: which account each thing posts to, when a
// cost is recognised, how GST and TDS are handled, what the statements are built from, and
// what the app refuses to do. Nothing here is opinion — each rule is in the code, and the
// worked examples run it.

function rule(title, body, cite) {
  return `<div class="card"><h3 style="margin:0 0 6px">${esc(title)}</h3>
    <div class="small muted" style="margin:0">${body}</div>
    ${cite ? `<p class="small faint" style="margin:8px 0 0">${cite}</p>` : ''}</div>`;
}
const accTable = (head, rows) => table(head, rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'small' : ''}">${c}</td>`).join('')}</tr>`).join(''));

function accountingItems() {
  const byType = t => ACCOUNTS.filter(a => a.type === t);
  const USE = {
    1000: 'Every bank receipt and payment, whatever the method — UPI, NEFT, cheque, debit card.',
    1010: 'The cash box, an account in its own right. Top-ups in, vouchers out. It may run negative, which normally means a top-up has not been recorded yet.',
    1100: 'Raised when an invoice is issued; cleared when the client pays.',
    1150: 'TDS a client deducted from your bill. Claimed against your own tax, not a cost.',
    1200: 'Anything paid for before it is used — an annual plan. Released monthly at month-end.',
    1300: 'Assets at cost. Never touched again except on disposal.',
    1350: 'Depreciation charged so far. Shown as a deduction from 1300, so the balance sheet reads at written-down value.',
    1400: 'CGST you paid and may claim.', 1401: 'SGST you paid and may claim.', 1402: 'IGST you paid and may claim.',
    1405: 'GST on a cost recorded before the vendor bill arrived. NOT claimable and NOT in the return until the invoice is on record.',
    1500: 'Money advanced to staff, recovered later.',
    1550: 'Money paid to a vendor beyond their bills. Applied first the next time you pay them.',
    2000: 'Everything owed to vendors and partners, always with the party on the line.',
    2100: 'Client tokens and advances. Not income until the deal registers or the client forfeits.',
    2200: 'CGST charged on your invoices.', 2201: 'SGST charged on your invoices.', 2202: 'IGST charged on your invoices.',
    2205: 'GST you owe as the buyer under reverse charge. Paid in cash with the return, then claimed as credit.',
    2250: 'TDS you withheld from a payment, until it is deposited.',
    2300: 'The credit card. A card purchase is a cost and a debt; cash only moves when the card bill is paid.',
    2400: 'Loan principal outstanding. Repaying it is not a cost.',
    2450: 'What the company owes its director — money put in, or costs paid personally.',
    2550: 'PF, ESI and other statutory deductions held until deposited.',
    3000: 'Share capital introduced.', 3100: 'The other side of opening balances when the books start.',
    3200: 'Money moved between your two records. Only ever seen from inside one of them — it carries the other book’s side of the transfer so that book still balances. Across both records it nets to zero and never appears.',
    4000: 'Brokerage earned from the seller.', 4010: 'Brokerage earned from the buyer.',
    4020: 'Consultancy and advisory fees.', 4030: 'A token kept when a deal falls through.',
    4040: 'Anything else earned.', 4050: 'A debt written off in an earlier year and later recovered.',
    4060: 'Not posted to by the Record screen: an amount a vendor lets you off comes off the cost of that bill instead. Kept for books carried in the other way.',
    5000: 'Office and premises rent.', 5010: 'Salaries, gross.', 5020: 'Bonus and incentive.',
    5030: 'Staff welfare and food. GST credit blocked.', 5040: 'Commission and referral fees paid.',
    5045: 'Costs of a specific deal — EC, patta, legal, documentation.',
    5050: 'Conveyance and fuel. GST credit blocked.', 5060: 'Electricity.', 5070: 'Internet and phone.',
    5075: 'Club and membership fees. GST credit blocked.', 5080: 'Software and subscriptions.',
    5090: 'Advertising and marketing.', 5100: 'Printing and stationery.', 5110: 'Photography and video.',
    5120: 'Professional fees.', 5130: 'Repairs and maintenance.', 5140: 'Bank and card charges.',
    5150: 'Interest and finance cost, including the interest half of every EMI.',
    5160: 'Rates, taxes and filing fees.',
    5165: 'Penalties and late-payment charges. Added back in the tax computation.',
    5170: 'Insurance.', 5180: 'Anything that fits nowhere else.',
    5185: 'Gifts and client hospitality. GST credit blocked.',
    5190: 'A debt given up as bad. Deductible.',
    5200: 'Depreciation, posted at month-end.',
    5210: 'What is lost when a prepaid plan is cancelled early.',
    5220: 'Loss on selling or scrapping an asset.',
    5225: 'Not posted to by the Record screen: a discount you allow a client comes off the brokerage income instead. Kept for books carried in the other way.',
    5230: 'A cost belonging to an earlier month that could not be posted there. Disclosed separately.',
  };
  const acctRows = list => list.map(a => [
    `<b>${esc(a.code)}</b> ${esc(a.name)}`,
    USE[a.code] || '',
  ]);

  return [
    item('How to read this tab', `
      <h2>The accounting, in full</h2>
      <p class="lead">What the engine decides and why, with the rule behind each one. If you are handing these books to
      a chartered accountant, this is the tab to hand over with them — it says exactly what the app will and will not do.</p>
      ${note('<b>Every entry is double entry.</b> Nothing saves unless debits equal credits, and no entry is ever edited or deleted — a mistake is corrected by posting its mirror image. The audit trail is the point.')}`),

    item('The chart of accounts', `
      <h2>The chart of accounts</h2>
      <p class="small muted">Fixed, not user-editable — that is what lets every report, register and statement be built without anyone mapping anything. What puts money into each account is named beside it.</p>
      <h3>Assets</h3>${accTable(`<th style="width:32%">Account</th><th>What lands here</th>`, acctRows(byType('asset')))}
      <h3>Liabilities</h3>${accTable(`<th style="width:32%">Account</th><th>What lands here</th>`, acctRows(byType('liability')))}
      <h3>Equity</h3>${accTable(`<th style="width:32%">Account</th><th>What lands here</th>`, acctRows(byType('equity')))}
      <h3>Income</h3>${accTable(`<th style="width:32%">Account</th><th>What lands here</th>`, acctRows(byType('income')))}
      <h3>Costs</h3>${accTable(`<th style="width:32%">Account</th><th>What lands here</th>`, acctRows(byType('expense')))}`),

    item('When a cost is recognised', `
      <h2>When a cost or income is recognised</h2>
      <div class="grid g1">
        ${rule('Accrual, not cash', 'A cost belongs to the period in which the thing was used, and income to the period in which it was earned. The bank date is a separate fact, kept separately. This is why the profit figure and the bank balance move differently, and why both are shown.', 'AS 1 / Ind AS 1 — accrual is a fundamental accounting assumption.')}
        ${rule('The month a cost belongs to', 'Rent used in September and invoiced on 4 October is a September cost. The bill form has a <b>which month is this cost for</b> box; the entry is dated the last day of that month while the document keeps its own date and due date. If that month has already been closed with month-end, the entry lands in the current month instead — the app will not silently reopen a closed period.', 'The closed-month case is disclosed as a prior-period item — see below.')}
        ${rule('Prior-period items', 'When a true-up cannot reach its own month — the month is closed, or releasing GST credit forces the entry onto the invoice date — the difference is posted to <b>5230 Prior-period adjustments</b> and shown on its own line in the profit statement, rather than being buried in this month\'s rent.', 'AS 5, paragraphs 15 to 19 — prior period items are disclosed separately.')}
        ${rule('Four states, one cost, counted once', 'An estimate is never posted. Recording the month posts the cost and creates the payable. The vendor bill adds identity and a due date to that same payable, and any difference. The payment settles it and touches no expense account. At no point can the same cost be counted twice — recording the month removes the estimate, and the payment is matched to the document rather than posted afresh.')}
      </div>`),

    item('Documents and settlement', `
      <h2>Documents, allocation and what "paid" means</h2>
      <div class="grid g1">
        ${rule('A document is a record, not a line item', 'Every bill and invoice is stored with its number, date, due date, taxable value, GST, TDS, total, how much has been paid, and every payment against it. Status — open, part-paid, settled, void — is derived from those numbers, never typed.')}
        ${rule('Allocation', 'A payment names the documents it settles and how much goes to each, oldest first by default and editable. Pay less and the document is part-paid; pay more and the excess is an advance to that vendor (1550) or, on the client side, money held (2100). This is what makes "which bill is still open" answerable at all.')}
        ${rule('An amount let off', 'A vendor letting you off part of a bill closes it in full, and the shortfall comes off the head the bill was booked to: rent that cost 17,500 is rent of 17,500, not rent of 18,000 and 500 earned. Income is what comes in. The GST credit on the part never paid goes back (Rule 37; s.34(2) if they sent a credit note); TDS you withheld is owed onward instead. On the client side a discount you allow comes off the brokerage income the invoice was raised on, while a bank charge the client\'s bank deducted is a cost, <b>5140</b>.', 'Both treatments give the same profit. These books show the net, which is what actually happened.')}
        ${rule('Reversals', 'A wrong entry is corrected by posting its mirror image; both stay visible. A bill or invoice cannot be reversed while payments against it still net above zero — reverse the payment first. An accrual whose vendor bill has since been attached cannot be reversed before that entry is. Documents are voided, never deleted.')}
      </div>`),

    item('GST', `
      <h2>GST</h2>
      <div class="grid g1">
        ${rule('One question, three answers', 'Every purchase form asks a single question about GST: <b>no GST at all</b>, <b>GST is on the bill and I can claim it</b>, or <b>no GST on the bill but I must pay it myself</b> (reverse charge). Nothing else has to be worked out by the person recording.')}
        ${rule('When input credit may be taken', 'Credit needs a tax invoice in your hands and the supply actually received. A month closed on your own figure has neither, so its GST is parked in <b>1405</b>, is not in that month\'s return, and is released to 1400 to 1402 only when the vendor bill is recorded — dated the invoice, which is the month the credit belongs to.', 'CGST Act s.16(2)(a) and (aa); Rule 36(4) on matching with GSTR-2B.')}
        ${rule('Credit that can never be taken', 'Blocked on staff food and welfare (5030), conveyance and fuel (5050), club and membership fees (5075) and gifts and client hospitality (5185). On those, the GST is added to the cost rather than claimed.', 'CGST Act s.17(5)(a), (b)(i), (b)(ii) and (h).')}
        ${rule('Reverse charge', 'Advocates, goods transport, an unregistered landlord, and any vendor billing from outside India. The tax is your liability (2205), paid in cash with the return — it cannot be set off against credit — and claimed back as input credit. A self-invoice is numbered automatically on the entry, because the vendor did not raise one.', 'CGST Act s.9(3) and s.9(4); s.31(3)(f) for the self-invoice; Notification 09/2024 for rent from an unregistered landlord.')}
        ${rule('Place of supply', 'For brokerage on immovable property, where the property is. For a service, where the client is. That decides CGST plus SGST or IGST — the app applies it from the profile state and the property or client state, so it is never a manual choice.', 'IGST Act s.12(3) for immovable property; s.12(2) otherwise.')}
        ${rule('Set-off order', 'IGST credit is used first, and against IGST liability before CGST or SGST. Only then may CGST and SGST credit be used against their own heads. The GST tab shows the working and the cash finally payable.', 'CGST Act s.49A and s.49B with Rule 88A.')}
        ${rule('Credit taken back, and credit that expires', 'A bill left unpaid for 180 days appears in the Rule 37 register — the credit has to be reversed and is reclaimed when you pay. Credit on an invoice also expires: the ITC register shows the last date for each one.', 'Rule 37; s.16(4) time limit.')}
        ${rule('What the registers give you', 'The ITC register is every purchase with credit, its invoice and its expiry. The GSTR-1 rows split your outward supplies into B2B, B2CL, B2CS, CDNR and CDNUR. The purchase and sales registers in Books are the same documents in date order.')}
      </div>`),

    item('TDS', `
      <h2>TDS</h2>
      <div class="grid g1">
        ${rule('Off until you need it', 'TDS is off by default and switched on in Settings. Once on, the forms that need it ask for the section and the rate, which is filled in from the section and can be corrected.')}
        ${rule('Withholding', 'The cost is the gross amount; the vendor is owed the gross less the tax withheld; the tax sits in <b>2250 TDS payable</b> until deposited. TDS is computed on the value excluding GST where the GST is shown separately.', 'Circular 23/2017 — TDS on the amount excluding GST where it is separately indicated.')}
        ${rule('Thresholds', 'The bill form shows how much this vendor has been billed in the financial year so far, so the section threshold can be judged. When a corrected bill pushes a vendor past a threshold with nothing withheld, the app says so rather than deciding for you.', 'Sections 194C, 194J, 194I, 194H and 194A, each with its own limit.')}
        ${rule('Deposit and return', 'Deposit by the 7th of the following month — except March, which is the 30th of April. The remittance records the month, the section, the challan and the BSR code, and the TDS register shows withheld against deposited by section, which is what a 26Q return is built from.', 'Rule 30(2) with its proviso for March; s.201(1A) interest at 1.5% a month if late.')}
      </div>`),

    item('Assets, prepaids and loans', `
      <h2>Assets, prepaid costs and borrowing</h2>
      <div class="grid g1">
        ${rule('Capitalisation', 'Anything expected to last beyond a year is an asset at cost (1300), not a cost. The threshold in Settings decides where the line is; below it, record an expense. Depreciation is straight-line over the useful life you set, posted at month-end (5200 against 1350), and the final month releases whatever is left so the asset closes at exactly its cost.', 'Book depreciation. Depreciation under s.32 of the Income-tax Act is computed separately by your CA — the two do not have to agree.')}
        ${rule('Prepaid costs', 'An annual plan is cash out once and an asset (1200), released a month at a time. The Services tab shows what is still sitting with the vendor.')}
        ${rule('An EMI is not a cost', 'One entry splits it: principal reduces the loan (2400), interest is the cost (5150), lender charges are 5140, and a late-payment penalty is 5165. Repaying principal never touches profit. A prepayment rebuilds the remaining schedule at the same rate and end date rather than leaving a stale one. Interest paid to a non-banking lender may carry 194A TDS.', 'Only the interest is an allowable cost; the principal is a balance-sheet movement.')}
      </div>`),

    item('The statements', `
      <h2>The statements, and what they are built from</h2>
      <div class="grid g1">
        ${rule('Trial balance', 'Opening, debits, credits and closing for every account that moved, over the range you choose. Written in the debit-minus-credit convention, so a liability shows as a credit. Income and expense accounts open at nil at each financial year start — they are closed to reserves — so a second year never opens with last year\'s revenue on it.')}
        ${rule('Profit and loss', 'Revenue, then the direct costs of earning it, gross profit, operating costs, EBITDA, then depreciation, finance cost and exceptional items, profit before tax, the tax estimate and profit after tax. Any account not named in a group still appears, under administration, so nothing can quietly fall out of the statement.', 'Grouped the way Schedule III of the Companies Act reads for a service company.')}
        ${rule('Balance sheet', 'Fixed assets at cost with accumulated depreciation beneath them, current assets, then owner\'s funds, borrowings and current liabilities, with retained profit split between earlier years and this one. It must balance; if it does not, the app says so rather than hiding the difference.')}
        ${rule('Cash book and the bridge', 'The cash book is opening, every movement and closing, for the bank, the box, or including the card. The bridge starts at profit and walks through every real movement — receivables, payables, assets bought, loan repaid, tax collected — to the cash that actually moved. Anything unexplained is shown.')}
        ${rule('Registers and exports', 'Purchase and sales registers for the period, and four CSVs: the journal with both sides of every entry, the trial balance, every ledger with balances brought forward, and a Tally-friendly file. A JSON backup of everything is one button away.')}
        ${rule('Income tax', 'The estimate on Reports applies the rate in Settings to book profit, and it is only an estimate. It does not add back disallowed items beyond flagging them, does not adjust for the difference between book and s.32 depreciation, and does not compute deferred tax. Your CA does the return.', 'The default 26% is 25% plus cess. The lower s.115BAA rate is an irrevocable election on Form 10-IC.')}
      </div>`),

    item('The check before you file', `
      <h2>The check, test by test</h2>
      <p class="small muted">On the Books tab. Twelve tests that can actually fail — each says what to do about it, and the ones that matter link straight to the page that fixes them.</p>
      ${accTable(`<th style="width:32%">Test</th><th>What it proves, and what to do</th>`, [
      ['Every entry balances on its own', 'Looks for an individual entry whose debits and credits disagree — corruption or a hand-edited record. Should never fire.'],
      ['The balance sheet ties out', 'Assets equal funds, liabilities and profit. A gap means an account is missing from the statement; tell your CA before filing.'],
      ['Vendor payables agree with the bills', 'The 2000 balance against the sum of open bills. A difference is money owed with no document — an opening balance, or an entry from before documents were tracked.'],
      ['Client receivables agree with the invoices', 'The same test on 1100.'],
      ['The cash box is not overdrawn', 'Tested on every day, not just today. A negative box is allowed — it normally means a top-up from the bank has not been recorded yet — so this is a note, not a failure.'],
      ['Every open bill has a due date', 'Without one it cannot appear in what is due this month.'],
      ['Vendor bills received for what you accrued', 'Months closed on your own figure that still have no vendor bill number. Each one is GST you cannot claim and a due date you do not know.'],
      ['Every recurring month is recorded', 'A commitment with a month missing means a cost that is not in your profit.'],
      ['Month-end has been run', 'Depreciation and prepaid releases waiting on a past month.'],
      ['TDS withheld has been deposited', 'Past its Rule 30(2) date, not merely outstanding — money withheld this month is not a finding.'],
      ['No vendor bill number is recorded twice', 'The same number twice for one vendor is a duplicate entry, and usually a duplicate payment waiting to happen.'],
      ['No GST is stuck waiting for an invoice', 'The balance in 1405 — credit you have paid for and cannot claim until the paperwork arrives.'],
    ])}`),

    item('What the app refuses to do', `
      <h2>What the app will not let you do</h2>
      <p class="small muted">Controls are worth more than warnings. These are refusals, not suggestions.</p>
      ${accTable(`<th style="width:44%">Attempt</th><th>Why it is refused</th>`, [
      ['Edit or delete a posted entry', 'Books that can be silently changed cannot be relied on by anyone, including a tax officer. Reverse and re-record.'],
      ['Save an entry that does not balance', 'Every entry is checked before it is written.'],
      ['Record the same recurring month twice', 'The month is already on the commitment; reverse the first entry if it was wrong.'],

      ['Reverse a bill or invoice that has been paid', 'Reverse the payment first, or reduce the invoice with a credit note.'],
      ['Reverse an accrual after its vendor bill was attached', 'The bill-arrived entry has to come off first, or it would point at a voided document.'],
      ['Let a vendor off more than is left on the bill', 'The shortfall cannot exceed what is outstanding.'],
      ['Date an entry before the books start', 'Set in Settings, once.'],
      ['Spend from an empty cash box', '<b>Allowed.</b> The box is an account, not a wallet — it may go negative, and the app warns rather than refusing. Add the missing top-up when you find it.'],
      ['Claim GST on a cost with no invoice behind it', 'Parked in 1405 until the invoice is recorded.'],
      ['Post to a closed month', 'Month-end has been run; the entry lands in the open month and is disclosed as a prior-period item.'],
    ])}`),

    item('Who did what, and when', `
      <h2>The audit trail</h2>
      <p class="small muted">Every entry records who created it and when, in sequence, with an entry number that cannot be reused — the number is reserved inside the same database transaction that writes the entry, so two people recording at once cannot collide. Attachments are stored against the entry itself rather than in a folder somewhere else. Reversals reference the entry they cancel, and the entry they cancel references them back. Nothing in the ledger is ever updated except to mark it reversed or to add an attachment; the database rules enforce that, not just the app.</p>`),
  ];
}
const accountingTab = () => accountingItems().map(i => i.html).join('');

// ═══════ 8. FAQ & GLOSSARY ═══════

const FAQ = [
  ['Basics', [
    ['Where do I see what an entry does to my accounts before I save it?',
      'The Record screen shows a <b>posting strip</b> under the preview: which account the money comes <b>from</b>, which it goes <b>to</b>, each with its code and what kind of account it is, and the effect on profit. Every category in a form shows its account code too — "5000 · Rent". The full debit and credit table is underneath for anyone who wants it.'],
    ['What is the difference between the payment method and the account?',
      'UPI, a debit card and NetBanking all draw on the same bank account (1000). A credit card is its own account (2300) because it is money you owe. Petty cash is its own (1010) because it is notes in a drawer. The method is recorded on the entry so a statement line can be matched by it — it is never a category and never an account.'],
    ['What does the Record switch at the top do?',
      'The cash box is kept as a <b>completely separate record</b>, so the switch does not hide part of one set of books — it chooses which set you are reading. <b>Both</b> shows the firm as a whole. <b>Bank</b> is your banked record on its own; <b>Cash</b> is the cash box on its own. Each is complete: its own income, its own costs, its own receivables, and it balances by itself. The two always add back up to Both, so nothing is lost and nothing is counted twice. It changes Transactions, Reports, Analytics and every CSV they export — the file name says which — but never the trial balance or balance sheet, which always show both records together. It lasts for this tab only, so it cannot be left on by accident.'],
    ['Which record does a deal belong to?',
      'Whichever one its money actually moved through — and that keeps the invoice, the income and the cash together, so a deal can never be half in one record and half in the other. When you raise an invoice you say how the money comes, <i>including when it has not arrived yet</i> ("not yet paid — will come in cash"), and that decides the record from the moment it is raised. If the money then turns up the other way, <b>what actually happened wins</b>: an invoice you expected in the bank but were paid for in notes becomes a cash-book invoice. A client who pays some cash and some bank gets <b>two invoices</b> on the same deal, one in each record — nothing is ever split down the middle.'],
    ['I moved money from the bank into the cash box. Which record is that in?',
      'Both — it is the one thing that crosses. The bank record shows the money leaving, the cash record shows it arriving, and each still balances because the other side is booked to <b>3200 Transfers between your two records</b>. Across both records that account nets to zero, which is why you never see it under <b>Both</b>. Neither record treats the other as owing it anything; it is simply your own money moving.'],
    ['How do estimates and budgets work? Do they post anything?',
      'No. An estimate is never an entry. The Budget tab reads what the books already expect — each recurring cost\'s amount for the month, loan interest from the schedule, depreciation, deals with an expected close month — and anything you type for an account. When the real thing is recorded, the same page shows expected against actual. Recording the actual is what "closes" the estimate: for a recurring cost that is <b>Record this month</b>; for a deal it is <b>Deal closed</b>.'],
    ['Rent is due at month-end but I pay on the 5th. Is that one entry or two?',
      'Two, and the app keeps them apart. At month-end, Recurring → <b>Record this month</b> → <b>Not paid yet — put it on Owed</b>: the cost is booked now (Dr Rent / Cr Payable) and the landlord appears on Owed. On the 5th, <b>Pay a bill</b> from Owed: the money leaves the bank and is matched to that bill. Nothing is counted twice.'],
    ['The rent bill for last month only arrives on the 4th. Which month does the cost belong to?',
      'The month you used the office — not the month the paperwork came. That is the whole point of accrual accounting and it is what the <b>Which month is this cost for?</b> box on the bill form is for. Set it to last month: the entry is dated the last day of that month, while the bill keeps its own date and its own due date. Last month\'s profit is then right, and the payment still shows up in this month\'s cash.'],
    ['I recorded a month with GST on it, before the vendor bill came. Have I claimed the GST?',
      'No, and deliberately. Under s.16(2) input credit needs a tax invoice in your hands, and it has to show up in your GSTR-2B — neither is true when you close a month on your own figure. The GST sits in <b>1405 GST on bills not yet received</b> and is not in that month\'s return. When you record <b>Bill arrived</b>, the credit is released into the month the invoice is dated, which is where it belongs. The check on Books tells you how much is waiting.'],
    ['I closed the month on my own figure. Now the vendor bill has come. What do I record?',
      '<b>Bill arrived for a month already recorded</b>. Pick what it is for, type the vendor\'s bill number, its date and the date you have to pay by, and the real amount. If the bill differs from your figure, the difference is posted back into the month you used it, so that month\'s profit is corrected rather than this month\'s. Nothing is entered twice. The same button sits on the Owed tab and on the Recurring month, next to anything still marked "awaited".'],
    ['Where do I see what is paid, what is invoiced, what is due and what is still a guess?',
      '<b>This month</b>, in the Daily group. Money out and money in are each shown in five buckets — paid, invoiced, due this month, overdue, still an estimate — then combined at the bottom. The top of the page answers the practical question: what is in the bank, what still has to go out, what is expected in, and what that leaves. Every bucket opens to show exactly what is in it.'],
    ['An estimate changed once the bill came. Does the old figure stay anywhere?',
      'It does, and that is deliberate. The commitment keeps what was expected for the month, the recorded event keeps what was actually charged, and the Budget and Recurring tabs both show the two side by side with the difference and the reason. An estimate is never posted to the books, so changing it never touches the accounts — but the trail of what you expected and what happened is kept.'],
    ['I made a profit but the bank went down. Where did the money go?',
      'Reports → <b>Profit is not cash</b> answers exactly this. It starts from the profit for the month and walks through every real movement — money clients still owe, bills you have not paid, assets bought, loan repaid, tax collected — and ends at the cash that actually moved. If anything is left unexplained the app shows it rather than hiding it.'],
    ['A client paid me. Why has my profit not gone up?',
      'Because it already did, on the day you raised the invoice — which should be the day the fee fell due, normally registration. That is when you earned the money. The payment is just the cash arriving afterwards, matched to that invoice. If receiving it increased profit too, you would be counting the same brokerage twice. <span class="small faint">Accrual basis — income is recognised when earned, not when received.</span>'],
    ['My bank balance is healthy but the app says I made a loss. Which is right?',
      'Both. Cash includes money that is not yours — client tokens you are holding, GST you owe the government, bills you have not paid yet. That is what <b>"free to use"</b> on the Overview is for: it strips those out. A loss with cash in the bank usually means you are holding other people\'s money.'],
    ['What can I hand my CA at the end of the year?',
      'Books gives all of it over one date range you choose: the <b>check</b> (twelve things that have to be true before anything is filed), the <b>trial balance</b> with opening, movement and closing for every account, the <b>profit and loss</b> down to profit after tax, the <b>balance sheet</b> grouped the way a schedule reads, every <b>ledger</b> with its balance brought forward, the <b>purchase and sales registers</b>, and the <b>general journal</b>. Four CSVs come off the same page — journal, trial balance, all ledgers, and a Tally-friendly file.'],
    ['Why does a bill I have not paid show up in Transactions?',
      'Because it is an entry: the cost is real the day the bill arrives, and profit for that month goes down by it. What has not happened yet is the money moving. Switch Transactions to <b>Money moved</b> to see only cash, or <b>Not paid yet</b> to see only bills and invoices waiting to settle. Reports → <b>Money in and out</b> is the cash book: opening, every movement, closing.'],
    ['The bill was ₹18,000, they gave me ₹500 off, I paid ₹17,500. How do I record that?',
      '<b>Pay a bill</b> → amount paid 17,500 → <b>Amount not being paid</b> 500, and say it was a discount. The bill closes in full, ₹17,500 leaves the bank, and the ₹500 comes off the rent — the rent cost ₹17,500, and nothing is booked as income. If the bill carried GST, the credit on the ₹500 goes back in the same entry, because you never paid that part; if the landlord sends a credit note, choose that instead so the return matches.'],
    ['I already paid the 17,500 as a normal payment and Owed still shows 500 on that bill.',
      '<b>Close what is left on a bill</b> — on the bill\'s row on Owed, or in the entry\'s drawer: ₹500, discount. No money moves; the bill closes and the ₹500 comes off the rent.'],
    ['A client paid ₹500 less than the invoice.',
      '<b>Client pays what they owe</b> → amount received → <b>Discount you gave them</b> 500, and say whether it was a discount you allowed — it comes off your brokerage income, the fee was that much less — or charges their bank deducted, which are a cost. The invoice closes in full. For a renegotiated brokerage use <b>Reduce an invoice — credit note</b>, which reduces the GST too.'],
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
    ['An EMI has principal, interest and some charges. Do I record three things?',
      'One entry. <b>Pay an EMI</b> shows principal and interest from the schedule — change them to what the lender\'s statement says — plus the lender\'s charges and any penalty. Principal reduces the loan; interest and charges are costs; a penalty is a cost the tax return disallows, so it sits in its own account (5165). Pay extra principal and the remaining schedule is rebuilt on the new balance.'],
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
    ['The brokerage was renegotiated after I invoiced. How do I reduce the invoice?',
      '<b>Reduce an invoice — credit note</b>. Pick the invoice, enter how much less, and why. Income and the GST on it come down, a numbered credit note is issued against the invoice, and what the client owes drops. If they had already paid, the difference is held for them or refunded. After 30 November of the following year the GST can no longer be reduced — the note is then commercial, base only.'],
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
    ['The GST question has three answers. Which one?',
      '<b>No GST</b> — nothing was charged and nothing applies: a small shop, an unregistered vendor, salaries, interest, government fees. Most petty purchases. <b>Yes — GST is on the bill</b> — a registered vendor charged it; enter it with their GSTIN and bill number and you claim it back. <b>No, but I must pay it myself</b> — reverse charge: an advocate, a goods transporter, an unregistered landlord for commercial rent, or any vendor abroad. You pay it with the return and claim the same amount back.'],
    ['My landlord is not registered for GST. Do I owe anything?',
      'Yes. Renting commercial premises from someone who is not registered puts the GST on you (Notification 09/2024-CT(R)). On <b>Expense paid now</b> or <b>Bill received</b>, answer <b>No</b> to "Did the vendor charge you GST?" and enter 18%. The app books it as money you owe the government and, at the same time, as credit you claim back — so it costs you nothing, but leaving it out is a real liability. The same applies to an advocate, a goods transporter, and anything bought from outside India.'],
    ['What is the self-invoice number on some entries?',
      'When you pay the GST yourself, the law asks you to raise your own invoice for the supply (s.31(3)(f) with Rule 47A). The app numbers one automatically in its own series and keeps it on the entry. For a purchase from abroad it also records the currency and the exchange rate you used (Rule 34).'],
    ['A bill has been sitting unpaid for months. Does that affect my GST?',
      'After 180 days from the bill date, the credit you claimed on it has to be added back with interest (Rule 37). The GST tab lists exactly which bills those are and how much to add back, so you can pay them first or hand the list to your CA. Pay the bill and you claim the credit again.'],
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
  ['Budget / projection', 'What you expect a month to look like. Never an entry — read from Recurring, Loans, Assets, Deals and anything you type, then set against what actually happened.'],
  ['Payment method', 'How money moved through the bank — UPI, debit card, NetBanking, cheque. Recorded on the entry; never an account.'],
  ['Recurring cost', 'Something you pay every month — rent, a subscription, a retainer. Added once with what you expect; each month you record what it actually was.'],
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
  ['Reverse charge (RCM)', 'GST paid by the buyer instead of the seller — advocates, goods transport, an unregistered landlord, and vendors abroad. Paid in cash with the return and claimed back as credit. Account 2205.'],
  ['Self-invoice', 'The invoice you raise to yourself for a reverse-charge purchase, because the vendor did not raise one. Numbered automatically.'],
  ['Rule 37', 'The rule that takes back GST credit on a bill left unpaid for 180 days. Pay the bill and you claim it again.'],
  ['Ageing', 'How long an invoice or a bill has been outstanding, counted from the day it fell due.'],
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
