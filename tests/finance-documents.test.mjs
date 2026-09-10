// ═══════ DOCUMENTS, ALLOCATION, SERVICES — MODERN-LIFE SCENARIOS ═══════
//
// The recording path a chartered accountant expects: a commitment (what a service is expected
// to cost), a document (the bill or invoice with identity and a due date), and a settlement
// (a payment allocated to specific documents) — with the variance visible at every join.
//
// Every scenario below is something that actually happens to a small business in 2026:
// a subscription upgraded mid-month with a prorated invoice, a foreign SaaS vendor under
// reverse charge, a client paying an invoice in two halves, a vendor paid too much, petty
// cash and UPI and card in the same week, a wrong entry undone. Each runs through the same
// harness as the app's save().
//
//   node tests/finance-documents.test.mjs

import {
  getState, num, bal, pl, today, trialBalance, balanceSheet, partyBalances, gstInputBal, gstComputation,
  expectedFor, serviceMonths, missingServiceMonths, nextPlanChange, serviceRunRate,
  agedReceivables, agedPayables, rule37Rows, cashProfitBridge, ym, movesMoney, cashBook,
  monthPicture, awaitingBill, plStatement, trialBalanceDetail, balanceSheetGrouped, booksHealth, projection,
  DISALLOWED, gstComputation as gstComp, monthCompare, fixedMonthly, breakEven,
  explain, INCOME_ACCS, EXPENSE_ACCS,
  outlook,
  openInvoices, openBills, invoiceOutstanding, billOutstanding, vendorAdvance, GST_RCM,
} from '../finance-assets/finance-core.js';
import { EV, validateEvent, fieldsFor } from '../finance-assets/finance-events.js';
import { collectionDays, paymentDays, vendorSpend, serviceVariance } from '../finance-assets/finance-analytics.js';
import { check, eq, near, section, refuses, report, fresh, save, reverse, runMonthEnd, byName, party } from './_harness.mjs';

const r2c = x => Math.round(x * 100) / 100;
console.log('3 PIN Realty — documents, allocation and services');
const s = fresh();

// Money to work with.
save('funding', { date: '2026-09-01', kind: '3000', who: 'Swaminathan N G', amt: 300000 });
save('transfer', { date: '2026-09-01', kind: '1000>1010', amt: 8000 });

// ═══════ 1. THE CLAUDE PRO STORY ═══════
//
// Added in September at ₹1,800/month, auto-charged from the bank. September and October are
// paid as expected. In mid-November the plan is upgraded; Anthropic sends a prorated invoice
// for ₹4,320 which is paid in November, and from December the full new price of ₹10,000 is
// expected. Anthropic bills from abroad, so there is no Indian GST on the invoice — the
// recipient pays IGST under reverse charge and claims it back.

section('Claude Pro — add, pay two months, upgrade mid-month with a prorated invoice');

save('subnew', {
  date: '2026-09-01', name: 'Claude', plan: 'Pro', vendor: { __new: true, name: 'Anthropic', type: 'vendor' },
  use: 'Content and drafting', payMode: 'monthly', billing: 'auto', amt: 1800, via: '1000',
});
const claude = byName(s.subs, 'Claude');
const anthropic = party('Anthropic');
check('Service was created with a vendor and a plan history', claude && claude.vendorId === anthropic && claude.history?.length === 1, JSON.stringify(claude));
eq('Nothing posted yet — adding a service is a commitment, not a cost', pl('2026-09').te, 0);
eq('September expects 1,800', expectedFor(claude, '2026-09'), 1800);

const txnsBefore = s.txns.length;
save('confirmcharge', { sub: claude.id, month: '2026-09', date: '2026-09-05', result: 'paid', via: '1000', amt: 1800, gst: 'no', rcm: 'no' });
save('confirmcharge', { sub: claude.id, month: '2026-10', date: '2026-10-05', result: 'paid', via: '1000', amt: 1800, gst: 'no', rcm: 'no' });
eq('Two months of cost', pl('2026-09').te + pl('2026-10').te, 3600);
eq('Two payments left the bank', bal('1000'), 300000 - 8000 - 3600);
check('Each month produced a paid bill on record', s.bills.filter(b => b.serviceId === claude.id && b.status === 'paid').length === 2);
check('The month records point at their bills', claude.charges['2026-09'].billId === s.bills[0].id && claude.charges['2026-09'].paid === true);
eq('No variance in a normal month', claude.charges['2026-10'].variance, 0);

// The upgrade month: invoice received for the prorated amount, paid later, new plan from December.
save('confirmcharge', {
  sub: claude.id, month: '2026-11', date: '2026-11-14', result: 'invoice', dueDate: '2026-11-28',
  amt: 4320, gst: 'no', rcm: 'yes', rcmRate: 18, rcmType: 'inter',
  reason: 'prorate', note: 'Upgraded to Max on the 14th',
  newPlan: 'yes', newAmount: 10000, newPlanName: 'Max', newFrom: '2026-12',
});
eq('November cost is the prorated invoice', pl('2026-11').te, 4320);
eq('The invoice is owed to Anthropic, not paid', bal('2000', { party: anthropic }), 4320);
const nov = claude.charges['2026-11'];
check('November records the variance and the reason', nov && near(nov.variance, 4320 - 1800) && nov.reason === 'prorate' && nov.paid === false, JSON.stringify(nov));
const novBill = s.bills.find(b => b.id === nov.billId);
check('An open bill exists for it, with the due date, linked to the service and month', novBill && novBill.status === 'open' && novBill.dueDate === '2026-11-28' && novBill.serviceId === claude.id && novBill.month === '2026-11', JSON.stringify(novBill));
eq('Reverse-charge IGST on a foreign vendor is input credit…', bal('1402'), 777.6);
eq('…and a liability to pay in cash with the return', bal(GST_RCM), 777.6);
eq('November still expected 1,800 (the old plan)', expectedFor(claude, '2026-11'), 1800);
eq('December expects the full new price', expectedFor(claude, '2026-12'), 10000);
eq('So does every month after', expectedFor(claude, '2027-03'), 10000);
check('The next plan change is visible from November', nextPlanChange(claude, '2026-11')?.from === '2026-12' && nextPlanChange(claude, '2026-11')?.amount === 10000);
check('The plan name updated', claude.plan === 'Max');
check('History has two dated entries', claude.history.length === 2 && claude.history[0].amount === 1800 && claude.history[1].amount === 10000);

// Pay the prorated invoice — the payment is matched to that bill.
save('paybill', { date: '2026-11-20', party: anthropic, amt: 4320, via: '1000' });
eq('Anthropic settled', bal('2000', { party: anthropic }), 0);
check('The prorated bill is now paid, by allocation', novBill.status === 'paid' && near(novBill.paid, 4320) && novBill.allocations.length === 1, JSON.stringify(novBill));
check('The month view shows Sep/Oct/Nov recorded and paid', serviceMonths(claude, '2026-11').every(m => m.status === 'recorded'), JSON.stringify(serviceMonths(claude, '2026-11').map(m => m.status)));

// December at the new price — no variance.
save('confirmcharge', { sub: claude.id, month: '2026-12', date: '2026-12-05', result: 'paid', via: '1000', amt: 10000, gst: 'no', rcm: 'yes', rcmRate: 18, rcmType: 'inter' });
eq('December: exactly as expected', claude.charges['2026-12'].variance, 0);
eq('December cost', pl('2026-12').te, 10000);

section('Claude Pro — the guards');
refuses('The same month cannot be recorded twice',
  () => save('confirmcharge', { sub: claude.id, month: '2026-12', date: '2026-12-06', result: 'paid', amt: 10000, gst: 'no', rcm: 'no' }), 'already recorded');
refuses('A month before the service started is refused',
  () => save('confirmcharge', { sub: claude.id, month: '2026-08', date: '2026-08-05', result: 'paid', amt: 1800, gst: 'no', rcm: 'no' }), 'only started');
refuses('A new plan cannot start before the month being recorded',
  () => save('confirmcharge', { sub: claude.id, month: '2027-01', date: '2027-01-05', result: 'paid', amt: 10000, gst: 'no', rcm: 'no', newPlan: 'yes', newAmount: 12000, newFrom: '2026-10' }), 'cannot start before');
refuses('A skipped month is fine, but a paid one needs an amount',
  () => save('confirmcharge', { sub: claude.id, month: '2027-01', date: '2027-01-05', result: 'paid', amt: 0, gst: 'no', rcm: 'no' }), 'actually billed');
save('confirmcharge', { sub: claude.id, month: '2027-01', date: '2027-01-05', result: 'skipped' });
check('A skipped month is recorded as skipped, nothing posted', claude.charges['2027-01'].skipped === true && pl('2027-01').te === 0);
check('Missing months are detected', missingServiceMonths('2027-03').some(m => m.sub.id === claude.id && m.month === '2027-02' && m.status === 'missing'));

// Undo a month: the bill is voided and the month can be recorded again.
section('Claude Pro — a wrong month reversed and re-recorded');
const decTxn = s.txns.find(t => t.event === 'confirmcharge' && t.desc.includes('Dec 2026'));
reverse(decTxn.id);
check('The bill behind it is void', s.bills.find(b => b.txnId === decTxn.id).status === 'void');
check('The month is flagged reversed and no longer counted', claude.charges['2026-12'].reversed === true && ['missing', 'due'].includes(serviceMonths(claude, '2026-12').find(m => m.month === '2026-12').status), JSON.stringify(serviceMonths(claude, '2026-12').find(m => m.month === '2026-12')));
eq('December cost is back to zero', pl('2026-12').te, 0);
save('confirmcharge', { sub: claude.id, month: '2026-12', date: '2026-12-05', result: 'paid', via: '1000', amt: 9500, gst: 'no', rcm: 'no', reason: 'discount', note: 'Annual-plan credit' });
eq('Re-recorded with the corrected figure', pl('2026-12').te, 9500);
eq('Variance against the 10,000 expected', claude.charges['2026-12'].variance, -500);

// ═══════ 2. A PLAN CHANGE WITH NO BILL YET ═══════

section('An annual plan from a vendor abroad — reverse charge on the upfront payment');
{
  const rcmBefore = bal(GST_RCM), itcBefore = bal('1402'), prepaidBefore = bal('1200'), bankBefore = bal('1000');
  save('subnew', {
    date: '2026-09-02', name: 'Google Workspace', plan: 'Business', vendor: { __new: true, name: 'Google', type: 'vendor' },
    payMode: 'upfront', amt: 12000, months: 12, via: '1000', rcm: 'yes', rcmRate: 18, rcmType: 'inter',
  });
  eq('Prepaid carries the bare amount', bal('1200') - prepaidBefore, 12000);
  eq('IGST under reverse charge is input credit', bal('1402') - itcBefore, 2160);
  eq('…and a liability to pay in cash', bal(GST_RCM) - rcmBefore, 2160);
  eq('Only the bare amount left the bank for the vendor', bankBefore - bal('1000'), 12000);
}

section('Changing a plan ahead of time, without a bill');
save('subnew', {
  date: '2026-09-01', name: 'Zoho CRM', plan: 'Standard', vendor: { __new: true, name: 'Zoho', type: 'vendor' },
  payMode: 'monthly', billing: 'invoice', amt: 2000, via: '1000',
});
const zoho = byName(s.subs, 'Zoho CRM');
save('subchange', { from: '2027-01', sub: zoho.id, plan: 'Professional', payMode: 'monthly', amt: 3500 });
eq('Before the change month the old amount holds', expectedFor(zoho, '2026-12'), 2000);
eq('From the change month the new one', expectedFor(zoho, '2027-01'), 3500);
check('Nothing was posted — it is only an expectation', !s.txns.some(t => t.event === 'subchange'));
refuses('A plan change before the service started is refused',
  () => save('subchange', { from: '2026-08', sub: zoho.id, plan: 'x', payMode: 'monthly', amt: 1 }), 'only started');

// An invoiced service: the month's bill is owed, then paid with everything else the vendor is owed.
save('confirmcharge', { sub: zoho.id, month: '2026-09', date: '2026-09-03', result: 'invoice', amt: 2000, gst: 'yes', gstRate: 18, gstAmt: 360, total: 2360, gstType: 'intra', vgstin: '33AAACZ1234A1Z5', vinv: 'ZH-991', rcm: 'no' });
save('confirmcharge', { sub: zoho.id, month: '2026-10', date: '2026-10-03', result: 'invoice', amt: 2000, gst: 'yes', gstRate: 18, gstAmt: 360, total: 2360, gstType: 'intra', vgstin: '33AAACZ1234A1Z5', vinv: 'ZH-1042', rcm: 'no' });
const zohoP = party('Zoho');
eq('Two invoiced months are owed', bal('2000', { party: zohoP }), 4720);
eq('GST on them is input credit', bal('1400') + bal('1401'), 720);
check('Both bills open, oldest first', openBills(zohoP).length === 2 && openBills(zohoP)[0].month === '2026-09');
check('The month view shows them as billed, not paid', serviceMonths(zoho, '2026-10').every(m => m.status === 'billed'));
check('A month recorded ahead of today still shows on the grid', serviceMonths(zoho, '2026-09').some(m => m.month === '2026-10' && m.status === 'billed'), JSON.stringify(serviceMonths(zoho, '2026-09').map(m => [m.month, m.status])));
check('An unrecorded month ahead of today is upcoming, not missing', !missingServiceMonths('2026-09').some(m => m.month > '2026-09'));

// ═══════ 3. PARTIAL PAYMENTS, OVER-PAYMENTS, ADVANCES ═══════

section('Paying a vendor in parts');
save('paybill', { date: '2026-10-10', party: zohoP, amt: 3000, via: '1000' });
const [zb1, zb2] = s.bills.filter(b => b.partyId === zohoP).sort((a, b) => a.month.localeCompare(b.month));
check('Oldest bill paid in full first', zb1.status === 'paid' && near(zb1.paid, 2360), JSON.stringify(zb1));
check('The next one is part-paid with the remainder', zb2.status === 'part' && near(zb2.paid, 640), JSON.stringify(zb2));
eq('Still owed', bal('2000', { party: zohoP }), 1720);
eq('Outstanding on the part-paid bill matches', billOutstanding(zb2), 1720);

section('Paying a vendor too much');
save('paybill', { date: '2026-10-12', party: zohoP, amt: 2000, via: '1000', over: 'advance' });
check('The bill is paid', zb2.status === 'paid');
eq('Nothing owed', bal('2000', { party: zohoP }), 0);
eq('The extra sits as an advance with the vendor', vendorAdvance(zohoP), 280);
refuses('Over-paying with "do not allow" is refused',
  () => save('paybill', { date: '2026-10-13', party: zohoP, amt: 100, via: '1000', over: 'stop' }), 'only owe');
refuses('Paying a vendor you do not owe is refused', () => save('paybill', { date: '2026-10-13', party: '', amt: 100, via: '1000' }), 'pick the vendor');

section('The advance is used against the next bill');
save('confirmcharge', { sub: zoho.id, month: '2026-11', date: '2026-11-03', result: 'invoice', amt: 2000, gst: 'yes', gstRate: 18, gstAmt: 360, total: 2360, gstType: 'intra', vgstin: '33AAACZ1234A1Z5', vinv: 'ZH-1101', rcm: 'no' });
save('paybill', { date: '2026-11-10', party: zohoP, amt: 2080, via: '1000', useAdvance: 'yes' });
eq('Advance is consumed', vendorAdvance(zohoP), 0);
eq('Vendor settled with cash + advance', bal('2000', { party: zohoP }), 0);
check('November bill paid', s.bills.find(b => b.partyId === zohoP && b.month === '2026-11').status === 'paid');

section('A bill with a due date, paid from petty cash, and the petty cash guard');
save('bill', { date: '2026-10-01', vendor: { __new: true, name: 'Ganesh Prints', type: 'vendor' }, desc: 'Flyers', acc: '5100', dueDate: '2026-10-15', amt: 9500, gst: 'no', rcm: 'no' });
const ganesh = party('Ganesh Prints');
check('Bill carries the due date typed', openBills(ganesh)[0].dueDate === '2026-10-15');
refuses('A due date before the bill date is refused',
  () => save('bill', { date: '2026-10-01', vendor: ganesh, desc: 'x', acc: '5100', dueDate: '2026-09-01', amt: 10, gst: 'no', rcm: 'no' }), 'before the bill date');
// The box is an account, not a wallet: paying more than it holds is allowed and simply
// leaves it overdrawn, which is what an unrecorded top-up looks like.
check('Paying more than the box holds is allowed, with a warning',
  validateEvent('paybill', { date: '2026-10-05', party: ganesh, amt: 9500, via: '1010' }).some(p => p.warn && /box/i.test(p.msg)));
check('…and nothing about it blocks the save',
  !validateEvent('paybill', { date: '2026-10-05', party: ganesh, amt: 9500, via: '1010' }).some(p => !p.warn && /box/i.test(p.msg)));
eq('The box is untouched until something is actually recorded', bal('1010'), 8000);
save('paybill', { date: '2026-10-05', party: ganesh, amt: 9500, via: '1000' });
eq('Ganesh settled from bank instead', bal('2000', { party: ganesh }), 0);

// ═══════ 4. CLIENT SIDE: INVOICE, PART PAYMENTS, OVER-PAYMENT ═══════

section('A client pays an invoice in two halves');
save('newdeal', { date: '2026-10-01', nickname: 'Lakshmi — Velachery plot', seller: { __new: true, name: 'Lakshmi' }, expSeller: 100000 });
const dealL = byName(s.deals, 'Lakshmi — Velachery plot').id;
save('invoice', { date: '2026-10-20', deal: dealL, from: 'seller', amt: 100000, gst: 'yes', gstRate: 18, gstAmt: 18000, total: 118000, tds: 0, adv: 0, recv: 'later', dueDate: '2026-11-19' });
const lakshmi = party('Lakshmi');
const invL = openInvoices(lakshmi)[0];
check('Invoice open with a due date', invL && invL.status === 'open' && invL.dueDate === '2026-11-19', JSON.stringify(invL));
save('dealpay', { date: '2026-11-01', party: lakshmi, amt: 50000, via: '1000' });
check('Part-paid', invL.status === 'part' && near(invL.paid, 50000));
eq('Outstanding on the invoice', invoiceOutstanding(invL), 68000);
eq('…and on the ledger', bal('1100', { party: lakshmi }), 68000);
save('dealpay', { date: '2026-11-15', party: lakshmi, amt: 70000, via: '1000', over: 'hold' });
check('Paid in full', invL.status === 'paid');
eq('Nothing owed', bal('1100', { party: lakshmi }), 0);
eq('The 2,000 extra is held for the client, not income', bal('2100', { party: lakshmi }), 2000);
eq('Income was never booked twice', pl('2026-10').ti + pl('2026-11').ti, 100000);
refuses('A client who owes nothing cannot "pay" — that is a token', () => save('dealpay', { date: '2026-11-16', party: lakshmi, amt: 10, via: '1000' }), 'owe nothing');

section('Other income with an invoice, paid later, then collected');
save('otherinc', { date: '2026-11-02', party: { __new: true, name: 'Prakash Builders', type: 'client', state: 'Karnataka' }, desc: 'Market study', acc: '4020', amt: 20000, gst: 'yes', gstRate: 18, gstAmt: 3600, total: 23600, via: 'later', dueDate: '2026-12-02' });
const prakash = party('Prakash Builders');
const invP = openInvoices(prakash)[0];
check('Out-of-state client → IGST invoice', invP && near(invP.igst, 3600) && invP.status === 'open', JSON.stringify(invP));
save('dealpay', { date: '2026-11-25', party: prakash, amt: 23600, via: '1000' });
check('Collected and matched', invP.status === 'paid' && bal('1100', { party: prakash }) === 0);

// ═══════ 5. VENDOR CREDIT NOTE ═══════

section('A vendor credit note against an unpaid bill');
save('bill', { date: '2026-11-05', vendor: ganesh, desc: 'Banners', acc: '5100', amt: 5000, gst: 'yes', gstRate: 18, gstAmt: 900, total: 5900, gstType: 'intra', vgstin: '33AAAGP1111A1Z5', vinv: 'GP-88', rcm: 'no' });
const banners = openBills(ganesh).find(b => b.desc === 'Banners');
const itcBefore = bal('1400') + bal('1401');
save('vendorrefund', { date: '2026-11-08', vendor: ganesh, desc: 'Banners — 1 damaged', acc: '5100', amt: 1000, gst: 'yes', gstRate: 18, gstAmt: 180, total: 1180, gstType: 'intra', how: 'credit' });
eq('What is owed drops by the credit note', bal('2000', { party: ganesh }), 5900 - 1180);
eq('The cost is reduced, not income booked', bal('5100'), 9500 + 5000 - 1000);
eq('The credit claimed on it is given back', bal('1400') + bal('1401'), itcBefore - 180);
check('The credit note is applied to the bill, which is now part-settled', banners.status === 'part' && near(banners.paid, 1180) && near(billOutstanding(banners), 4720), JSON.stringify(banners));
refuses('A credit note bigger than what you owe is refused',
  () => save('vendorrefund', { date: '2026-11-09', vendor: ganesh, desc: 'x', acc: '5100', amt: 9000, gst: 'no', how: 'credit' }), 'only owe');

// ═══════ 6. A WEEK OF MIXED MONEY: UPI, PETTY CASH, CARD ═══════

section('A mixed week — UPI, the box, the card');
const bankW = bal('1000'), boxW = bal('1010'), cardW = bal('2300'), igstW = bal('1402');
save('expense', { date: '2026-11-10', desc: 'Auto to registrar office', acc: '5050', amt: 240, gst: 'no', via: '1010' });
save('petty', { date: '2026-11-11', a1: 120, c1: '5030', d1: 'Tea for clients', a2: 300, c2: '5100', d2: 'Courier', a3: 0 });
save('expense', { date: '2026-11-12', desc: 'Meta ads', acc: '5090', amt: 4000, gst: 'yes', gstRate: 18, gstAmt: 720, total: 4720, gstType: 'inter', vgstin: '29AABCF1234A1Z5', vinv: 'FB-2211', via: '2300', vendor: { __new: true, name: 'Meta', type: 'vendor' } });
save('expense', { date: '2026-11-12', desc: 'Team lunch', acc: '5030', amt: 800, gst: 'yes', gstRate: 5, gstAmt: 40, total: 840, via: '1000' });
save('transfer', { date: '2026-11-13', kind: '1000>1010', amt: 2000 });
save('transfer', { date: '2026-11-14', kind: '1000>2300', amt: 4720 });
eq('Box: minus the auto and the vouchers, plus the top-up', bal('1010'), boxW - 240 - 420 + 2000);
eq('Card: charged then paid off', bal('2300'), cardW);
eq('Bank: lunch, top-up, card bill', bal('1000'), bankW - 840 - 2000 - 4720);
eq('Ads GST is IGST credit (vendor in another state)', bal('1402') - igstW, 720);
eq('Lunch GST is blocked — it stays in the cost', bal('5030'), 120 + 840);
{
  // Spending from an empty box is a real thing that happens; the books show it overdrawn
  // rather than pretending it did not happen.
  const boxBefore = bal('1010');
  save('petty', { date: '2026-11-15', d1: 'Big spend', a1: r2c(boxBefore + 500), c1: '5030', a2: 0, a3: 0 });
  eq('Spending more than the box holds leaves it overdrawn', bal('1010'), -500);
  check('…and the form said so before it was saved',
    validateEvent('petty', { date: '2026-11-15', d1: 'Big spend', a1: 999999, c1: '5030', a2: 0, a3: 0 }).some(p => p.warn && /box/i.test(p.msg)));
  save('transfer', { date: '2026-11-16', kind: '1000>1010', amt: 500 });
  eq('Recording the missing top-up brings it back to nil', bal('1010'), 0);
}
refuses('Paying the card more than it owes is refused',
  () => save('transfer', { date: '2026-11-15', kind: '1000>2300', amt: 1 }), 'card only has');

// ═══════ 7. REVERSING A PAYMENT GIVES THE BILL BACK ═══════

section('Reversing a payment reopens the bill');
save('bill', { date: '2026-11-18', vendor: ganesh, desc: 'Standees', acc: '5100', amt: 2000, gst: 'no', rcm: 'no' });
const standees = openBills(ganesh).find(b => b.desc === 'Standees');
const payTxn = save('paybill', { date: '2026-11-19', party: ganesh, amt: 2000, via: '1000', alloc: [{ id: standees.id, amt: 2000 }], over: 'advance' });
check('Paid against the chosen bill, not the oldest', standees.status === 'paid');
reverse(payTxn);
check('Reversal reopens it', standees.status === 'open' && near(standees.paid, 0), JSON.stringify(standees));
check('The reversal is recorded on the bill', standees.allocations.some(a => a.reversal));
eq('Ganesh is owed again', bal('2000', { party: ganesh }), 4720 + 2000);

// ═══════ 8. VALIDATION ON EVERY FORM ═══════

section('Every action refuses what it should');
refuses('A deal needs a nickname', () => save('newdeal', { date: '2026-11-01', nickname: '', seller: { __new: true, name: 'X' } }), 'nickname');
refuses('A deal needs a party', () => save('newdeal', { date: '2026-11-01', nickname: 'Nobody' }), 'seller or a buyer');
refuses('An expense needs a description', () => save('expense', { date: '2026-11-01', desc: '', acc: '5100', amt: 10, gst: 'no', via: '1000' }), 'what it was for');
refuses('An expense needs an amount', () => save('expense', { date: '2026-11-01', desc: 'x', acc: '5100', amt: 0, gst: 'no', via: '1000' }), 'above zero');
refuses('GST total must agree', () => save('expense', { date: '2026-11-01', desc: 'x', acc: '5100', amt: 100, gst: 'yes', gstRate: 18, gstAmt: 18, total: 200, via: '1000' }, { raw: true }), 'does not equal the total');
refuses('A GSTIN must look like one', () => save('expense', { date: '2026-11-01', desc: 'x', acc: '5100', amt: 100, gst: 'yes', gstRate: 18, gstAmt: 18, total: 118, vgstin: 'ABC', via: '1000' }), '15 characters');
refuses('A date before the books start is refused', () => save('expense', { date: '2026-01-01', desc: 'x', acc: '5100', amt: 10, gst: 'no', via: '1000' }), 'before the books start');
refuses('A date a year ahead is refused', () => save('expense', { date: '2028-01-01', desc: 'x', acc: '5100', amt: 10, gst: 'no', via: '1000' }), 'check the year');
{
  // Below the capitalisation threshold the app advises rather than blocks — a cheap part of
  // a bigger asset is still capital.
  const w = validateEvent('asset', { date: today(), name: 'Mouse', amt: 800, gst: 'no', rcm: 'no', life: 36, how: '1000' });
  check('An asset under the threshold warns rather than refuses', w.length === 1 && w[0].warn && w[0].k === 'amt', JSON.stringify(w));
}
refuses('An asset on credit needs a vendor', () => save('asset', { date: '2026-11-01', name: 'Desk', amt: 30000, gst: 'no', life: 60, how: 'bill' }), 'vendor');
save('dealcost', { date: '2026-11-01', deal: dealL, what: 'EC extract for Lakshmi', amt: 700, gst: 'no', bear: 'seller', how: '1000' });
refuses('A write-off needs a reason', () => save('writeoff', { date: '2026-11-01', deal: dealL, from: 'seller', amt: 1, why: '' }), 'reason');
refuses('A write-off cannot exceed what is owed', () => save('writeoff', { date: '2026-11-01', deal: dealL, from: 'seller', amt: 5000, why: 'x' }), 'only owe');
refuses('A loan needs a lender', () => save('bankloan', { date: '2026-11-01', purpose: 'x', amt: 100000, rate: 12, n: 24, fee: 0 }), 'lender');
refuses('A loan tenure must be sane', () => save('bankloan', { date: '2026-11-01', lender: { __new: true, name: 'HDFC' }, purpose: 'x', amt: 100000, rate: 12, n: 0, fee: 0 }), 'tenure');
refuses('Salary deductions cannot exceed gross', () => save('salary', { date: '2026-11-01', emp: { __new: true, name: 'Priya' }, kind: '5010', gross: 1000, tds: 0, pf: 2000 }), 'more than the salary');
refuses('A token needs a deal', () => save('token', { date: '2026-11-01', from: 'buyer', amt: 100, via: '1000' }), 'deal');
refuses('Statutory: paying more TDS than owed is refused', () => save('statutory', { date: '2026-11-01', kind: 'tds', amt: 5000, late: 0 }), 'only');

// Warnings do not block.
{
  const w = validateEvent('expense', { date: '2026-09-30', desc: 'x', acc: '5100', amt: 100, gst: 'yes', gstRate: 18, gstAmt: 18, total: 118, via: '1000' });
  check('A GST purchase without a vendor is a warning, not an error', w.length === 1 && w[0].warn && w[0].k === 'vendor', JSON.stringify(w));
  const far = validateEvent('expense', { date: '2026-11-30', desc: 'x', acc: '5100', amt: 100, gst: 'no', via: '1000' });
  check('A date well ahead is a warning', far.every(p => p.warn), JSON.stringify(far));
}

// Every event has a check() and every visible field has a label — nothing half-built.
{
  const missing = Object.entries(EV).filter(([, ev]) => typeof ev.check !== 'function').map(([k]) => k);
  check('Every action validates its form', missing.length === 0, missing.join(', '));
  const unlabeled = Object.keys(EV).flatMap(k => fieldsFor(k, {}).filter(f => !f.label).map(f => k + '.' + f.k));
  check('Every field has a label', unlabeled.length === 0, unlabeled.join(', '));
  const nodir = Object.entries(EV).filter(([, ev]) => !ev.dir).map(([k]) => k);
  check('Every action declares its direction for the colour cue', nodir.length === 0, nodir.join(', '));
}

// ═══════ 9. THE BOOKS STILL BALANCE ═══════

section('Invariants');
check('Trial balance balances', trialBalance().balanced);
check('Balance sheet balances', balanceSheet().balanced);
{
  // Every open document is backed by the ledger: the sum of open bills per vendor never
  // exceeds what the ledger says is owed to them.
  const bad = Object.entries(partyBalances('2000')).filter(([pid, owed]) => openBills(pid).reduce((a, b) => a + billOutstanding(b), 0) > owed + 0.02);
  check('Open bills never exceed the ledger balance for any vendor', bad.length === 0, JSON.stringify(bad));
  const badInv = Object.entries(partyBalances('1100')).filter(([pid, owed]) => openInvoices(pid).reduce((a, i) => a + invoiceOutstanding(i), 0) > owed + 0.02);
  check('Open invoices never exceed the ledger balance for any client', badInv.length === 0, JSON.stringify(badInv));
  const statuses = s.bills.filter(b => b.status !== 'void').every(b => b.status === (billOutstanding(b) <= 0.005 ? 'paid' : num(b.paid) > 0.005 ? 'part' : 'open'));
  check('Every bill status agrees with its numbers', statuses);
}

section('Reporting reads the plan in force and each due date');
{
  // A rise dated for the future must not move today's run-rate.
  const zoho2 = byName(s.subs, 'Zoho CRM');
  const nowM = ym(today());
  eq('Run-rate today ignores a change dated ahead', serviceRunRate(nowM).monthly - serviceRunRate(nowM).monthly, 0);
  check('Run-rate uses expectedFor, not the latest plan entered',
    Math.abs(serviceRunRate('2026-12').monthly - serviceRunRate('2027-01').monthly) > 0.5
    || expectedFor(zoho2, '2026-12') !== expectedFor(zoho2, '2027-01'),
    JSON.stringify([serviceRunRate('2026-12').monthly, serviceRunRate('2027-01').monthly]));

  // Ageing runs per document, from the day it fell due.
  const aged = agedReceivables('2026-12-31');
  check('Receivable ageing has a bucket for what has no invoice', 'no document' in aged, JSON.stringify(aged));
  eq('Ageing still reconciles to the ledger',
    Object.values(aged).reduce((a, b) => a + b, 0), bal('1100', { upto: '2026-12-31' }));
  const agedP = agedPayables('2026-12-31');
  eq('Payables ageing reconciles to the ledger',
    Object.values(agedP).reduce((a, b) => a + b, 0), bal('2000', { upto: '2026-12-31' }));

  // Rule 37: a bill left unpaid 180 days costs back the credit claimed on it.
  save('bill', {
    date: '2026-09-02', vendor: { __new: true, name: 'Slow Supplies', type: 'vendor' }, desc: 'Signage',
    acc: '5100', amt: 10000, gst: 'yes', gstRate: 18, gstAmt: 1800, total: 11800,
    gstType: 'intra', vgstin: '33AAASS1111A1Z5', vinv: 'SS-1', rcm: 'no', tds: 'none', tdsrate: 0,
  });
  check('A bill under 180 days old is not flagged', !rule37Rows('2026-11').some(r => r.vendor === 'Slow Supplies'));
  const flagged = rule37Rows('2027-04').find(r => r.vendor === 'Slow Supplies');
  check('Past 180 days it is flagged with the credit to give back', flagged && near(flagged.reverse, 1800), JSON.stringify(flagged));

  // The bridge has to explain every rupee of the month's cash movement.
  for (const m of ['2026-09', '2026-10', '2026-11']) {
    const b = cashProfitBridge(m);
    check(`Cash-to-profit bridge ties for ${m}`, Math.abs(b.residual) < 1, JSON.stringify({ residual: b.residual, cashMoved: b.cashMoved, explained: b.explained }));
  }

  // Days to collect and to pay, measured off the documents.
  const st = getState();
  const dso = collectionDays(st), dpo = paymentDays(st);
  check('Days to collect is measured from matched payments', dso.count > 0 && dso.avg >= 0, JSON.stringify(dso));
  check('Days to pay is measured the same way', dpo.count > 0 && dpo.avg >= 0, JSON.stringify(dpo));

  // Vendor spend comes from the bills, so a two-party entry cannot misattribute it.
  const spend = vendorSpend(st);
  check('Vendor spend adds up to the bills raised', spend.length > 0 && Math.abs(spend.reduce((a, x) => a + x.share, 0) - 100) < 0.5, JSON.stringify(spend.slice(0, 3)));

  // Variance by reason is what says whether tool spend drifts on price or on usage.
  const sv = serviceVariance(st);
  check('Service variance groups by the reason given', sv.rows.length > 0 && Object.keys(sv.byReason).length > 0, JSON.stringify(sv.byReason));
}

section('An estimate becomes an event, then a bill, then a payment — and stays in its own month');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 500000 });
  save('subnew', { date: '2026-09-01', name: 'Office rent', kind: 'rent', acc: '5000', vendor: { __new: true, name: 'Landlord', type: 'vendor' }, payMode: 'monthly', billing: 'invoice', amt: 20000, via: '1000', start: '2026-09' });
  const rent = byName(g.subs, 'Office rent');
  const landlord = party('Landlord');

  // 1. Start of the month: an estimate, and only an estimate.
  const sep = monthPicture('2026-09');
  eq('September starts as an estimate of 20,000', sep.out.estimated.amt, 20000);
  eq('…which is not in the books', sep.out.booked, 0);
  eq('…and nothing is invoiced yet', sep.out.invoiced.amt, 0);
  check('The estimate says where it came from', sep.out.estimated.rows[0].kind === 'recurring');
  eq('Nothing has been paid', sep.out.paid.amt, 0);

  // 2. End of the month: the estimate becomes an event. No money moves.
  save('confirmcharge', { sub: rent.id, month: '2026-09', date: '2026-09-30', result: 'invoice', amt: 20000, rcm: 'no' });
  const bill = g.bills.find(b => b.serviceId === rent.id);
  check('The month is recorded as a bill you owe', bill.status === 'open' && near(billOutstanding(bill), 20000), JSON.stringify(bill));
  check('…flagged as accrued, because no vendor bill has come', bill.accrued === true);
  check('…and the month it belongs to is on the document', bill.period === '2026-09', bill.period);
  eq('September now carries the cost', pl('2026-09').te, 20000);
  const sep2 = monthPicture('2026-09');
  eq('The estimate is gone — it became an event', sep2.out.estimated.amt, 0);
  eq('…and is not counted twice', sep2.out.booked, 20000);
  eq('No money moved in September', sep2.out.paid.amt, 0);
  check('It is waiting for the vendor bill', awaitingBill().length === 1 && awaitingBill()[0].id === bill.id);

  // 3. The bill turns up on 4 October, due on the 15th, and is 500 more than expected.
  save('billarrived', { billId: bill.id, vinv: 'RENT/SEP', date: '2026-10-04', dueDate: '2026-10-15', amt: 20500, gstAmt: 0 });
  check('The vendor bill number is on the record', bill.billNo === 'RENT/SEP' && bill.dueDate === '2026-10-15', JSON.stringify(bill));
  check('…and it is no longer waiting', bill.accrued === false && awaitingBill().length === 0);
  eq('The extra 500 lands in September, the month the office was used', pl('2026-09').te, 20500);
  eq('October carries none of the rent', pl('2026-10').te, 0);
  eq('The whole 20,500 is owed', bal('2000', { party: landlord }), 20500);
  const trueUp = g.txns.at(-1);
  eq('The true-up entry is dated the end of September', trueUp.date, '2026-09-30');
  check('Trial balance holds', trialBalance().balanced);

  // The accrual cannot be pulled out from under the vendor bill.
  refuses('An accrual with the vendor bill against it cannot be reversed first',
    () => reverse(g.txns.find(x => x.event === 'confirmcharge').id), 'Bill arrived');

  // 4. October: September's rent is a bill dated the 4th and due on the 15th, while
  //    October's own rent is back at the start of the cycle as an estimate.
  const oct = monthPicture('2026-10');
  eq('September rent is invoiced in October, to pay in October', oct.out.invoiced.amt, 20500);
  eq('…and due this month', oct.out.due.amt, 20500);
  eq('…while October own rent is only an estimate again', oct.out.estimated.amt, 20000);
  eq('…and October is not asked to carry September cost', oct.out.booked, 0);
  eq('Cash to find in October is the bill plus this month rent', oct.cash.needed, 40500);
  eq('…and no income is assumed, because none is invoiced', oct.cash.expected, 0);

  // 5. Paid on the 15th.
  save('paybill', { date: '2026-10-15', party: landlord, amt: 20500, via: '1000', useAdvance: 'no' });
  const oct2 = monthPicture('2026-10');
  eq('October shows it paid', oct2.out.paid.amt, 20500);
  eq('…nothing is left due', oct2.out.due.amt, 0);
  eq('…and only October own rent is still to come', oct2.out.committed, 20000);
  check('The bill is closed', bill.status === 'paid');
  eq('The landlord is square', bal('2000', { party: landlord }), 0);
  eq('September still owns the cost', pl('2026-09').te, 20500);
}

section('A bill for last month, recorded this month');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 200000 });
  save('bill', { date: '2026-10-04', period: '2026-09', vendor: { __new: true, name: 'Printer', type: 'vendor' }, desc: 'September flyers', acc: '5100', amt: 6000, rcm: 'no', dueDate: '2026-10-20', tds: 'none', tdsrate: 0 });
  eq('The cost belongs to September', pl('2026-09').te, 6000);
  eq('…not to October', pl('2026-10').te, 0);
  const b = g.bills.at(-1);
  check('The document keeps its own date and due date', b.date === '2026-10-04' && b.dueDate === '2026-10-20', JSON.stringify(b));
  eq('The entry is dated the last day of the month it belongs to', g.txns.at(-1).date, '2026-09-30');
  eq('October is the month it has to be paid', monthPicture('2026-10').out.due.amt, 6000);
  check('A cost cannot belong to a month after the bill',
    validateEvent('bill', { date: '2026-10-04', period: '2026-11', vendor: 'x', desc: 'y', acc: '5100', amt: 100, rcm: 'no' }).some(p => p.k === 'period' && !p.warn));

  // A closed month is not reopened behind the owner's back.
  g.monthEnds['2026-09'] = { at: Date.now() };
  save('bill', { date: '2026-10-05', period: '2026-09', vendor: { __new: true, name: 'Courier', type: 'vendor' }, desc: 'September courier', acc: '5180', amt: 900, rcm: 'no', tds: 'none', tdsrate: 0 });
  eq('September is closed, so the late bill lands in October', pl('2026-10').te, 900);
  check('…and the form says so before you save',
    validateEvent('bill', { date: '2026-10-05', period: '2026-09', vendor: 'x', desc: 'y', acc: '5180', amt: 900, rcm: 'no' }).some(p => p.k === 'period' && p.warn));
}

section('The month, four ways — what is paid, invoiced, due and still a guess');
{
  const g = fresh();
  save('funding', { date: '2026-11-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 400000 });
  // An estimate that has not happened.
  save('subnew', { date: '2026-11-01', name: 'Internet', kind: 'utility', acc: '5070', vendor: { __new: true, name: 'ISP', type: 'vendor' }, payMode: 'monthly', billing: 'invoice', amt: 2000, via: '1000', start: '2026-11' });
  // A bill that arrived this month and is due this month.
  save('bill', { date: '2026-11-03', vendor: { __new: true, name: 'Signboard Co', type: 'vendor' }, desc: 'Signage', acc: '5090', amt: 15000, rcm: 'no', dueDate: '2026-11-25', tds: 'none', tdsrate: 0 });
  // A bill that arrived last month and went overdue.
  save('bill', { date: '2026-10-10', vendor: { __new: true, name: 'Old Vendor', type: 'vendor' }, desc: 'October work', acc: '5100', amt: 4000, rcm: 'no', dueDate: '2026-10-31', tds: 'none', tdsrate: 0 });
  // Something paid on the spot.
  save('expense', { date: '2026-11-05', desc: 'Fuel', acc: '5050', amt: 1200, rcm: 'no', via: '1000' });
  // Income expected, invoiced and collected.
  save('newdeal', { date: '2026-11-01', nickname: 'Nov deal', seller: { __new: true, name: 'Client N', type: 'client' }, expSeller: 60000, expMonth: '2026-11' });
  const p = monthPicture('2026-11');
  eq('Paid this month', p.out.paid.amt, 1200);
  eq('Invoiced this month, to pay later', p.out.invoiced.amt, 15000);
  eq('Due this month', p.out.due.amt, 15000);
  eq('Overdue from before', p.out.overdue.amt, 4000);
  eq('Still only an estimate', p.out.estimated.amt, 2000);
  eq('Cash still to find this month', p.out.committed, 15000 + 4000 + 2000);
  eq('Income still an estimate', p.in.estimated.amt, 60000);
  eq('The only money in was the owner putting capital in', p.in.paid.amt, 400000);
  eq('The month, clubbed: the books show what November itself cost', p.out.booked, 15000 + 1200);
  eq('…and the net still to settle is what is owed both ways', p.net.toSettle, 0 - (15000 + 4000));
  eq('…while the net estimate is income less costs still guessed', p.net.estimated, 60000 - 2000);
  // The answer a spending decision needs is the conservative one: costs counted generously,
  // income counted only where a document exists. A deal the owner hopes to close is not cash.
  check('The spendable figure counts only income with a document behind it',
    p.cash.after === r2c(p.cash.now + p.in.documented - p.out.committed), JSON.stringify(p.cash));
  eq('…so the 60,000 deal is not in it', p.cash.expected, 0);
  eq('…it is shown separately as the hopeful figure', p.cash.expectedAll, 60000);
  eq('Cash in hand is net of client money and the card', p.cash.now, r2c(p.cash.inHand - p.cash.tokens - p.cash.card));

  // A figure the owner types for an account replaces what the app worked out for it — the
  // same rule the Budget page follows. The internet subscription must not appear twice.
  g.settings.budgets = { '2026-11': { 5070: 2500 } };
  const pb = monthPicture('2026-11');
  eq('A typed figure replaces the estimate for that account, it does not add to it', pb.out.estimated.amt, 2500);
  check('…and the row says it came from you', pb.out.estimated.rows.some(r => r.kind === 'budget'), JSON.stringify(pb.out.estimated.rows));
  eq('…which is what Budget shows for the same account', projection('2026-11').rows.find(r => r.code === '5070').planned, 2500);
  g.settings.budgets = {};
}

section('GST on a purchase is one question with three answers');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 200000 });
  // No GST at all: a small purchase from an unregistered shop.
  save('expense', { date: '2026-09-02', desc: 'Tea and snacks', acc: '5030', amt: 300, rcm: 'no', via: '1000' });
  eq('No GST: nothing claimed, nothing owed', bal('1400') + bal('1401') + bal('1402') + bal('2205'), 0);
  eq('…the whole amount is the cost', bal('5030'), 300);
  // Charged on the bill: the vendor is registered, and we claim it.
  save('expense', { date: '2026-09-03', desc: 'Printer toner', acc: '5100', amt: 2000, rcm: 'charged', gstRate: 18, gstAmt: 360, total: 2360, gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'T-1', via: '1000', vendor: { __new: true, name: 'Toner Co', type: 'vendor' } });
  eq('Charged: the GST is input credit', bal('1400') + bal('1401'), 360);
  eq('…and the cost is the bare amount', bal('5100'), 2000);
  eq('…and the bank paid the total', bal('1000'), 200000 - 300 - 2360);
  // Reverse charge: an advocate paid on the spot.
  save('expense', { date: '2026-09-04', desc: 'Sale deed opinion', acc: '5120', amt: 10000, rcm: 'yes', rcmRate: 18, rcmType: 'intra', via: '1000', vendor: { __new: true, name: 'Adv. Kumar', type: 'vendor' } });
  eq('Reverse charge: the advocate got the bare fee', bal('1000'), 200000 - 300 - 2360 - 10000);
  eq('…the GST is owed to the government by you', bal('2205'), 1800);
  eq('…and claimed back as credit at the same time', bal('1400') + bal('1401'), 360 + 1800);
  // The same answer on a bill received later.
  save('bill', { date: '2026-09-05', vendor: { __new: true, name: 'Reg Vendor', type: 'vendor' }, desc: 'Signage', acc: '5100', amt: 5000, rcm: 'charged', gstRate: 18, gstAmt: 900, total: 5900, gstType: 'intra', vgstin: '33BBBBB0000B1Z5', vinv: 'S-9', tds: 'none', tdsrate: 0 });
  eq('A charged bill is owed with its GST', bal('2000', { party: party('Reg Vendor') }), 5900);
  // The form hides the old yes/no on purchase forms and derives it.
  const f = fieldsFor('expense', { rcm: 'charged', gst: 'yes' });
  check('Purchase forms show one GST question, not two', f.some(x => x.k === 'rcm') && !f.some(x => x.k === 'gst'), JSON.stringify(f.map(x => x.k)));
  const fi = fieldsFor('otherinc', { via: '1000' });
  check('Income forms keep the simple yes/no', fi.some(x => x.k === 'gst') && !fi.some(x => x.k === 'rcm'));
}

section('Paying less than the bill says');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 100000 });
  save('bill', { date: '2026-09-02', vendor: { __new: true, name: 'Discount Vendor', type: 'vendor' }, desc: 'Banners', acc: '5100', amt: 18000, rcm: 'no', tds: 'none', tdsrate: 0 });
  const dv = party('Discount Vendor');
  const bill = openBills(dv)[0];
  refuses('You cannot be let off more than is left',
    () => save('paybill', { date: '2026-09-10', party: dv, amt: 17500, short: 600, via: '1000', useAdvance: 'no' }), 'left to close');
  save('paybill', { date: '2026-09-10', party: dv, amt: 17500, short: 500, via: '1000', useAdvance: 'no' });
  eq('The bill closes in full', bal('2000', { party: dv }), 0);
  check('…and the document says paid', bill.status === 'paid' && near(bill.paid, 18000), JSON.stringify(bill));
  eq('Only 17,500 left the bank', bal('1000'), 100000 - 17500);
  eq('The 500 comes off the cost of the banners', bal('5100'), 17500);
  eq('Nothing is booked as income', bal('4060'), 0);
  check('Trial balance still balances', trialBalance().balanced);

  // The client side: a discount you allowed, and charges their bank deducted.
  save('newdeal', { date: '2026-09-03', nickname: 'Short-pay deal', seller: { __new: true, name: 'Seller S', type: 'client' }, expSeller: 50000 });
  const d = byName(g.deals, 'Short-pay deal').id;
  save('invoice', { date: '2026-09-05', deal: d, from: 'seller', amt: 50000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  const cl = party('Seller S');
  const inv = openInvoices(cl)[0];
  save('dealpay', { date: '2026-09-12', party: cl, amt: 49200, short: 800, shortWhy: 'discount', via: '1000' });
  eq('The invoice closes in full', bal('1100', { party: cl }), 0);
  check('…and the document says paid', inv.status === 'paid', inv.status);
  eq('The discount allowed comes off the brokerage — income is what came in', bal('4000'), 50000 - 800);
  eq('…and is not a cost', bal('5225'), 0);
  save('newdeal', { date: '2026-09-03', nickname: 'Bank-charge deal', seller: { __new: true, name: 'Seller T', type: 'client' }, expSeller: 20000 });
  const d2 = byName(g.deals, 'Bank-charge deal').id;
  save('invoice', { date: '2026-09-06', deal: d2, from: 'seller', amt: 20000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  const cl2 = party('Seller T');
  save('dealpay', { date: '2026-09-13', party: cl2, amt: 19950, short: 50, shortWhy: 'charges', via: '1000' });
  eq('Charges their bank took are bank charges, not a discount', bal('5140'), 50);

  // The owner's own case: the bill was paid short BEFORE the discount field existed, so
  // 500 is still open. Closing it is a payment of nothing with 500 let off — no cash line.
  save('bill', { date: '2026-09-14', vendor: { __new: true, name: 'Office Landlord', type: 'vendor' }, desc: 'Rent — Aug', acc: '5000', amt: 18000, rcm: 'no', tds: 'none', tdsrate: 0 });
  const ll = party('Office Landlord');
  save('paybill', { date: '2026-09-15', party: ll, amt: 17500, via: '1000', useAdvance: 'no', over: 'advance' });
  eq('After a plain short payment 500 is still owed', bal('2000', { party: ll }), 500);
  const bankBefore = bal('1000');
  save('paybill', { date: '2026-09-16', party: ll, amt: 0, short: 500, via: '1000', useAdvance: 'no' });
  eq('Letting off the rest with no money closes the bill', bal('2000', { party: ll }), 0);
  eq('…no cash moved', bal('1000'), bankBefore);
  check('…and the bill document is paid', openBills(ll).length === 0);
  eq('…the 500 came off the rent', bal('5000'), 18000 - 500);
  eq('…and that invoice is settled too', bal('1100', { party: cl2 }), 0);
}

section('The books versus the money');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 50000 });
  save('transfer', { date: '2026-09-02', kind: '1000>1010', amt: 5000 });
  save('bill', { date: '2026-09-03', vendor: { __new: true, name: 'Later Vendor', type: 'vendor' }, desc: 'Flyers', acc: '5100', amt: 3000, rcm: 'no', tds: 'none', tdsrate: 0 });
  save('petty', { date: '2026-09-04', d1: 'Auto', a1: 200, c1: '5050', a2: 0, a3: 0 });
  save('expense', { date: '2026-09-05', desc: 'Ads', acc: '5090', amt: 1000, rcm: 'no', via: '2300' });
  check('A bill received does not move money', !movesMoney(g.txns.find(t => t.desc.startsWith('Flyers'))));
  check('A petty spend does', movesMoney(g.txns.find(t => t.event === 'petty')));
  check('A card spend counts as money moved', movesMoney(g.txns.find(t => t.desc === 'Ads')));
  const cb = cashBook('2026-09-01', '2026-09-30');
  eq('Cash book opens at zero', cb.opening, 0);
  eq('Money in is the capital', cb.in, 50000 + 5000);
  eq('Money out is the top-up and the auto', cb.out, 5000 + 200);
  eq('Closing equals what bank and box hold', cb.closing, bal('1000') + bal('1010'));
  check('The bill is not in the cash book', !cb.rows.some(r => r.t.desc.startsWith('Flyers')));
  const card = cashBook('2026-09-01', '2026-09-30', ['1000', '1010', '2300']);
  eq('Including the card adds the ad spend to money out', card.out, 5000 + 200 + 1000);
  const bank = cashBook('2026-09-01', '2026-09-30', ['1000']);
  eq('The bank alone: capital in, top-up out', bank.closing, 45000);
  const paid = save('paybill', { date: '2026-09-08', party: party('Later Vendor'), amt: 3000, via: '1000', useAdvance: 'no' });
  check('Paying the bill moves money', movesMoney(g.txns.find(t => t.id === paid)));
}

section('A bill blocks a reversal only while a payment still stands against it');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: 'Owner', amt: 100000 });
  save('bill', {
    date: '2026-09-02', vendor: { __new: true, name: 'Reversal Test Co', type: 'vendor' },
    desc: 'Signage', acc: '5100', amt: 5000, gst: 'no', rcm: 'no', tds: 'none', tdsrate: 0,
  });
  const vend = party('Reversal Test Co');
  const billTxn = g.txns.at(-1).id;
  const theBill = g.bills.at(-1);
  const payTxn = save('paybill', { date: '2026-09-10', party: vend, amt: 5000, via: '1000', useAdvance: 'no' });
  refuses('A bill with a payment against it cannot be reversed',
    () => reverse(billTxn), 'reverse the payment first');
  reverse(payTxn);
  check('The bill reopens when the payment is undone', theBill.status === 'open' && near(theBill.paid, 0), JSON.stringify(theBill));
  reverse(billTxn);
  check('…and now the bill itself can be reversed, which voids it', theBill.status === 'void', theBill.status);
  eq('Nothing is owed to that vendor any more', bal('2000', { party: vend }), 0);

  // A month paid on the spot creates a bill that is born paid, with no separate payment to
  // undo — reversing it must take the bill with it in one step.
  save('subnew', {
    date: '2026-09-01', name: 'Straight-through', vendor: { __new: true, name: 'SaaS Co', type: 'vendor' },
    payMode: 'monthly', billing: 'auto', amt: 1000, via: '1000',
  });
  const sub2 = byName(g.subs, 'Straight-through');
  const paidTxn = save('confirmcharge', { sub: sub2.id, month: '2026-09', date: '2026-09-05', result: 'paid', via: '1000', amt: 1000, gst: 'no', rcm: 'no' });
  const bornPaid = g.bills.at(-1);
  check('The bill is born paid, with no allocation behind it', bornPaid.status === 'paid' && (bornPaid.allocations || []).length === 0);
  reverse(paidTxn);
  check('Reversing it voids the bill in one step', bornPaid.status === 'void', bornPaid.status);
}

section('GST is not claimed before the invoice that carries it');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 300000 });
  save('subnew', { date: '2026-09-01', name: 'Cloud hosting', kind: 'service', acc: '5080', vendor: { __new: true, name: 'Host Co', type: 'vendor' }, payMode: 'monthly', billing: 'invoice', amt: 10000, via: '1000', start: '2026-09' });
  const host = byName(g.subs, 'Cloud hosting');
  const hostP = party('Host Co');

  // The month is closed on the owner's own figure. GST is on it, but no tax invoice exists.
  save('confirmcharge', { sub: host.id, month: '2026-09', date: '2026-09-30', result: 'invoice',
    amt: 10000, rcm: 'charged', gstRate: 18, gstAmt: 1800, total: 11800, gstType: 'intra' });
  eq('The credit is not taken — there is no tax invoice yet', bal('1400') + bal('1401') + bal('1402'), 0);
  eq('…it is held in its own account', bal('1405'), 1800);
  eq('…the vendor is owed the full amount all the same', bal('2000', { party: hostP }), 11800);
  eq('…and September carries the cost', pl('2026-09').te, 10000);
  const bill = g.bills.find(x => x.serviceId === host.id);
  eq('The document remembers how much is held', bill.gstParked, 1800);
  const sepAvail = gstComp('2026-09').availed;
  eq('September claims nothing in its GST working', sepAvail.cgst + sepAvail.sgst + sepAvail.igst, 0);

  // The invoice arrives on 6 October.
  save('billarrived', { billId: bill.id, vinv: 'HOST/912', date: '2026-10-06', dueDate: '2026-10-20', amt: 10000, gstAmt: 1800, gstType: 'intra' });
  eq('Now the credit is taken', bal('1400') + bal('1401'), 1800);
  eq('…and nothing is left held', bal('1405'), 0);
  eq('The credit belongs to October, the month of the invoice', g.txns.at(-1).date, '2026-10-06');
  const octAvail = gstComp('2026-10').availed;
  eq('…which is where the GST working picks it up', octAvail.cgst + octAvail.sgst + octAvail.igst, 1800);
  eq('September still owns the cost, unchanged', pl('2026-09').te, 10000);
  eq('…and October is not given a cost that was not its own', pl('2026-10').te, 0);
  check('Trial balance holds throughout', trialBalance().balanced);
  check('The document is complete', bill.billNo === 'HOST/912' && bill.gstParked === 0 && bill.accrued === false, JSON.stringify(bill));
}

section('A cost that can no longer reach its own month is disclosed, not buried');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 200000 });
  save('subnew', { date: '2026-09-01', name: 'Office rent', kind: 'rent', acc: '5000', vendor: { __new: true, name: 'Landlord', type: 'vendor' }, payMode: 'monthly', billing: 'invoice', amt: 20000, via: '1000', start: '2026-09' });
  const rent = byName(g.subs, 'Office rent');
  save('confirmcharge', { sub: rent.id, month: '2026-09', date: '2026-09-30', result: 'invoice', amt: 20000, rcm: 'no' });
  const bill = g.bills.find(x => x.serviceId === rent.id);
  g.monthEnds['2026-09'] = { at: Date.now() };

  save('billarrived', { billId: bill.id, vinv: 'R/9', date: '2026-10-04', dueDate: '2026-10-15', amt: 20800, gstAmt: 0 });
  eq('September keeps what it was closed with', pl('2026-09').te, 20000);
  eq('…the 800 is shown as a prior-period adjustment', bal('5230'), 800);
  eq('…in the month it was found', pl('2026-10').te, 800);
  check('…and the entry does not touch the rent account', !g.txns.at(-1).lines.some(l => l.acc === '5000'), JSON.stringify(g.txns.at(-1).lines));
  eq('The vendor is owed the corrected amount', bal('2000', { party: party('Landlord') }), 20800);
  check('Trial balance holds', trialBalance().balanced);
}

section('Credit blocked by s.17(5), and a bad debt that is not disallowed');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 200000 });
  save('expense', { date: '2026-09-05', desc: 'Club membership', acc: '5075', amt: 20000, rcm: 'charged', gstRate: 18, gstAmt: 3600, total: 23600, gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'C-1', via: '1000', vendor: { __new: true, name: 'City Club', type: 'vendor' } });
  eq('Club membership: the GST is part of the cost, not a credit', bal('5075'), 23600);
  eq('…nothing reaches the input heads', bal('1400') + bal('1401') + bal('1402'), 0);
  save('expense', { date: '2026-09-06', desc: 'Diwali gifts for clients', acc: '5185', amt: 10000, rcm: 'charged', gstRate: 18, gstAmt: 1800, total: 11800, gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'G-1', via: '1000', vendor: { __new: true, name: 'Gift Shop', type: 'vendor' } });
  eq('Gifts: blocked the same way', bal('5185'), 11800);
  eq('…still nothing claimed', bal('1400') + bal('1401') + bal('1402'), 0);
  check('A penalty is added back in the tax computation', DISALLOWED.has('5165'));
  check('A bad debt written off is not — s.36(1)(vii), TRF Ltd', !DISALLOWED.has('5190'));
}

section('The trial balance closes the year, and the check panel finds real problems');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 200000 });
  save('expense', { date: '2026-09-10', desc: 'Rent', acc: '5000', amt: 20000, rcm: 'no', via: '1000' });
  // A new financial year starts on 1 April 2027.
  const next = trialBalanceDetail('2027-04-01', '2027-04-30');
  const rentRow = next.rows.find(r => r.acc.code === '5000');
  check('Last year rent does not open the new year', !rentRow || rentRow.opening === 0, JSON.stringify(rentRow));
  const bankRow = next.rows.find(r => r.acc.code === '1000');
  eq('…while the bank carries forward, as it must', bankRow.opening, bal('1000'));
  const same = trialBalanceDetail('2026-10-01', '2026-10-31');
  eq('Within the same year the cost is carried into the next month', same.rows.find(r => r.acc.code === '5000').opening, 20000);

  // Two bills with one number is how a vendor gets paid twice.
  save('bill', { date: '2026-09-12', vendor: { __new: true, name: 'Twice Co', type: 'vendor' }, desc: 'Job A', acc: '5100', amt: 5000, rcm: 'no', vinv: 'TC/7', tds: 'none', tdsrate: 0 });
  let health = booksHealth('2026-09-30');
  check('One bill number is fine', health.checks.find(c => c.key === 'dupbills').ok);
  save('bill', { date: '2026-09-20', vendor: party('Twice Co'), desc: 'Job A again', acc: '5100', amt: 5000, rcm: 'no', vinv: 'TC/7', tds: 'none', tdsrate: 0 });
  health = booksHealth('2026-09-30');
  check('The same number twice is caught before it is paid twice', !health.checks.find(c => c.key === 'dupbills').ok);
  check('…and it is treated as serious, not a note', health.checks.find(c => c.key === 'dupbills').level === 'bad');
  check('Every entry balancing is checked, not just the total', health.checks.find(c => c.key === 'tb').ok);
}

section('The cash box is an account: spend from it with nothing in it');
{
  // The owner's rule, tested on every form that can pay out of the box: money can be put in,
  // money can be spent through it, and having a balance first is never a condition. An empty
  // box that goes negative is a top-up nobody has recorded yet, not an entry to refuse.
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 300000 });
  eq('The box starts empty', bal('1010'), 0);

  const spends = [
    ['petty', { date: '2026-09-02', d1: 'Tea for a site visit', a1: 300, c1: '5030', a2: 0, a3: 0 }, 300],
    ['expense', { date: '2026-09-03', desc: 'Auto fare', acc: '5050', amt: 200, rcm: 'no', via: '1010' }, 200],
    ['salary', { date: '2026-09-04', emp: { __new: true, name: 'Helper', type: 'employee' }, kind: '5010', gross: 2000, tds: 0, pf: 0, via: '1010' }, 2000],
    ['asset', { date: '2026-09-05', name: 'Desk fan', vendor: { __new: true, name: 'Fan Shop', type: 'vendor' }, amt: 1500, rcm: 'no', life: 36, how: '1010' }, 1500],
    ['dealcost', { date: '2026-09-06', deal: null, what: 'EC copy', bear: 'self', acc: '5045', amt: 400, rcm: 'no', how: '1010' }, 400],
  ];
  let spent = 0;
  for (const [key, vals, amt] of spends) {
    if (key === 'dealcost') {
      save('newdeal', { date: '2026-09-01', nickname: 'Box deal', seller: { __new: true, name: 'Client B', type: 'client' }, expSeller: 10000 });
      vals.deal = byName(g.deals, 'Box deal').id;
    }
    const before = g.txns.length;
    save(key, vals);
    spent = r2c(spent + amt);
    check(`${key}: paid from an empty box without being refused`, g.txns.length === before + 1);
    eq(`…and the box shows it`, bal('1010'), -spent);
  }

  check('Every one of them warned first, so nothing was silent',
    spends.every(([key, vals]) => validateEvent(key, vals).some(x => x.warn && /box/i.test(x.msg))));
  check('…and none of those warnings blocked anything',
    spends.every(([key, vals]) => !validateEvent(key, vals).some(x => !x.warn && /box/i.test(x.msg))));

  eq('The box is overdrawn by everything spent through it', bal('1010'), -4400);
  check('The books still balance', trialBalance().balanced);
  const health = booksHealth('2026-09-30');
  const boxCheck = health.checks.find(c => c.key === 'petty');
  check('The check calls an overdrawn box something to look at, not a failure', boxCheck.level === 'warn', boxCheck.level);
  check('…and says what it usually means', /top-up/i.test(boxCheck.detail), boxCheck.detail);

  // Putting money in works the same way it does for the bank, and squares the account.
  save('transfer', { date: '2026-09-30', kind: '1000>1010', amt: 4400 });
  eq('Recording the top-up brings the box back to nil', bal('1010'), 0);
  check('…and the check goes quiet', booksHealth('2026-09-30').checks.find(c => c.key === 'petty').ok);

  // Money can also arrive straight into the box without passing through the bank.
  save('funding', { date: '2026-10-01', kind: '2450', who: { __new: true, name: 'Owner', type: 'director' }, amt: 1000, via: '1010' });
  eq('Cash put straight into the box counts', bal('1010'), 1000);
  save('transfer', { date: '2026-10-02', kind: '1010>1000', amt: 3000 });
  eq('Sweeping more than it holds is allowed too', bal('1010'), -2000);
  check('The trial balance is unbothered by any of it', trialBalance().balanced);
}

section('Every figure can be opened, and the parts add up to it');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 400000 });
  save('newdeal', { date: '2026-09-01', nickname: 'Drill deal', seller: { __new: true, name: 'Client D', type: 'client' }, expSeller: 80000 });
  const dd = byName(g.deals, 'Drill deal').id;
  save('invoice', { date: '2026-09-10', deal: dd, from: 'seller', amt: 80000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  save('expense', { date: '2026-09-11', desc: 'Ads', acc: '5090', amt: 5000, rcm: 'no', via: '1000' });
  save('expense', { date: '2026-09-12', desc: 'More ads', acc: '5090', amt: 3000, rcm: 'no', via: '1000' });
  save('expense', { date: '2026-09-13', desc: 'Rent', acc: '5000', amt: 20000, rcm: 'no', via: '1000' });
  save('expense', { date: '2026-10-02', desc: 'October ads', acc: '5090', amt: 1000, rcm: 'no', via: '1000' });

  const p = pl('2026-09');
  eq('Income opens to exactly the income figure', explain({ accs: INCOME_ACCS, month: '2026-09', flip: true }).total, p.ti);
  eq('Costs open to exactly the cost figure', explain({ accs: EXPENSE_ACCS, month: '2026-09' }).total, p.te);
  eq('Profit opens to exactly the profit figure', explain({ profit: true, month: '2026-09' }).total, p.profit);
  eq('The bank opens to its balance', explain({ accs: '1000' }).total, bal('1000'));
  eq('Receivables open to what clients owe', explain({ accs: '1100' }).total, bal('1100'));

  const ads = explain({ accs: '5090', month: '2026-09' });
  eq('One category opens to that category alone', ads.total, 8000);
  eq('…listing every entry behind it', ads.count, 2);
  check('…newest first', ads.rows[0].date === '2026-09-12', ads.rows.map(r => r.date).join());
  check('…each row leading to its entry', ads.rows.every(r => g.txns.some(x => x.id === r.txnId)));
  eq('…and the month filter really filters', explain({ accs: '5090', month: '2026-10' }).total, 1000);

  const parts = explain({ accs: EXPENSE_ACCS, month: '2026-09' }).rows.reduce((s2, r) => s2 + r.amt, 0);
  eq('The rows shown are the whole of the total, never a sample', r2c(parts), p.te);

  // A figure with nothing in the ledger behind it says so rather than showing a wrong number.
  eq('A month with no entries opens empty', explain({ accs: EXPENSE_ACCS, month: '2026-12' }).count, 0);

  // Narrowing by party and by kind of entry both work, for the analytics filters.
  const client = party('Client D');
  eq('It can be narrowed to one party', explain({ accs: '1100', party: client }).total, bal('1100', { party: client }));
  eq('…and to one kind of entry', explain({ events: ['expense'], accs: EXPENSE_ACCS, month: '2026-09' }).total, 28000);
}

section('Three months ahead on what is already known');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 60000 });
  // A commitment that repeats, and one bill already due next month.
  save('subnew', { date: '2026-09-01', name: 'Office rent', kind: 'rent', acc: '5000', vendor: { __new: true, name: 'Landlord', type: 'vendor' }, payMode: 'monthly', billing: 'invoice', amt: 20000, via: '1000', start: '2026-09' });
  save('bill', { date: '2026-09-20', vendor: { __new: true, name: 'Printer', type: 'vendor' }, desc: 'Brochures', acc: '5100', amt: 10000, rcm: 'no', dueDate: '2026-10-10', tds: 'none', tdsrate: 0 });

  const o = outlook(3, '2026-09');
  eq('It opens with cash that is actually yours', o.opening, r2c(bal('1000') + bal('1010') - bal('2100') - bal('2300')));
  eq('Three months are shown', o.rows.length, 3);
  eq('September expects the rent it has not recorded', o.rows[0].guessed, 20000);
  eq('…and the brochure bill is not due until October', o.rows[0].committed, 0);
  eq('October has the bill as a certainty', o.rows[1].committed, 10000);
  eq('…and its own rent as an estimate', o.rows[1].guessed, 20000);
  const first = o.rows[0], second = o.rows[1];
  eq('Each month closes where the last left off', second.closing, r2c(first.closing + second.in - second.out));
  check('It says which month runs out first', o.firstShort === '2026-11', String(o.firstShort));
  check('…and the worst point is never above the opening here', o.worst <= o.opening);
  eq('The certain and estimated halves add up to what has to go out', r2c(first.committed + first.guessed), first.out);
}

section('This month against last month, and what it costs to stand still');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 500000 });
  save('newdeal', { date: '2026-09-01', nickname: 'Sept deal', seller: { __new: true, name: 'Client S', type: 'client' }, expSeller: 100000 });
  const d1 = byName(g.deals, 'Sept deal').id;
  save('invoice', { date: '2026-09-20', deal: d1, from: 'seller', amt: 100000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  save('expense', { date: '2026-09-10', desc: 'Ads', acc: '5090', amt: 10000, rcm: 'no', via: '1000' });
  save('expense', { date: '2026-10-10', desc: 'Ads', acc: '5090', amt: 25000, rcm: 'no', via: '1000' });
  save('expense', { date: '2026-10-11', desc: 'Rent', acc: '5000', amt: 20000, rcm: 'no', via: '1000' });

  const c = monthCompare('2026-10');
  eq('It compares with the month before', c.prev, '2026-09');
  eq('Income fell to nothing', c.income.now, 0);
  eq('…from a hundred thousand', c.income.prev, 100000);
  eq('Costs rose', c.expense.now, 45000);
  check('The biggest mover is named first', c.movers[0].code === '4000' || c.movers[0].code === '5000', JSON.stringify(c.movers.map(x => [x.code, x.change])));
  const ads = c.rows.find(r => r.code === '5090');
  eq('Advertising is up by 15,000', ads.change, 15000);
  check('…and a cost going up is flagged as the bad direction', ads.worse === true);
  const inc = c.rows.find(r => r.code === '4000');
  check('Income falling is flagged the same way', inc.worse === true, JSON.stringify(inc));

  // Fixed costs: a commitment, a loan and an asset all arrive whether or not a deal closes.
  save('subnew', { date: '2026-10-01', name: 'Office rent', kind: 'rent', acc: '5000', vendor: { __new: true, name: 'Landlord', type: 'vendor' }, payMode: 'monthly', billing: 'invoice', amt: 20000, via: '1000', start: '2026-10' });
  const f = fixedMonthly('2026-11');
  eq('The recurring commitment is the fixed cost', f.total, 20000);
  check('…and it is named, not just totalled', f.items[0].what === 'Office rent', JSON.stringify(f.items));

  const be = breakEven('2026-11');
  eq('Break-even starts from the fixed cost', be.fixed, 20000);
  check('Margin comes from the months actually traded', be.basedOn >= 1, String(be.basedOn));
  check('…and the income needed is the fixed cost over that margin', near(be.need, r2c(be.fixed / be.margin)), JSON.stringify({ need: be.need, margin: be.margin }));
  check('November has earned nothing yet, so it is short', !be.covered && be.gap > 0);
}

section('The statements an accountant reads');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: { __new: true, name: 'Owner', type: 'director' }, amt: 500000 });
  save('newdeal', { date: '2026-09-02', nickname: 'September deal', seller: { __new: true, name: 'Client A', type: 'client' }, expSeller: 100000 });
  const d = byName(g.deals, 'September deal').id;
  save('invoice', { date: '2026-09-10', deal: d, from: 'seller', amt: 100000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  save('dealcost', { date: '2026-09-12', deal: d, what: 'EC and patta', bear: 'self', acc: '5045', amt: 8000, rcm: 'no', how: '1000' });
  save('expense', { date: '2026-09-15', desc: 'Office rent', acc: '5000', amt: 20000, rcm: 'no', via: '1000' });
  save('expense', { date: '2026-09-16', desc: 'Ads', acc: '5090', amt: 5000, rcm: 'no', via: '1000' });

  const st = plStatement({ month: '2026-09' });
  eq('Revenue is the brokerage', st.revenue, 100000);
  eq('Direct costs are what earning it cost', st.direct, 8000);
  eq('Gross profit is the difference', st.grossProfit, 92000);
  eq('Running costs sit below it', st.opex, 25000);
  eq('EBITDA follows', st.ebitda, 67000);
  eq('…and with no interest or depreciation, that is profit before tax', st.pbt, 67000);
  check('Tax is provided at the settings rate', st.tax > 0 && near(st.pat, st.pbt - st.tax), JSON.stringify({ tax: st.tax, pat: st.pat }));
  check('Every account that moved appears in a group',
    st.groups.flatMap(x => x.rows).length === Object.keys(pl('2026-09').inc).length + Object.keys(pl('2026-09').exp).length);

  const tb = trialBalanceDetail('2026-09-01', '2026-09-30');
  check('The trial balance balances on movement', tb.balanced, JSON.stringify(tb.totals));
  eq('Debits equal credits for the period', tb.totals.debit, tb.totals.credit);
  const bank = tb.rows.find(r => r.acc.code === '1000');
  eq('The bank opened at nothing', bank.opening, 0);
  eq('…and closed where the ledger says', bank.closing, bal('1000'));
  const may = trialBalanceDetail('2026-10-01', '2026-10-31');
  eq('October opens where September closed', may.rows.find(r => r.acc.code === '1000').opening, bal('1000'));

  const bs = balanceSheetGrouped('2026-09-30', '2026-04-01');
  check('The balance sheet balances', bs.balanced, JSON.stringify({ a: bs.totalAssets, f: bs.totalFunds, diff: bs.diff }));
  eq('This year owns the whole profit', bs.profitThisYear, 67000);
  eq('…and no earlier year carries any', bs.profitEarlier, 0);
  check('Receivables sit in current assets', bs.assets.find(x => x.key === 'current').rows.some(r => r.code === '1100'));
  check('Liabilities read as positive figures', bs.funds.every(gp => gp.rows.every(r => r.amt >= 0)), JSON.stringify(bs.funds));

  const health = booksHealth('2026-09-30');
  check('The health check says the books balance', health.checks.find(c => c.key === 'tb').ok);
  check('…and the receivables control agrees with the invoice', health.checks.find(c => c.key === 'ar').ok);
  check('…and it notices there are no opening balances', !health.checks.find(c => c.key === 'opening').ok);
  check('Every check says what to do about it', health.checks.every(c => c.label && c.detail));
}

report();
