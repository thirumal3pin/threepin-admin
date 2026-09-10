// ═══════ WHEN PART OF A BILL WILL NEVER BE PAID ═══════
//
// The rent was 18,000. The landlord took 17,500 and the 500 was never paid. That gap is not
// always a discount — it can be a waiver, a GST credit note, TDS withheld, or a write-off.
// Whichever it is, it is NOT income: the rent simply cost 17,500 (the owner's rule — income is
// what comes in, and nothing came in), so it comes off the head the bill was booked to. And
// one thing must not be quietly skipped: if input credit was claimed on that bill, the credit
// on the part you never paid has to come back. Rule 37 for a waiver or a write-off; s.34(2)
// for a credit note; nothing at all for TDS, because the supply WAS paid for in full, part of
// it to the government.
//
//   node tests/finance-billclose.test.mjs

import { getState, bal, billOutstanding, moneyMoved, rule37Rows, billTaxBack } from '../finance-assets/finance-core.js';
import { fresh, save, check, eq, section, report, party, refuses } from './_harness.mjs';

const LANDLORD = { __new: true, name: 'K. Raman (landlord)', type: 'vendor' };
const landlord = () => party('K. Raman (landlord)');
const bill = () => getState().bills[0];
const txn = id => getState().txns.find(x => x.id === id);

// 18,000 rent with no GST — the owner's own example.
function plainBill() {
  fresh({ booksStartDate: '2026-09-01', tdsEnabled: true });
  save('funding', { date: '2026-09-01', kind: '3000', who: 'Owner', amt: 100000 });
  save('bill', { date: '2026-09-05', vendor: LANDLORD, desc: 'Office rent — Sept', acc: '5000', amt: 18000, rcm: 'no', tds: 'none', tdsrate: 0 });
}

// The same rent, charged with GST: 18,000 + 18% intra = 1,620 CGST + 1,620 SGST, net 21,240.
function gstBill() {
  fresh({ booksStartDate: '2026-09-01', tdsEnabled: false });
  save('funding', { date: '2026-09-01', kind: '3000', who: 'Owner', amt: 100000 });
  save('bill', {
    date: '2026-09-05', vendor: LANDLORD, desc: 'Office rent — Sept', acc: '5000',
    amt: 18000, rcm: 'charged', gstRate: 18, gstAmt: 3240, total: 21240,
    gstType: 'intra', vgstin: '33AAAAB0000A1Z5', vinv: 'RENT/SEP',
  });
}

section('The plain case — 18,000 billed, 17,500 paid, 500 waived at the same moment');
{
  plainBill();
  const id = save('paybill', { date: '2026-09-10', party: landlord(), amt: 17500, short: 500, shortWhy: 'discount', via: '1000' });
  eq('Bank went down by what was actually paid', bal('1000'), 100000 - 17500);
  eq('Nothing is still owed', bal('2000', { party: landlord() }), 0);
  eq('The rent cost 17,500 — the 500 comes off the rent', bal('5000'), 17500);
  eq('Nothing is booked as income', bal('4060'), 0);
  eq('Money out is 17,500 — the 500 never left the bank', moneyMoved(txn(id)).out, 17500);
  check('The bill is closed', bill().status === 'paid' && billOutstanding(bill()) < 0.01);
  check('The entry says it was a discount', /discount/i.test(txn(id).desc), txn(id).desc);
}

section('The same gap, a week later — the 500 was still showing as owed');
{
  plainBill();
  save('paybill', { date: '2026-09-10', party: landlord(), amt: 17500, via: '1000' });
  check('After the part-payment 500 is open', bill().status === 'part' && Math.abs(billOutstanding(bill()) - 500) < 0.01);
  const id = save('billclose', { date: '2026-09-17', party: landlord(), bill: bill().id, amt: 500, why: 'discount' });
  eq('Nothing is owed any more', bal('2000', { party: landlord() }), 0);
  eq('The rent cost 17,500', bal('5000'), 17500);
  eq('Nothing is booked as income', bal('4060'), 0);
  eq('The bank did not move', bal('1000'), 100000 - 17500);
  check('The entry moves no money at all', moneyMoved(txn(id)).in === 0 && moneyMoved(txn(id)).out === 0);
  check('Payable → Rent, 500 each side',
    txn(id).lines.some(l => l.acc === '2000' && l.dr === 500) && txn(id).lines.some(l => l.acc === '5000' && l.cr === 500), JSON.stringify(txn(id).lines));
}

section('The gap is not always a discount — TDS withheld');
{
  plainBill();
  // 194I on rent: 10% of 18,000 = 1,800 kept back to deposit.
  const id = save('paybill', { date: '2026-09-10', party: landlord(), amt: 16200, short: 1800, shortWhy: 'tds', shortTds: '194I', via: '1000' });
  eq('Only the net left the bank', bal('1000'), 100000 - 16200);
  eq('Nothing is owed to the landlord', bal('2000', { party: landlord() }), 0);
  eq('The 1,800 is owed to the government, not booked as income', bal('2250'), 1800);
  eq('…and nothing landed in discounts received', bal('4060'), 0);
  eq('The rent cost is untouched', bal('5000'), 18000);
  check('The entry says TDS', /TDS/i.test(txn(id).desc), txn(id).desc);
}

section('…and not always income — a GST credit note reduces the cost');
{
  gstBill();
  eq('The bill claimed 1,620 CGST', bal('1400'), 1620);
  eq('…and 1,620 SGST', bal('1401'), 1620);
  save('paybill', { date: '2026-09-10', party: landlord(), amt: 20740, via: '1000' });
  const id = save('billclose', { date: '2026-09-17', party: landlord(), bill: bill().id, amt: 500, why: 'creditnote' });
  const t = txn(id);
  // 500 of a 21,240 bill is 2.3540% — of the 3,240 tax, 76.27, half to each head.
  eq('CGST credit given back proportionately', 1620 - bal('1400'), 38.13, 0.05);
  eq('SGST credit given back proportionately', 1620 - bal('1401'), 38.13, 0.05);
  eq('The rest comes off the rent, not into income', 18000 - bal('5000'), 423.74, 0.05);
  eq('Nothing was treated as income', bal('4060'), 0);
  eq('Nothing is owed any more', bal('2000', { party: landlord() }), 0);
  check('The entry balances to the 500 closed', Math.abs(t.totals.dr - 500) < 0.01 && Math.abs(t.totals.cr - 500) < 0.01, JSON.stringify(t.totals));
  check('It says credit note', /credit note/i.test(t.desc), t.desc);
}

section('A waiver on a GST bill — a smaller rent, and the credit still comes back (Rule 37)');
{
  gstBill();
  save('paybill', { date: '2026-09-10', party: landlord(), amt: 20740, via: '1000' });
  save('billclose', { date: '2026-09-17', party: landlord(), bill: bill().id, amt: 500, why: 'discount' });
  eq('CGST credit given back', 1620 - bal('1400'), 38.13, 0.05);
  eq('SGST credit given back', 1620 - bal('1401'), 38.13, 0.05);
  eq('The value comes off the rent', 18000 - bal('5000'), 423.74, 0.05);
  eq('Nothing is booked as income — a waiver IS a cheaper rent', bal('4060'), 0);
}

section('TDS on a GST bill leaves the credit alone');
{
  gstBill();
  const id = save('paybill', { date: '2026-09-10', party: landlord(), amt: 19440, short: 1800, shortWhy: 'tds', shortTds: '194I', via: '1000' });
  eq('The whole CGST credit stands', bal('1400'), 1620);
  eq('The whole SGST credit stands', bal('1401'), 1620);
  eq('The 1,800 is TDS payable', bal('2250'), 1800);
  check('Nothing was reversed on the entry', !txn(id).lines.some(l => ['1400', '1401', '1402'].includes(l.acc)), JSON.stringify(txn(id).lines));
}

section('The credit given back is read from what was actually taken');
{
  gstBill();
  const back = billTaxBack(bill(), 1);
  check('Both heads, at what the entry posted', back.length === 2 && back.every(x => Math.abs(x.amt - 1620) < 0.01), JSON.stringify(back));
  const half = billTaxBack(bill(), 0.5);
  check('Halving the share halves each head', half.every(x => Math.abs(x.amt - 810) < 0.01), JSON.stringify(half));
}

section('Leaving it open keeps the 180-day watch — closing it settles the credit instead');
{
  gstBill();
  save('paybill', { date: '2026-09-10', party: landlord(), amt: 20740, via: '1000' });
  const stale = rule37Rows('2027-04');
  check('An unpaid remainder past 180 days is flagged for reversal', stale.length === 1 && Math.abs(stale[0].reverse - 76.27) < 0.05, JSON.stringify(stale));
  save('billclose', { date: '2026-09-17', party: landlord(), bill: bill().id, amt: 500, why: 'discount' });
  check('Once closed it is off the watch — because the credit has been given back', rule37Rows('2027-04').length === 0);
}

section('Guards');
{
  plainBill();
  save('paybill', { date: '2026-09-10', party: landlord(), amt: 17500, via: '1000' });
  refuses('Closing more than is left is refused',
    () => save('billclose', { date: '2026-09-17', party: landlord(), bill: bill().id, amt: 900, why: 'discount' }), 'only');
  eq('…and nothing changed', bal('2000', { party: landlord() }), 500);
}

report();
