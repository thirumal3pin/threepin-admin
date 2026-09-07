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
  agedReceivables, agedPayables, rule37Rows, cashProfitBridge, ym,
  openInvoices, openBills, invoiceOutstanding, billOutstanding, vendorAdvance, GST_RCM,
} from '../finance-assets/finance-core.js';
import { EV, validateEvent, fieldsFor } from '../finance-assets/finance-events.js';
import { collectionDays, paymentDays, vendorSpend, serviceVariance } from '../finance-assets/finance-analytics.js';
import { check, eq, near, section, refuses, report, fresh, save, reverse, runMonthEnd, byName, party } from './_harness.mjs';

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
refuses('Petty cash cannot pay more than the box holds',
  () => save('paybill', { date: '2026-10-05', party: ganesh, amt: 9500, via: '1010' }), 'petty cash only holds');
// Box holds 8,000 at the start; the guard above is about the amount typed vs the box.
check('…because the guard checks the balance', bal('1010') === 8000);
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
refuses('Vouchers beyond the box are refused',
  () => save('petty', { date: '2026-11-15', a1: 999999, c1: '5030', a2: 0, a3: 0 }), 'petty cash only holds');
refuses('Moving more than the box holds to the bank is refused',
  () => save('transfer', { date: '2026-11-15', kind: '1010>1000', amt: 999999 }), 'petty cash only holds');
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

report();
