// ═══════ THE DEAL CYCLE IS NOT A PIPELINE ═══════
//
// A deal's status says where it sits on its timeline. It used to decide what could be
// recorded against it, and that was wrong in three ways the owner hit in practice:
//
//   · money on a deal could only be received into the bank on an invoice, so a brokerage
//     handed over in notes had nowhere to land;
//   · a cancelled deal vanished from every picker, so the EC you had already ordered could
//     not be paid for and a client paying late had nowhere for the money to go;
//   · a fee agreed for a deal that died could only be booked by forfeiting a token in full,
//     so a client who had paid no token could not be billed at all.
//
// What follows is the reworked cycle: every money action available at every status, into
// either the bank or the cash box, with a flat fee that stands on its own.
//
//   node tests/finance-dealcycle.test.mjs

import { getState, bal, invoiceOutstanding } from '../finance-assets/finance-core.js';
import { EV, fieldsFor } from '../finance-assets/finance-events.js';
import { invoiceModel } from '../finance-assets/finance-invoice.js';
import { fresh, save, check, eq, section, report, party, refuses } from './_harness.mjs';

const BUYER = { __new: true, name: 'Mr. Karthik', type: 'client' };
const SELLER = { __new: true, name: 'Rajan', type: 'client' };
const buyer = () => party('Mr. Karthik');
const seller = () => party('Rajan');
const dealId = () => getState().deals[0].id;
const lastInv = () => getState().invoices.at(-1);
const cancel = () => { getState().deals[0].status = 'cancelled'; };

function openDeal(opts = {}) {
  fresh({ booksStartDate: '2026-09-01', tdsEnabled: false, ...opts });
  save('funding', { date: '2026-09-01', kind: '3000', who: 'Owner', amt: 300000 });
  save('newdeal', {
    date: '2026-09-05', nickname: 'Rajan — Nungambakkam 2BHK',
    seller: SELLER, buyer: BUYER, expSeller: 80000, expBuyer: 100000,
  });
}

// Every debit equals every credit, across every entry posted so far.
function balanced(label) {
  let dr = 0, cr = 0;
  for (const t of getState().txns) for (const l of t.lines) { dr += +l.dr || 0; cr += +l.cr || 0; }
  return eq(label, dr, cr);
}

// ═══════ 1. MONEY IN LANDS WHEREVER IT ACTUALLY ARRIVED ═══════

section('Money on a deal arrives in the bank or in the cash box — never only the bank');

openDeal();
save('token', { date: '2026-09-10', deal: dealId(), from: 'buyer', amt: 50000, via: '1010' });
eq('A token handed over in notes sits in the cash box', bal('1010'), 50000);
eq('...and nothing went through the bank', bal('1000'), 300000);
eq('...and it is held for the client, not income', bal('2100', { deal: dealId() }), 50000);

openDeal();
save('invoice', {
  date: '2026-10-06', deal: dealId(), from: 'buyer', amt: 40000,
  gst: 'no', tds: 0, adv: 0, recv: '1010', method: 'cash',
});
eq('Brokerage paid in cash on the spot lands in the cash box', bal('1010'), 40000);
eq('...income is still counted in full', bal('4010'), 40000);
eq('...and no receivable is created', bal('1100', { deal: dealId() }), 0);
check('...the invoice is paid from the first second', lastInv().status === 'paid', lastInv().status);
check('...and carries no due date', !lastInv().dueDate, String(lastInv().dueDate));

openDeal();
save('invoice', {
  date: '2026-10-06', deal: dealId(), from: 'buyer', amt: 40000,
  gst: 'no', tds: 0, adv: 0, recv: '1000', method: 'upi',
});
eq('The same invoice settled by UPI lands in the bank', bal('1000'), 340000);
const bankLine = getState().txns.at(-1).lines.find(l => l.acc === '1000' && l.dr);
check('...and the line remembers it was UPI, for the statement match', bankLine.method === 'upi', JSON.stringify(bankLine.method));

// Entries saved before the cash box was an option stored recv:'now'. They have to keep
// meaning "into the bank" or every invoice already in the books would move.
openDeal();
save('invoice', { date: '2026-10-06', deal: dealId(), from: 'buyer', amt: 40000, gst: 'no', tds: 0, adv: 0, recv: 'now' });
eq('recv:"now" from older entries still means the bank', bal('1000'), 340000);
eq('...and never the cash box', bal('1010'), 0);

// ═══════ 2. A CANCELLED DEAL IS STILL REACHABLE ═══════

section('A cancelled deal keeps every action — it has money moving, not a tombstone');

openDeal();
cancel();
const offers = key => (fieldsFor(key, {}).find(f => f.k === 'deal')?.opts || []).map(o => o[0]);
for (const key of ['invoice', 'token', 'dealcost', 'dealfee']) {
  check(`"${EV[key].title}" still offers the cancelled deal`, offers(key).includes(dealId()), JSON.stringify(offers(key)));
}
const label = (fieldsFor('invoice', {}).find(f => f.k === 'deal').opts.find(o => o[0] === dealId()) || [])[1];
check('...marked so nobody bills one by accident', /cancelled/.test(label), label);

openDeal();
save('dealcost', { date: '2026-09-20', deal: dealId(), what: 'EC extract', amt: 5000, gst: 'no', bear: 'self', how: '1010' });
cancel();
save('dealcost', { date: '2026-11-22', deal: dealId(), what: 'Lawyer opinion', amt: 3000, gst: 'no', bear: 'self', how: '1010' });
eq('A bill incurred before the deal died can still be paid, from the cash box', bal('5045', { deal: dealId() }), 8000);
balanced('...and the books still balance');

// ═══════ 3. A FLAT FEE STANDS ON ITS OWN ═══════

section('A fee that is not a percentage brokerage — and needs no token to exist');

// The case that was impossible: the deal dies, a fee is due, no token was ever paid.
openDeal();
cancel();
refuses('Forfeiting a token that was never paid is still refused', () =>
  save('settle', { date: '2026-11-20', deal: dealId(), from: 'buyer', keep: 25000 }), 'held');
save('dealfee', {
  date: '2026-11-20', deal: dealId(), from: 'buyer', kind: 'cancel',
  amt: 25000, gst: 'no', tds: 0, adv: 0, recv: 'later',
});
eq('...but the fee itself bills cleanly, with no token in sight', bal('4030'), 25000);
eq('...and the client owes it', bal('1100', { party: buyer(), deal: dealId() }), 25000);
check('...on a numbered invoice like any other', /^3PIN\//.test(lastInv().invoiceNo || ''), lastInv().invoiceNo);
check('...tagged as a fee, not as brokerage', lastInv().kind === 'fee' && lastInv().feeKind === 'cancel', `${lastInv().kind}/${lastInv().feeKind}`);
check('...and the deal stays cancelled', getState().deals[0].status === 'cancelled');
balanced('...books balance');

// A token that only partly covers the fee: the rest stays held, to refund.
openDeal();
save('token', { date: '2026-09-10', deal: dealId(), from: 'buyer', amt: 50000, via: '1000' });
cancel();
save('dealfee', {
  date: '2026-11-20', deal: dealId(), from: 'buyer', kind: 'cancel',
  amt: 25000, gst: 'no', tds: 0, adv: 25000, recv: 'later',
});
eq('A held token pays the fee down', bal('4030'), 25000);
eq('...the client owes nothing', bal('1100', { party: buyer(), deal: dealId() }), 0);
eq('...and the untouched half is still held for them', bal('2100', { deal: dealId() }), 25000);
check('...so the fee invoice reads paid', lastInv().status === 'paid', lastInv().status);
save('settle', { date: '2026-11-21', deal: dealId(), from: 'buyer', refund: 25000, via: '1000' });
eq('...and refunding the rest clears the deal of held money', bal('2100', { deal: dealId() }), 0);
balanced('...books balance');

refuses('A token cannot pay more of the fee than is actually held', () => {
  openDeal();
  save('token', { date: '2026-09-10', deal: dealId(), from: 'buyer', amt: 10000, via: '1000' });
  cancel();
  save('dealfee', { date: '2026-11-20', deal: dealId(), from: 'buyer', kind: 'cancel', amt: 25000, gst: 'no', adv: 25000, recv: 'later' });
}, 'held');

// ═══════ 4. EACH FEE TYPE POSTS WHERE IT BELONGS ═══════

section('A retainer is not brokerage, and a cancellation fee is neither');

openDeal();
save('dealfee', {
  date: '2026-09-09', deal: dealId(), from: 'buyer', kind: 'retainer',
  amt: 15000, gst: 'yes', gstRate: 18, gstAmt: 2700, total: 17700, tds: 0, adv: 0, recv: '1000', method: 'upi',
});
eq('Advisory work is consultancy income', bal('4020'), 15000);
eq('...never brokerage', bal('4010') + bal('4000'), 0);
eq('...and its GST is collected for the government', bal('2200') + bal('2201'), 2700);
eq('...with the money in the bank', bal('1000'), 300000 + 17700);
balanced('...books balance');

openDeal();
save('dealfee', {
  date: '2026-10-06', deal: dealId(), from: 'buyer', kind: 'flat',
  amt: 60000, gst: 'no', tds: 0, adv: 0, recv: 'later',
});
eq('A flat brokerage from the buyer is buyer-side brokerage', bal('4010'), 60000);
eq('...not the cancellation head', bal('4030'), 0);

openDeal();
save('dealfee', {
  date: '2026-10-06', deal: dealId(), from: 'seller', kind: 'flat',
  amt: 60000, gst: 'no', tds: 0, adv: 0, recv: 'later',
});
eq('...and from the seller, seller-side', bal('4000'), 60000);

// ═══════ 5. LETTING A CLIENT OFF PART OF A FEE ═══════
//
// The owner's rule: income is what comes in. A discount given is a smaller fee, so it comes
// back off the head the fee was billed to — a waived cancellation fee must not quietly
// reduce brokerage income instead.

section('A discount on a fee comes off the head the fee was billed to');

openDeal();
save('dealfee', { date: '2026-11-20', deal: dealId(), from: 'buyer', kind: 'cancel', amt: 25000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
save('dealpay', { date: '2026-11-25', party: buyer(), amt: 20000, short: 5000, shortWhy: 'discount', via: '1000' });
eq('The 5,000 let off comes off the cancellation head', bal('4030'), 20000);
eq('...and never off brokerage', bal('4010') + bal('4000'), 0);
eq('...the client owes nothing', bal('1100', { party: buyer() }), 0);
check('...and the invoice closes in full', lastInv().status === 'paid', lastInv().status);
balanced('...books balance');

openDeal();
save('dealfee', { date: '2026-09-09', deal: dealId(), from: 'buyer', kind: 'retainer', amt: 15000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
save('dealpay', { date: '2026-09-25', party: buyer(), amt: 14000, short: 1000, shortWhy: 'discount', via: '1010' });
eq('A discount on a retainer comes off consultancy income', bal('4020'), 14000);
eq('...and the money received went into the cash box', bal('1010'), 14000);

// ═══════ 6. THE DOCUMENT CALLS ITSELF WHAT IT IS ═══════
//
// A withdrawal fee is usually compensation rather than a supply, so it carries no GST — and a
// document with no tax on it is not a tax invoice. s.31(3)(c): a registered person supplying
// something exempt or outside GST issues a bill of supply.

section('A document with no tax on it is not called a tax invoice');

const docType = () => invoiceModel({
  invoice: lastInv(),
  deal: getState().deals[0],
  settings: getState().settings,
}).docType;

openDeal({ gstin: '33AAAAB0000A1Z5' });
save('dealfee', { date: '2026-11-20', deal: dealId(), from: 'buyer', kind: 'cancel', amt: 25000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
check('A GST-registered firm billing an untaxed fee issues a bill of supply', docType() === 'BILL OF SUPPLY', docType());

save('dealfee', {
  date: '2026-11-21', deal: dealId(), from: 'seller', kind: 'retainer',
  amt: 15000, gst: 'yes', gstRate: 18, gstAmt: 2700, total: 17700, tds: 0, adv: 0, recv: 'later',
});
check('...and a taxed one is still a tax invoice', docType() === 'TAX INVOICE', docType());

openDeal({ gstin: '' });
save('dealfee', { date: '2026-11-20', deal: dealId(), from: 'buyer', kind: 'cancel', amt: 25000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
check('A firm with no GSTIN issues neither — just an invoice', docType() === 'INVOICE', docType());

// ═══════ 7. THE WHOLE CYCLE, OUT OF ORDER ═══════
//
// What the owner actually described: money in and out at any point, invoiced whenever the
// fee falls due, the deal dying halfway, and a flat fee closing it — in cash and in bank.

section('One deal, recorded in the order life happened rather than the order a pipeline expects');

openDeal();
save('token', { date: '2026-09-10', deal: dealId(), from: 'buyer', amt: 30000, via: '1010' });
save('dealcost', { date: '2026-09-14', deal: dealId(), what: 'EC extract', amt: 4000, gst: 'no', bear: 'self', how: '1010' });
// Invoiced while the deal is still open, because the agreement says half is due on signing.
save('invoice', { date: '2026-09-20', deal: dealId(), from: 'seller', amt: 40000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
save('dealpay', { date: '2026-09-28', party: seller(), amt: 40000, via: '1000' });
// Then the buyer walks.
cancel();
save('dealfee', { date: '2026-10-05', deal: dealId(), from: 'buyer', kind: 'cancel', amt: 20000, gst: 'no', tds: 0, adv: 20000, recv: 'later' });
save('settle', { date: '2026-10-06', deal: dealId(), from: 'buyer', refund: 10000, via: '1010' });

eq('Seller-side brokerage was earned and collected', bal('4000'), 40000);
eq('The buyer-side cancellation fee was earned too', bal('4030'), 20000);
eq('The deal carried its own cost', bal('5045', { deal: dealId() }), 4000);
eq('Nothing is still held for anybody', bal('2100', { deal: dealId() }), 0);
eq('Nobody still owes anything', bal('1100', { deal: dealId() }), 0);
eq('The cash box holds what it should: 30,000 in, 4,000 out, 10,000 refunded', bal('1010'), 16000);
eq('The bank holds the capital plus the seller payment', bal('1000'), 340000);
balanced('And the whole story balances');

report();
