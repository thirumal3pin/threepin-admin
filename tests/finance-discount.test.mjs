// ═══════ A DISCOUNT ON A VENDOR BILL ═══════
//
// The rent was 18,000. The landlord took 17,500 and let the 500 go. Two ways to record it and
// one required result: the bill closes, the bank shows 17,500 out and nothing more, the 500
// is a discount received — income, not a cost reduction, because the GST claimed on the bill
// stands — and nothing is still showing as owed.
//
//   node tests/finance-discount.test.mjs

import { getState, bal, billOutstanding, moneyMoved } from '../finance-assets/finance-core.js';
import { fresh, save, check, eq, section, report, party } from './_harness.mjs';

const landlord = () => party('K. Raman (landlord)');

section('Given at the moment of paying — one entry');
{
  fresh({ booksStartDate: '2026-09-01' });
  save('funding', { date: '2026-09-01', kind: '3000', who: 'Owner', amt: 100000 });
  save('bill', { date: '2026-09-05', vendor: { __new: true, name: 'K. Raman (landlord)', type: 'vendor' }, desc: 'Office rent — Sept', acc: '5000', amt: 18000, rcm: 'no' });
  eq('The bill is owed in full', bal('2000', { party: landlord() }), 18000);

  const id = save('paybill', { date: '2026-09-10', party: landlord(), amt: 17500, short: 500, via: '1000' });
  const t = getState().txns.find(x => x.id === id);
  eq('Bank went down by what was actually paid', bal('1000'), 100000 - 17500);
  eq('Nothing is still owed', bal('2000', { party: landlord() }), 0);
  eq('The 500 is a discount received, not a cost reduction', bal('4060'), 500);
  eq('Rent stays at the billed 18,000', bal('5000'), 18000);
  eq('Money out on the entry is 17,500 — the discount never left the bank', moneyMoved(t).out, 17500);
  const b = getState().bills[0];
  check('The bill is closed', b.status === 'paid' && billOutstanding(b) < 0.01, JSON.stringify([b.status, billOutstanding(b)]));
  check('The entry says what happened', /discount/i.test(t.desc), t.desc);
}

section('Given later — the remainder was still showing as owed');
{
  fresh({ booksStartDate: '2026-09-01' });
  save('funding', { date: '2026-09-01', kind: '3000', who: 'Owner', amt: 100000 });
  save('bill', { date: '2026-09-05', vendor: { __new: true, name: 'K. Raman (landlord)', type: 'vendor' }, desc: 'Office rent — Sept', acc: '5000', amt: 18000, rcm: 'no' });
  save('paybill', { date: '2026-09-10', party: landlord(), amt: 17500, via: '1000' });
  const b = getState().bills[0];
  check('After the part-payment the bill is part-paid with 500 open', b.status === 'part' && Math.abs(billOutstanding(b) - 500) < 0.01, JSON.stringify([b.status, billOutstanding(b)]));
  eq('…and the ledger still shows 500 owed', bal('2000', { party: landlord() }), 500);

  const id = save('billdiscount', { date: '2026-09-17', party: landlord(), bill: b.id, amt: 500 });
  const t = getState().txns.find(x => x.id === id);
  eq('Nothing is owed any more', bal('2000', { party: landlord() }), 0);
  eq('The 500 is a discount received', bal('4060'), 500);
  eq('The bank did not move', bal('1000'), 100000 - 17500);
  check('The discount entry moves no money at all', moneyMoved(t).in === 0 && moneyMoved(t).out === 0);
  check('The bill is now closed', b.status === 'paid' && billOutstanding(b) < 0.01, JSON.stringify([b.status, billOutstanding(b)]));
  check('Payable → Discounts received, 500 each side',
    t.lines.some(l => l.acc === '2000' && l.dr === 500) && t.lines.some(l => l.acc === '4060' && l.cr === 500), JSON.stringify(t.lines));
}

section('Guards');
{
  fresh({ booksStartDate: '2026-09-01' });
  save('funding', { date: '2026-09-01', kind: '3000', who: 'Owner', amt: 100000 });
  save('bill', { date: '2026-09-05', vendor: { __new: true, name: 'K. Raman (landlord)', type: 'vendor' }, desc: 'Office rent — Sept', acc: '5000', amt: 18000, rcm: 'no' });
  save('paybill', { date: '2026-09-10', party: landlord(), amt: 17500, via: '1000' });
  const b = getState().bills[0];
  let refused = false;
  try { save('billdiscount', { date: '2026-09-17', party: landlord(), bill: b.id, amt: 900 }); } catch (e) { refused = /only .* left/i.test(e.message); }
  check('A discount larger than what is left is refused', refused);
  eq('…and nothing changed', bal('2000', { party: landlord() }), 500);
}

report();
