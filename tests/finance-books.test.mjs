// ═══════ TWO INDEPENDENT RECORDS, NOT ONE BOOK WITH A FILTER ═══════
//
// The owner runs the cash box as a completely separate record and the two must never merge:
// "whenever I filter, even accrual, invoice, actual should be categorised correctly."
//
// The old switch filtered ENTRIES by whether they touched 1010. An invoice raised unpaid
// touches neither account, so it fell into the bank book while the cash that settled it fell
// into the cash book — the same deal in two records at once. What the owner saw:
//
//   without the box -> income with nobody having paid, and the client still owed the lot
//   only the box    -> a NEGATIVE receivable of the same amount, and a negative bank
//
// Now an entry that moved no money takes the book of the DOCUMENT it belongs to, so an
// invoice and its settlement can never be separated. Three things must hold, and this file
// exists to keep them holding:
//
//   1. each book is whole and balances on its own;
//   2. the two books add back up to everything;
//   3. nothing straddles, except a transfer between them — which is in both, bridged.
//
//   node tests/finance-books.test.mjs

import {
  getState, bal, scoped, cashPosition, pl, bookOf, inScope, BRIDGE,
} from '../finance-assets/finance-core.js';
import { fresh, save, check, eq, section, report, party } from './_harness.mjs';

const CLIENT = n => ({ __new: true, name: n, type: 'client' });
const VENDOR = { __new: true, name: 'Balaji & Co', type: 'vendor' };
const deal = i => getState().deals[i].id;

// One firm, both records live, with the exact shape that used to break: a deal invoiced
// "not yet paid" and later collected in CASH, alongside one collected in the BANK.
function books() {
  fresh({ booksStartDate: '2026-09-01', tdsEnabled: false });
  save('funding', { date: '2026-09-01', kind: '3000', who: 'Owner', amt: 300000 });
  save('transfer', { date: '2026-09-02', kind: '1000>1010', amt: 20000 });

  save('newdeal', { date: '2026-09-05', nickname: 'Bank deal', buyer: CLIENT('Karthik'), expBuyer: 200000 });
  save('invoice', { date: '2026-09-20', deal: deal(0), from: 'buyer', amt: 200000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  save('dealpay', { date: '2026-09-28', party: party('Karthik'), amt: 200000, via: '1000' });

  save('newdeal', { date: '2026-09-06', nickname: 'Cash deal', buyer: CLIENT('Meena'), expBuyer: 100000 });
  save('invoice', { date: '2026-09-21', deal: deal(1), from: 'buyer', amt: 100000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  save('dealpay', { date: '2026-09-29', party: party('Meena'), amt: 100000, via: '1010' });

  save('expense', { date: '2026-09-30', desc: 'Auto fares', acc: '5050', amt: 4200, gst: 'no', via: '1010' });
}

const of = (m, fn) => scoped(fn, m);
const income = m => of(m, () => pl('2026-09')).ti;
const spend = m => of(m, () => pl('2026-09')).te;
const pos = m => of(m, () => cashPosition());
const txnNamed = s => getState().txns.find(t => String(t.desc).includes(s));

// ═══════ 1. AN INVOICE AND ITS MONEY ARE NEVER IN DIFFERENT BOOKS ═══════

section('An unpaid invoice belongs to the record its money eventually came through');

books();
check('An invoice settled in cash is a cash-book entry, though it moved no money itself',
  bookOf(txnNamed('Brokerage — Cash deal')) === 'cash', bookOf(txnNamed('Brokerage — Cash deal')));
check('An invoice settled in the bank is a bank-book entry',
  bookOf(txnNamed('Brokerage — Bank deal')) === 'bank', bookOf(txnNamed('Brokerage — Bank deal')));
check('...and each payment sits in the same book as its invoice',
  bookOf(txnNamed('Payment — Meena')) === 'cash' && bookOf(txnNamed('Payment — Karthik')) === 'bank');
check('A cash spend is a cash-book entry', bookOf(txnNamed('Auto fares')) === 'cash');

eq('The cash book earns only what it collected', income('only'), 100000);
eq('...and carries only what it spent', spend('only'), 4200);
eq('The bank book earns only what IT collected', income('without'), 200000);
eq('...and carries none of the cash costs', spend('without'), 0);

// The two complaints that started this, named so a regression says which came back.
eq('The bank book no longer shows income nobody paid for', income('without'), 200000);
check('The cash book no longer reports a negative receivable', pos('only').receivable > -0.5, String(pos('only').receivable));
check('The bank book no longer reports a negative bank balance', pos('without').bank > 0, String(pos('without').bank));
eq('Nobody owes anything in either book, because both clients paid', pos('only').receivable + pos('without').receivable, 0);

// ═══════ 2. EACH BOOK IS WHOLE ═══════

section('Each record is complete on its own — its own cash, its own profit');

books();
eq('The cash book holds the box and no bank account', pos('only').bank, 0);
eq('...and its box is the box', pos('only').petty, 115800);
eq('The bank book holds the bank and no cash box', pos('without').petty, 0);
eq('...and its bank is the bank', pos('without').bank, 480000);

for (const m of ['with', 'without', 'only']) {
  const { dr, cr } = of(m, () => {
    let dr = 0, cr = 0;
    for (const t of getState().txns) for (const l of t.lines) { dr += +l.dr || 0; cr += +l.cr || 0; }
    return { dr, cr };
  });
  eq(`[${m}] every debit has its credit — the book balances alone`, dr, cr);
}

// ═══════ 3. THE TWO ADD BACK UP TO EVERYTHING ═══════

section('Nothing is lost and nothing is counted twice');

books();
eq('Income: bank + cash = both', income('without') + income('only'), income('with'));
eq('Costs: bank + cash = both', spend('without') + spend('only'), spend('with'));
eq('Profit: bank + cash = both',
  of('without', () => pl('2026-09')).profit + of('only', () => pl('2026-09')).profit,
  of('with', () => pl('2026-09')).profit);
eq('Receivables: bank + cash = both', pos('without').receivable + pos('only').receivable, pos('with').receivable);
eq('Cash: the bank book\'s bank plus the cash book\'s box is all the money',
  pos('without').bank + pos('only').petty, pos('with').bank + pos('with').petty);

// ═══════ 4. MOVING MONEY BETWEEN THE TWO RECORDS ═══════
//
// The one entry that is in both books. Each keeps its own leg and books the other side to the
// bridge, so neither ends up short — and the bridge nets to zero across the two, which is why
// it never appears when both records are shown together.

section('A transfer between the records is in both, and leaves neither short');

books();
const xfer = txnNamed('Transfer');
check('A transfer belongs to both books', bookOf(xfer) === 'both', bookOf(xfer));
check('...so the bank book keeps it', inScope(xfer, 'without'));
check('...and the cash book keeps it too', inScope(xfer, 'only'));
eq('The bank book is down by the 20,000 it sent', pos('without').bank, 480000);
eq('The cash book is up by the 20,000 it received (less the 4,200 spent, plus 100,000 collected)', pos('only').petty, 115800);
eq('The bank book shows the other side on the bridge', of('without', () => bal(BRIDGE)), -20000);
eq('The cash book shows the opposite', of('only', () => bal(BRIDGE)), 20000);
eq('Across both records the bridge nets to nothing', of('with', () => bal(BRIDGE)), 0);
check('...and never appears at all when both are shown',
  !getState().txns.some(t => (t.lines || []).some(l => l.acc === BRIDGE)));

// ═══════ 5. A DOCUMENT CAN SAY WHICH RECORD IT BELONGS TO ═══════
//
// Derivation answers for money that has already moved. An invoice raised today and unpaid has
// nothing to derive from, so the document may carry `book` and that wins — this is what the
// form's "which record is this?" writes.

section('An unpaid invoice can be told which record it belongs to');

books();
save('newdeal', { date: '2026-10-01', nickname: 'Future deal', buyer: CLIENT('Suresh'), expBuyer: 50000 });
save('invoice', { date: '2026-10-02', deal: deal(2), from: 'buyer', amt: 50000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
const inv = getState().invoices.at(-1);
const raised = txnNamed('Brokerage — Future deal');
check('Undeclared and unpaid, it defaults to the bank book', bookOf(raised) === 'bank', bookOf(raised));
eq('...so the bank book expects the income', income('without'), 200000);

inv.book = 'cash';
eq('Marked as a cash-book invoice, the bank book no longer claims it', income('without'), 200000);
check('...and the entry moves across', bookOf(raised) === 'cash', bookOf(raised));
eq('...where the cash book counts it', of('only', () => pl('2026-10')).ti, 50000);
eq('...and the client is owed money in the cash book', of('only', () => bal('1100')), 50000);
eq('...and owed nothing in the bank book', of('without', () => bal('1100')), 0);

report();
