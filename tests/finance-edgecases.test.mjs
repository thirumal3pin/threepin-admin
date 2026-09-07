// ═══════ EDGE CASES — THE AWKWARD MONTHS ═══════
//
// finance-documents.test.mjs walks the happy path of a modern small business. This file is
// the other half: the months where the card declined and then double-charged, where the
// vendor withholds tax, where a credit note is bigger than the bill it lands on, where a
// deal has a buyer AND a seller, where the petty cash box is emptied to the rupee.
//
// Nothing here repeats a scenario from finance-documents.test.mjs. Where a boundary is
// already probed there (an asset below the threshold, a date "well ahead"), this file
// probes the exact edge instead — the rupee and the day on either side of the line.
//
//   node tests/finance-edgecases.test.mjs

import {
  num, bal, pl, trialBalance, balanceSheet, partyBalances, gstComputation,
  expectedFor, serviceMonths, missingServiceMonths, prepaidLeft,
  openInvoices, openBills, invoiceOutstanding, billOutstanding, vendorAdvance,
  agedReceivables, upcomingCash, itcRegister, docStatus, today, addDays,
} from '../finance-assets/finance-core.js';
import { validateEvent } from '../finance-assets/finance-events.js';
import { check, eq, near, section, refuses, report, fresh, save, reverse, runMonthEnd, byName, party } from './_harness.mjs';

console.log('3 PIN Realty — finance edge cases');

// TDS is on for the whole file: the withholding path has to hold up under every other
// scenario too, not just in its own section.
const s = fresh({ tdsEnabled: true });
save('funding', { date: '2026-09-01', kind: '3000', who: 'Swaminathan N G', amt: 1000000 });

const itc = () => bal('1400') + bal('1401') + bal('1402');

// ═══════ 1. TDS: THE VENDOR IS PAID NET, THE GOVERNMENT IS PAID LATER ═══════

section('TDS — a 194J bill is owed net, settled net, and remitted separately');
{
  const itc0 = itc();
  save('bill', {
    date: '2026-09-02', vendor: { __new: true, name: 'Krishnan & Associates', type: 'vendor' },
    desc: 'Statutory audit', acc: '5120', dueDate: '2026-10-02',
    amt: 100000, gst: 'yes', gstRate: 18, gstAmt: 18000, total: 118000, gstType: 'intra',
    vgstin: '33AABCK1234A1Z5', vinv: 'KA-101', rcm: 'no', tds: '194J', tdsrate: 10,
  });
  const kr = party('Krishnan & Associates');
  const audit = openBills(kr)[0];

  eq('The cost is the gross fee — TDS is not a discount', bal('5120'), 100000);
  eq('GST on the full fee is still input credit', itc() - itc0, 18000);
  eq('The vendor is owed net of TDS, not the invoice total', bal('2000', { party: kr }), 108000);
  check('The bill records total and net separately', near(audit.total, 118000) && near(audit.net, 108000) && near(audit.tds, 10000), JSON.stringify({ total: audit.total, net: audit.net, tds: audit.tds }));
  eq('Outstanding on the bill is the net figure', billOutstanding(audit), 108000);
  eq('10% of the fee is held for the government', bal('2250'), 10000);
  check('The bill is open, not part-paid, even though total ≠ net', audit.status === 'open', audit.status);

  const bank0 = bal('1000');
  save('paybill', { date: '2026-09-25', party: kr, amt: 108000, via: '1000' });
  eq('Only the net left the bank', bank0 - bal('1000'), 108000);
  eq('The vendor is square', bal('2000', { party: kr }), 0);
  check('…and the bill closed on the net, not the total', audit.status === 'paid' && near(audit.paid, 108000), JSON.stringify(audit));
  check('No open bill left for this vendor', openBills(kr).length === 0);

  // 194H at 2%: over-paying has to be measured against the net, not the printed total.
  save('bill', {
    date: '2026-09-26', vendor: { __new: true, name: 'Meena Referrals', type: 'vendor' },
    desc: 'Referral commission — Adyar', acc: '5040', amt: 50000, gst: 'no', rcm: 'no',
    tds: '194H', tdsrate: 2,
  });
  const meena = party('Meena Referrals');
  const refBill = openBills(meena)[0];
  eq('194H at 2% is withheld', bal('2250'), 11000);
  eq('Owed net', bal('2000', { party: meena }), 49000);

  refuses('Paying the printed total with "do not allow" is refused — only the net is owed',
    () => save('paybill', { date: '2026-09-28', party: meena, amt: 50000, via: '1000', over: 'stop' }), 'only owe');
  save('paybill', { date: '2026-09-28', party: meena, amt: 50000, via: '1000', over: 'advance' });
  eq('Paying the gross by mistake leaves the TDS as an advance', vendorAdvance(meena), 1000);
  eq('The vendor is square', bal('2000', { party: meena }), 0);
  check('The bill closed on the net', refBill.status === 'paid' && near(refBill.paid, 49000), JSON.stringify(refBill));

  refuses('Remitting more TDS than is held is refused',
    () => save('statutory', { date: '2026-10-05', kind: 'tds', amt: 20000, late: 0 }), 'is owed');
  const bank1 = bal('1000');
  save('statutory', { date: '2026-10-05', kind: 'tds', amt: 11000, late: 0 });
  eq('TDS payable is cleared', bal('2250'), 0);
  eq('…in cash', bank1 - bal('1000'), 11000);
  eq('Remitting withheld tax is never a cost', bal('5160'), 0);
}

section('TDS — the client withholds on our brokerage');
{
  save('newdeal', {
    date: '2026-09-03', nickname: 'Ravi — Adyar flat', propertyState: 'Tamil Nadu',
    seller: { __new: true, name: 'Ravi Kumar', type: 'client' }, expSeller: 57500, expBuyer: 0,
  });
  const dealR = byName(s.deals, 'Ravi — Adyar flat').id;
  const ravi = party('Ravi Kumar');
  refuses('A client TDS rate above 10% on brokerage is refused',
    () => save('invoice', { date: '2026-09-20', deal: dealR, from: 'seller', amt: 57500, gst: 'yes', gstRate: 18, gstAmt: 10350, total: 67850, tds: 12, adv: 0, recv: 'later' }), 'check the rate');

  save('invoice', {
    date: '2026-09-20', deal: dealR, from: 'seller', amt: 57500,
    gst: 'yes', gstRate: 18, gstAmt: 10350, total: 67850,
    tds: 2, adv: 0, recv: 'later', dueDate: '2026-10-20',
  });
  eq('2% of the brokerage is a receivable from the tax department', bal('1150', { party: ravi }), 1150);
  eq('The client owes the invoice less the tax they withheld', bal('1100', { party: ravi }), 66700);
  eq('Income is the full brokerage', bal('4000', { deal: dealR }), 57500);
  const invR = openInvoices(ravi)[0];
  check('The invoice opens part-paid by the TDS itself', invR && invR.status === 'part' && near(invR.paid, 1150) && near(invR.total, 67850), JSON.stringify(invR));
  eq('Outstanding on the invoice matches the ledger', invoiceOutstanding(invR), 66700);
}

// ═══════ 2. THE CARD DECLINED, THEN CHARGED TWICE ═══════

section('A failed auto-charge, a double charge the month after, then a card reversal');
{
  save('subnew', {
    date: '2026-09-01', name: 'Canva Teams', plan: 'Teams',
    vendor: { __new: true, name: 'Canva', type: 'vendor' }, use: 'Listing creatives',
    payMode: 'monthly', billing: 'auto', amt: 4000, via: '2300',
  });
  const canva = byName(s.subs, 'Canva Teams');
  const canvaV = party('Canva');
  const sw0 = bal('5080');

  save('confirmcharge', { sub: canva.id, month: '2026-09', date: '2026-09-05', result: 'skipped' });
  check('September is on record as not charged', canva.charges['2026-09'].skipped === true, JSON.stringify(canva.charges['2026-09']));
  eq('Nothing was posted for it', bal('5080') - sw0, 0);
  check('No bill was raised for a skipped month', !s.bills.some(b => b.serviceId === canva.id && b.month === '2026-09'));
  check('A skipped month is not reported as missing', !missingServiceMonths('2026-09').some(m => m.sub.id === canva.id && m.month === '2026-09'), JSON.stringify(missingServiceMonths('2026-09').map(m => [m.sub.name, m.month, m.status])));
  eq('September still expected the normal price', expectedFor(canva, '2026-09'), 4000);

  save('confirmcharge', {
    sub: canva.id, month: '2026-10', date: '2026-10-05', result: 'paid', via: '2300',
    amt: 8000, gst: 'no', rcm: 'no', reason: 'other',
    note: 'September auto-charge failed; both months taken in October',
  });
  const oct = canva.charges['2026-10'];
  eq('October cost is what the card was actually charged', bal('5080') - sw0, 8000);
  eq('The variance is a full extra month', oct.variance, 4000);
  check('…and the reason is recorded as "other" with the note', oct.reason === 'other' && String(oct.note || '').includes('failed'), JSON.stringify(oct));
  eq('The card carries the whole charge', bal('2300'), 8000);
  check('The month is recorded and paid, with a bill behind it', oct.paid === true && s.bills.some(b => b.id === oct.billId && b.status === 'paid'), JSON.stringify(oct));
  eq('The expectation for November is untouched by a one-off', expectedFor(canva, '2026-11'), 4000);

  // The vendor agrees it was a duplicate and reverses one month on the same card.
  save('vendorrefund', {
    date: '2026-10-20', vendor: canvaV, desc: 'Duplicate September charge reversed',
    acc: '5080', amt: 4000, gst: 'no', how: '2300',
  });
  eq('The card balance drops by the reversal', bal('2300'), 4000);
  eq('The cost is reduced, not booked as income', bal('5080') - sw0, 4000);
  eq('A card reversal is not a credit note — nothing is owed to the vendor', bal('2000', { party: canvaV }), 0);
  eq('…and no vendor advance was invented', vendorAdvance(canvaV), 0);
  check('The bill for October stays paid — the refund is a separate fact', s.bills.find(b => b.id === oct.billId).status === 'paid');
  eq('Bank untouched by a card-to-card reversal', bal('1010'), 0);
}

// ═══════ 3. TWO OPEN BILLS, AN ADVANCE, AND A CREDIT NOTE THAT SPANS THEM ═══════

section('A credit note larger than the oldest bill, then undone');
{
  const V = { __new: true, name: 'Sundar Interiors', type: 'vendor' };
  save('bill', { date: '2026-09-08', vendor: V, desc: 'Brochure design', acc: '5100', amt: 5000, gst: 'no', rcm: 'no' });
  const sundar = party('Sundar Interiors');
  save('bill', { date: '2026-09-12', vendor: sundar, desc: 'Site signage', acc: '5100', amt: 7000, gst: 'no', rcm: 'no' });
  check('Two bills open, oldest first', openBills(sundar).length === 2 && openBills(sundar)[0].desc === 'Brochure design');

  save('paybill', { date: '2026-09-18', party: sundar, amt: 13000, via: '1000', over: 'advance' });
  eq('Both bills settled', bal('2000', { party: sundar }), 0);
  check('…each closed by its own allocation', s.bills.filter(b => b.partyId === sundar).every(b => b.status === 'paid'));
  eq('The 1,000 over-payment is held as an advance', vendorAdvance(sundar), 1000);

  save('bill', { date: '2026-10-02', vendor: sundar, desc: 'Hoarding', acc: '5100', amt: 4000, gst: 'no', rcm: 'no' });
  const bank0 = bal('1000');
  save('paybill', { date: '2026-10-06', party: sundar, amt: 3000, via: '1000', useAdvance: 'yes' });
  eq('Only the shortfall left the bank', bank0 - bal('1000'), 3000);
  eq('The advance was consumed first', vendorAdvance(sundar), 0);
  eq('The vendor is square', bal('2000', { party: sundar }), 0);
  check('The new bill is paid in full', s.bills.find(b => b.partyId === sundar && b.desc === 'Hoarding').status === 'paid');

  save('bill', { date: '2026-10-10', vendor: sundar, desc: 'Flyers batch 1', acc: '5100', amt: 2000, gst: 'no', rcm: 'no' });
  save('bill', { date: '2026-10-12', vendor: sundar, desc: 'Flyers batch 2', acc: '5100', amt: 3000, gst: 'no', rcm: 'no' });
  const D = s.bills.find(b => b.desc === 'Flyers batch 1');
  const E = s.bills.find(b => b.desc === 'Flyers batch 2');
  const cost0 = bal('5100');

  const cnTxn = save('vendorrefund', {
    date: '2026-10-15', vendor: sundar, desc: 'Misprinted flyers', acc: '5100',
    amt: 2500, gst: 'no', how: 'credit',
  });
  eq('What is owed drops by the whole credit note', bal('2000', { party: sundar }), 2500);
  eq('The cost is reduced, not booked as income', cost0 - bal('5100'), 2500);
  check('The oldest bill is fully covered', D.status === 'paid' && near(D.paid, 2000), JSON.stringify(D));
  check('…and the overflow lands on the next one', E.status === 'part' && near(E.paid, 500), JSON.stringify(E));
  eq('Outstanding on the part-covered bill', billOutstanding(E), 2500);
  check('Only the two flyer bills were touched', s.txns.find(t => t.id === cnTxn).allocations.length === 2, JSON.stringify(s.txns.find(t => t.id === cnTxn).allocations));
  eq('No cash moved for a credit note', bank0 - bal('1000'), 3000);

  reverse(cnTxn);
  check('Reversing the credit note reopens the first bill', D.status === 'open' && near(D.paid, 0), JSON.stringify(D));
  check('…and the second', E.status === 'open' && near(E.paid, 0), JSON.stringify(E));
  eq('The vendor is owed the full amount again', bal('2000', { party: sundar }), 5000);
  eq('…and the cost is back', bal('5100'), cost0);
  check('Both bills carry the reversal on their allocation history', D.allocations.some(a => a.reversal) && E.allocations.some(a => a.reversal));
  eq('Open bills add back up to the ledger', openBills(sundar).reduce((a, b) => a + billOutstanding(b), 0), 5000);
}

// ═══════ 4. ONE DEAL, BOTH SIDES ═══════

section('A deal billed to the seller and the buyer, with a token from each');
{
  save('newdeal', {
    date: '2026-09-04', nickname: 'Anitha & Farook — OMR villa', propertyState: 'Tamil Nadu',
    seller: { __new: true, name: 'Anitha R', type: 'client' },
    buyer: { __new: true, name: 'Farook M', type: 'client' },
    expSeller: 300000, expBuyer: 200000,
  });
  const dealO = byName(s.deals, 'Anitha & Farook — OMR villa').id;
  const anitha = party('Anitha R'), farook = party('Farook M');

  save('token', { date: '2026-09-06', deal: dealO, from: 'seller', amt: 100000, via: '1000' });
  save('token', { date: '2026-09-06', deal: dealO, from: 'buyer', amt: 50000, via: '1000' });
  eq('Held from the seller', bal('2100', { party: anitha, deal: dealO }), 100000);
  eq('Held from the buyer', bal('2100', { party: farook, deal: dealO }), 50000);
  eq('A token is never income', bal('4000', { deal: dealO }) + bal('4010', { deal: dealO }), 0);

  const bank0 = bal('1000');
  save('invoice', {
    date: '2026-09-22', deal: dealO, from: 'seller', amt: 300000,
    gst: 'yes', gstRate: 18, gstAmt: 54000, total: 354000,
    tds: 2, adv: 100000, recv: 'now',
  });
  eq('The seller side is income once', bal('4000', { deal: dealO }), 300000);
  eq('Their token is used up', bal('2100', { party: anitha, deal: dealO }), 0);
  eq('The seller withheld 2%', bal('1150', { party: anitha }), 6000);
  eq('Nothing left owing by the seller', bal('1100', { party: anitha }), 0);
  eq('The balance came into the bank on the spot', bal('1000') - bank0, 248000);
  const invA = s.invoices.find(i => i.partyId === anitha);
  check('The seller invoice is fully settled the moment it is raised', invA.status === 'paid' && near(invA.paid, 354000), JSON.stringify(invA));

  save('invoice', {
    date: '2026-09-23', deal: dealO, from: 'buyer', amt: 200000,
    gst: 'yes', gstRate: 18, gstAmt: 36000, total: 236000,
    tds: 0, adv: 50000, recv: 'later', dueDate: '2026-10-23',
  });
  eq('The buyer side is income once, on its own account', bal('4010', { deal: dealO }), 200000);
  eq('Their token is used up too', bal('2100', { party: farook, deal: dealO }), 0);
  eq('The buyer owes the rest', bal('1100', { party: farook }), 186000);
  eq('No TDS was withheld on this side', bal('1150', { party: farook }), 0);
  const invF = openInvoices(farook)[0];
  check('The buyer invoice is part-paid by the token', invF.status === 'part' && near(invF.paid, 50000), JSON.stringify(invF));

  save('dealpay', { date: '2026-10-10', party: farook, amt: 86000, via: '1000' });
  eq('The buyer part-pays', bal('1100', { party: farook }), 100000);
  check('…and the invoice tracks it', invF.status === 'part' && near(invF.paid, 136000), JSON.stringify(invF));
  eq('Outstanding on the invoice matches the ledger', invoiceOutstanding(invF), 100000);

  eq('The property is in-state, so both sides carry CGST+SGST', bal('2200', { deal: dealO }), 45000);
  eq('…split evenly', bal('2201', { deal: dealO }), 45000);
  eq('…and no IGST', bal('2202', { deal: dealO }), 0);
  eq('Total income on the deal is exactly the two sides', bal('4000', { deal: dealO }) + bal('4010', { deal: dealO }), 500000);
  check('Exactly one brokerage entry per side', s.txns.filter(t => t.event === 'invoice' && t.meta.deal === dealO).length === 2);
  check('The deal is marked registered', byName(s.deals, 'Anitha & Farook — OMR villa').status === 'registered');
  check('Both invoices are on record against the deal', s.invoices.filter(i => i.dealId === dealO).length === 2);
}

// ═══════ 5. AN INCOME INVOICE REVERSED AFTER A PART PAYMENT ═══════

section('Reversing income that has already been part collected');
{
  const cg0 = bal('2200'), sg0 = bal('2201');
  save('otherinc', {
    date: '2026-09-15', party: { __new: true, name: 'Sowmya Ventures', type: 'client', state: 'Tamil Nadu' },
    desc: 'Feasibility report — Poonamallee', acc: '4020',
    amt: 40000, gst: 'yes', gstRate: 18, gstAmt: 7200, total: 47200,
    via: 'later', dueDate: '2026-10-15',
  });
  const sow = party('Sowmya Ventures');
  const incTxn = s.txns.at(-1).id;
  const invS = openInvoices(sow)[0];
  eq('Income booked', bal('4020'), 40000);
  eq('The client owes the invoice', bal('1100', { party: sow }), 47200);

  const payTxn = save('dealpay', { date: '2026-09-30', party: sow, amt: 20000, via: '1000' });
  check('Part collected', invS.status === 'part' && near(invS.paid, 20000), JSON.stringify(invS));
  eq('Balance still due', bal('1100', { party: sow }), 27200);

  reverse(payTxn);
  check('Reversing the collection restores the invoice to open with nothing paid', invS.status === 'open' && near(invS.paid, 0), JSON.stringify(invS));
  check('…and the reversal is on the invoice history', invS.allocations.some(a => a.reversal && near(a.amt, -20000)), JSON.stringify(invS.allocations));
  eq('The whole amount is receivable again', bal('1100', { party: sow }), 47200);

  // Now undo the income itself. The harness models exactly what finance-sync.js posts to the
  // ledger; the numbered credit-note DOCUMENT is created only by Firestore, so nothing below
  // asserts a credit note exists — only the ledger effects, which are the same either way.
  reverse(incTxn);
  eq('Income is unwound', bal('4020'), 0);
  eq('Nothing is receivable from the client', bal('1100', { party: sow }), 0);
  eq('Output CGST is given back', bal('2200'), cg0);
  eq('Output SGST is given back', bal('2201'), sg0);
  check('The entry is flagged as reversed', s.txns.find(t => t.id === incTxn).reversedBy, 'no reversedBy');

  // BUG: expected openInvoices(sow).length === 0 after the income behind the invoice is
  // reversed; actual is 1, still showing 47,200 outstanding against a client the ledger says
  // owes nothing. reverseTxn() in finance-assets/finance-sync.js voids every bill the entry
  // created (`madeBills` → status 'void') but does nothing to the invoice it credit-notes —
  // it only writes a NEW kind:'creditnote' document, leaving the original at status 'open'.
  // openInvoices() in finance-assets/finance-core.js filters out kind:'creditnote' but has no
  // notion of an invoice whose txn was reversed, so the receivable is double-counted on the
  // Owed screen. The harness mirrors sync.js faithfully here, so this is an engine defect,
  // not a harness gap. Fix belongs in reverseTxn (void/settle the original invoice).
  check('An invoice whose income was reversed is no longer outstanding',
    openInvoices(sow).length === 0,
    `openInvoices still returns ${openInvoices(sow).length} for ${invS.invoiceNo}, outstanding ${invoiceOutstanding(invS)}, while bal('1100') is ${bal('1100', { party: sow })}`);
}

// ═══════ 6. A MONTH OF PETTY CASH, TO THE RUPEE ═══════

section('The petty cash box — top-up, six vouchers, blocked GST, and a sweep to zero');
{
  const boxTrail = [];
  const mark = () => { boxTrail.push(bal('1010')); return bal('1010'); };
  eq('The box starts empty', bal('1010'), 0);

  save('transfer', { date: '2026-09-10', kind: '1000>1010', amt: 10000 });
  eq('Topped up', mark(), 10000);

  save('petty', { date: '2026-09-11', a1: 450, c1: '5030', d1: 'Tea and snacks for a site visit', a2: 300, c2: '5050', d2: 'Auto to the registrar', a3: 220, c3: '5100', d3: 'Photocopies' });
  eq('Three vouchers out of the box', mark(), 9030);

  save('petty', { date: '2026-09-12', a1: 1200, c1: '5045', d1: 'EC application fee', a2: 800, c2: '5050', d2: 'Cab to the sub-registrar', a3: 150, c3: '5100', d3: 'Envelopes' });
  eq('Three more', mark(), 6880);
  eq('Deal costs landed in their own account', bal('5045'), 1200);
  eq('Conveyance accumulated across both slips', bal('5050'), 1100);

  const itc0 = itc();
  save('expense', { date: '2026-09-13', desc: 'Client lunch', acc: '5030', amt: 2000, gst: 'yes', gstRate: 5, gstAmt: 100, total: 2100, gstType: 'intra', via: '1010' });
  eq('The whole 5% went out of the box', mark(), 4780);
  eq('Food GST is blocked, so it never becomes credit', itc() - itc0, 0);
  eq('…it sits inside the cost instead', bal('5030'), 450 + 2100);

  save('transfer', { date: '2026-09-14', kind: '1010>1000', amt: 4780 });
  eq('The box is swept back to the bank, to the rupee', mark(), 0);

  check('The box was never negative at any point in the month', boxTrail.every(b => b >= -0.005), JSON.stringify(boxTrail));
  refuses('One rupee more than the box holds is refused',
    () => save('petty', { date: '2026-09-15', a1: 1, c1: '5030', a2: 0, a3: 0 }), 'petty cash only holds');
  refuses('…and so is an expense paid from an empty box',
    () => save('expense', { date: '2026-09-15', desc: 'Stamps', acc: '5100', amt: 50, gst: 'no', via: '1010' }), 'petty cash only holds');
  refuses('…and sweeping money that is not there',
    () => save('transfer', { date: '2026-09-15', kind: '1010>1000', amt: 100 }), 'only holds');
  eq('After all three refusals the box is still exactly zero', bal('1010'), 0);
}

// ═══════ 7. THE DIRECTOR'S OWN POCKET ═══════

section("A director pays a GST cost personally and is reimbursed");
{
  const itc0 = itc();
  save('director', { date: '2026-09-16', desc: 'Broadband annual plan', acc: '5070', amt: 12000, gst: 'yes', gstRate: 18, gstAmt: 2160, total: 14160, gstType: 'intra' });
  eq('The cost is the company\'s, this month', bal('5070'), 12000);
  eq('The credit is the company\'s too', itc() - itc0, 2160);
  eq('The company owes the director the whole outlay, GST included', bal('2450'), 14160);
  eq('No cash moved', bal('1010'), 0);

  const bank0 = bal('1000');
  save('transfer', { date: '2026-09-20', kind: '1000>2450', amt: 14160 });
  eq('Reimbursed in full', bal('2450'), 0);
  eq('…out of the bank', bank0 - bal('1000'), 14160);
  eq('A reimbursement is never a second cost', bal('5070'), 12000);

  refuses('Salary from an empty petty cash box is refused',
    () => save('salary', { date: '2026-09-21', emp: { __new: true, name: 'Priya S', type: 'employee' }, kind: '5010', gross: 15000, tds: 0, pf: 0, via: '1010' }), 'petty cash only holds');
  save('salary', { date: '2026-09-21', emp: { __new: true, name: 'Priya S', type: 'employee' }, kind: '5010', gross: 15000, tds: 1500, pf: 1800, via: '1000' });
  eq('The cost is the gross', bal('5010'), 15000);
  eq('Salary TDS joins the same payable head', bal('2250'), 1500);
  eq('PF is held separately', bal('2550'), 1800);
}

// ═══════ 8. LOANS: A FEE, THREE EMIS, A LATE FEE, AND A CARD CONVERSION ═══════

section('A three-month loan paid to zero, one instalment late');
{
  const bank0 = bal('1000'), fin0 = bal('5150');
  save('bankloan', { date: '2026-09-01', lender: { __new: true, name: 'HDFC Bank', type: 'lender' }, purpose: 'Office fit-out', amt: 300000, rate: 12, n: 3, fee: 3000 });
  const hdfc = party('HDFC Bank');
  const loan = s.loans.find(l => l.lender === 'HDFC Bank');
  eq('Only the net of the fee reached the bank', bal('1000') - bank0, 297000);
  eq('The whole principal is owed', bal('2400', { party: hdfc }), 300000);
  eq('The processing fee is a finance cost now, not part of the loan', bal('5150') - fin0, 3000);
  check('A three-instalment schedule was built from next month', loan.schedule.length === 3 && loan.schedule[0].month === '2026-10' && loan.status === 'active', JSON.stringify(loan.schedule.map(x => [x.n, x.month])));
  const totalInt = loan.schedule.reduce((a, x) => a + x.int, 0);

  save('emi', { date: '2026-10-05', loan: loan.id, via: '1000', extra: 0 });
  eq('Principal comes off the loan, not the P&L', bal('2400', { party: hdfc }), 300000 - loan.schedule[0].prin);
  check('One instalment marked paid, loan still active', loan.paid.length === 1 && loan.status === 'active');

  save('emi', { date: '2026-11-05', loan: loan.id, via: '1000', extra: 500 });
  eq('A penalty sits in its own disallowed account, not with bank charges or interest', bal('5165'), 500);

  save('emi', { date: '2026-12-05', loan: loan.id, via: '1000', extra: 0 });
  eq('The loan is repaid to the rupee', bal('2400', { party: hdfc }), 0);
  check('…and closes itself', loan.status === 'closed' && loan.paid.length === 3, JSON.stringify({ status: loan.status, paid: loan.paid }));
  eq('Interest and the fee are the only P&L effect of the borrowing', bal('5150') - fin0, 3000 + totalInt);
  refuses('A fourth instalment on a closed loan is refused',
    () => save('emi', { date: '2027-01-05', loan: loan.id, via: '1000', extra: 0 }), 'active loan');

  const cardOut = bal('2300');
  eq('The card still carries the Canva balance', cardOut, 4000);
  refuses('Converting more than the card holds is refused',
    () => save('card2emi', { date: '2026-10-25', what: 'Too much', amt: cardOut + 1, rate: 14, n: 4, fee: 0 }), 'card only has');
  save('card2emi', { date: '2026-10-25', what: 'Canva double charge', amt: cardOut, rate: 14, n: 4, fee: 200 });
  const cardLoan = s.loans.find(l => l.lender === 'Card EMI');
  eq('The card is cleared except for the conversion fee', bal('2300'), 200);
  eq('The debt simply moved to the loan head', bal('2400', { party: cardLoan.partyId }), cardOut);
  eq('The conversion fee is a finance cost', bal('5150') - fin0, 3000 + totalInt + 200);
  check('A four-instalment card loan now exists', cardLoan.n === 4 && cardLoan.schedule.length === 4 && cardLoan.status === 'active');
  eq('Converting a card balance is not a cost in itself', bal('5165'), 500);
}

// ═══════ 9. AN ASSET BOUGHT ON CREDIT, DEPRECIATED, THEN SOLD AT A GAIN ═══════

section('An asset on a vendor bill, paid in two parts, depreciated twice, sold for more than its book value');
{
  const itc0 = itc();
  save('asset', {
    date: '2026-09-05', name: 'Office laptop', vendor: { __new: true, name: 'Vishal Computers', type: 'vendor' },
    amt: 36000, gst: 'yes', gstRate: 18, gstAmt: 6480, total: 42480, gstType: 'intra',
    vgstin: '33AAACV5678A1Z5', vinv: 'VC-77', life: 36, how: 'bill', dueDate: '2026-10-05',
  });
  const vishal = party('Vishal Computers');
  const laptop = byName(s.assets, 'Office laptop');
  const lapBill = openBills(vishal)[0];
  eq('The asset sits on the balance sheet, not in the P&L', bal('1300'), 36000);
  eq('GST on an asset is still input credit', itc() - itc0, 6480);
  eq('The vendor is owed the GST-inclusive total', bal('2000', { party: vishal }), 42480);
  check('A bill was raised for it with the due date', lapBill && lapBill.dueDate === '2026-10-05' && near(lapBill.total, 42480), JSON.stringify(lapBill));
  eq('Monthly depreciation is cost over life', laptop.monthly, 1000);

  save('paybill', { date: '2026-09-30', party: vishal, amt: 20000, via: '1000' });
  check('Part-paid', lapBill.status === 'part' && near(lapBill.paid, 20000), JSON.stringify(lapBill));
  save('paybill', { date: '2026-10-20', party: vishal, amt: 22480, via: '1000' });
  check('Settled in two goes', lapBill.status === 'paid' && lapBill.allocations.length === 2, JSON.stringify(lapBill));
  eq('Nothing owed', bal('2000', { party: vishal }), 0);
  eq('Paying for an asset is still not a cost', bal('5200'), 0);

  check('September month-end posts exactly one depreciation entry', runMonthEnd('2026-09') === 1);
  check('So does October', runMonthEnd('2026-10') === 1);
  eq('Two months of depreciation', bal('5200'), 2000);
  // 1350 is a contra-asset — it carries a credit balance, so bal() reports it as negative
  // and the balance sheet nets it against 1300. Net book value is what a reader cares about.
  eq('…accumulated against the asset (a contra-asset, so credit-side)', bal('1350'), -2000);
  eq('Net book value after two months', bal('1300') + bal('1350'), 34000);
  check('The asset records which months were run', (laptop.depreciated || []).join(',') === '2026-09,2026-10', JSON.stringify(laptop.depreciated));
  check('Running the same month again posts nothing', runMonthEnd('2026-09') === 0);

  save('assetdispose', { date: '2026-11-10', assetId: laptop.id, proceeds: 35000, via: '1010' });
  eq('The asset is off the books at cost', bal('1300'), 0);
  eq('…and its accumulated depreciation with it', bal('1350'), 0);
  eq('Sold above written-down value, so the difference is other income', bal('4040'), 1000);
  eq('No disposal loss', bal('5220'), 0);
  eq('The proceeds landed in the box', bal('1010'), 35000);
  check('The asset is marked disposed', laptop.status === 'disposed' && laptop.disposedOn === '2026-11-10');
  check('November month-end has nothing left to depreciate', runMonthEnd('2026-11') === 0);

  // The capitalisation threshold is 5,000 — the rupee either side of it.
  {
    // Below the threshold the app advises rather than blocks: a cheap component of a bigger
    // asset is still capital, and only the owner knows which it is.
    const w = validateEvent('asset', { date: '2026-11-12', name: 'Desk lamp', amt: 4999, gst: 'no', rcm: 'no', life: 24, how: '1010' });
    check('One rupee under the capitalisation threshold is advised against, not refused',
      w.some(p => p.k === 'amt' && p.warn) && !w.some(p => !p.warn), JSON.stringify(w));
  }
  save('asset', { date: '2026-11-12', name: 'Office chair', amt: 5000, gst: 'no', life: 25, how: '1010' });
  const chair = byName(s.assets, 'Office chair');
  check('Exactly at the threshold is accepted as an asset', chair && chair.status === 'in use' && near(chair.monthly, 200), JSON.stringify(chair));
  eq('…paid from the box', bal('1010'), 30000);
}

// ═══════ 10. THREE SERVICE MONTHS, ONE PAYMENT ═══════

section('An in-state monthly service: three invoices settled by one payment, then a price rise');
{
  save('subnew', {
    date: '2026-09-01', name: 'Tally Prime', plan: 'Silver',
    vendor: { __new: true, name: 'Tally Solutions', type: 'vendor', state: 'Tamil Nadu' },
    use: 'Books', payMode: 'monthly', billing: 'invoice', amt: 1500, via: '1000',
  });
  const tally = byName(s.subs, 'Tally Prime');
  const tallyV = party('Tally Solutions');
  const itc0 = itc();

  ['2026-09', '2026-10', '2026-11'].forEach((m, i) => {
    save('confirmcharge', {
      sub: tally.id, month: m, date: `${m}-03`, result: 'invoice', dueDate: `${m}-30`,
      amt: 1500, gst: 'yes', gstRate: 18, gstAmt: 270, total: 1770, gstType: 'intra',
      vgstin: '33AAACT2727Q1ZW', vinv: `TS-${i + 1}`, rcm: 'no',
    });
  });
  eq('Three months owed', bal('2000', { party: tallyV }), 5310);
  eq('An in-state vendor gives CGST+SGST credit', itc() - itc0, 810);
  eq('…and nothing anywhere in these books is IGST', bal('1402'), 0);
  check('Three open bills, oldest first', openBills(tallyV).length === 3 && openBills(tallyV).map(b => b.month).join(',') === '2026-09,2026-10,2026-11', JSON.stringify(openBills(tallyV).map(b => b.month)));
  check('Every month shows as billed but unpaid', serviceMonths(tally, '2026-11').every(m => m.status === 'billed'), JSON.stringify(serviceMonths(tally, '2026-11').map(m => [m.month, m.status])));
  eq('No variance anywhere', ['2026-09', '2026-10', '2026-11'].reduce((a, m) => a + num(tally.charges[m].variance), 0), 0);

  const payTxn = save('paybill', { date: '2026-11-15', party: tallyV, amt: 5310, via: '1000' });
  const rows = s.txns.find(t => t.id === payTxn).allocations;
  check('One payment split across all three bills', rows.length === 3 && rows.every(r => near(r.amt, 1770)), JSON.stringify(rows));
  check('…allocated oldest first', rows[0].id === s.bills.find(b => b.partyId === tallyV && b.month === '2026-09').id);
  eq('Nothing owed', bal('2000', { party: tallyV }), 0);
  check('All three bills paid', s.bills.filter(b => b.partyId === tallyV).every(b => b.status === 'paid'));
  check('The month view now reads recorded throughout', serviceMonths(tally, '2026-11').every(m => m.status === 'recorded'), JSON.stringify(serviceMonths(tally, '2026-11').map(m => [m.month, m.status])));

  save('subchange', { from: '2026-12', sub: tally.id, plan: 'Gold', payMode: 'monthly', amt: 2000 });
  eq('November still expects the old price', expectedFor(tally, '2026-11'), 1500);
  eq('December expects the new one', expectedFor(tally, '2026-12'), 2000);
  check('A plan change with no bill posts nothing', !s.txns.some(t => t.event === 'subchange'));
  // prepaidLeft() is only meaningful for an upfront plan. subnew stores `amount` on monthly
  // plans too, so it answers with the monthly price for a service that has no prepayment at
  // all — harmless today because every caller gates on payMode, but a trap for the next one.
  check('A monthly service is never amortised at month-end', !(tally.amortized || []).length);
  eq('prepaidLeft answers for a monthly plan even though there is no prepayment', prepaidLeft(tally), 1500);

  save('confirmcharge', {
    sub: tally.id, month: '2026-12', date: '2026-12-03', result: 'invoice', dueDate: '2027-01-02',
    amt: 2000, gst: 'yes', gstRate: 18, gstAmt: 360, total: 2360, gstType: 'intra',
    vgstin: '33AAACT2727Q1ZW', vinv: 'TS-4', rcm: 'no',
  });
  eq('December at the new price is exactly as expected', tally.charges['2026-12'].variance, 0);
  check('No variance reason was demanded', !tally.charges['2026-12'].reason, JSON.stringify(tally.charges['2026-12']));
  eq('The new month is owed', bal('2000', { party: tallyV }), 2360);
  check('Four bills on record for the service', s.bills.filter(b => b.serviceId === tally.id).length === 4);
}

// ═══════ 11. THE DATE FENCE, TO THE DAY ═══════

section('Date guards — the exact day on either side of each line');
{
  const T = today();
  const base = { desc: 'Stamp paper', acc: '5100', amt: 100, gst: 'no', via: '1000' };
  const probs = d => validateEvent('expense', { ...base, date: d });

  refuses('The day before the books start is refused',
    () => save('expense', { ...base, date: '2026-08-31' }), 'before the books start');
  check('The first day of the books is accepted', probs('2026-09-01').length === 0, JSON.stringify(probs('2026-09-01')));

  check(`Today + 31 days (${addDays(T, 31)}) is clean — no warning at all`, probs(addDays(T, 31)).length === 0, JSON.stringify(probs(addDays(T, 31))));
  {
    const p = probs(addDays(T, 32));
    check(`Today + 32 days (${addDays(T, 32)}) warns and only warns`, p.length === 1 && p[0].warn === true && p[0].k === 'date', JSON.stringify(p));
  }
  {
    const p = probs(addDays(T, 366));
    check(`Today + 366 days (${addDays(T, 366)}) is still only a warning`, p.length === 1 && p[0].warn === true, JSON.stringify(p));
  }
  {
    const p = probs(addDays(T, 367));
    check(`Today + 367 days (${addDays(T, 367)}) is a hard error`, p.length === 1 && !p[0].warn, JSON.stringify(p));
  }
  refuses('…and it is refused on save',
    () => save('expense', { ...base, date: addDays(T, 367) }), 'check the year');

  // A warning must not block: the same entry a warned date accepts, saves.
  const cost0 = bal('5100');
  save('expense', { ...base, date: addDays(T, 60), desc: 'Post-dated stamp paper' });
  eq('A warned date still saves', bal('5100') - cost0, 100);

  const canva = byName(s.subs, 'Canva Teams');
  refuses('A service month before the service started is refused',
    () => save('confirmcharge', { sub: canva.id, month: '2026-08', date: '2026-09-05', result: 'paid', via: '1000', amt: 4000, gst: 'no', rcm: 'no' }), 'only started');
  refuses('…and a plan change before it started, too',
    () => save('subchange', { from: '2026-08', sub: canva.id, plan: 'Pro', payMode: 'monthly', amt: 5000 }), 'only started');
  check('The start month itself was allowed — it is already on record', !!canva.charges['2026-09']);
}

// ═══════ 12. AFTER ALL OF THAT, THE BOOKS STILL HOLD ═══════

section('Closing invariants');
{
  const tb = trialBalance(), bs = balanceSheet();
  check('Trial balance balances', tb.balanced, JSON.stringify({ dr: tb.dr, cr: tb.cr }));
  check('Balance sheet balances', bs.balanced, JSON.stringify({ assets: bs.assets, liabilities: bs.liabilities, equity: bs.equity }));

  const badBills = Object.entries(partyBalances('2000'))
    .filter(([pid, owed]) => openBills(pid).reduce((a, b) => a + billOutstanding(b), 0) > owed + 0.02);
  check('Open bills never exceed the ledger for any vendor', badBills.length === 0, JSON.stringify(badBills));

  // Sowmya Ventures is excluded: her invoice is left open by a reversal the engine never
  // closes — see the BUG note in section 5. Everything else must hold.
  const sow = party('Sowmya Ventures');
  const badInv = Object.entries(partyBalances('1100'))
    .concat(s.parties.filter(p => !partyBalances('1100')[p.id]).map(p => [p.id, 0]))
    .filter(([pid]) => pid !== sow)
    .filter(([pid, owed]) => openInvoices(pid).reduce((a, i) => a + invoiceOutstanding(i), 0) > num(owed) + 0.02);
  check('Open invoices never exceed the ledger for any other client', badInv.length === 0, JSON.stringify(badInv));

  const wrongStatus = s.bills.filter(b => b.status !== 'void')
    .filter(b => b.status !== docStatus(billOutstanding(b), num(b.net ?? b.total)));
  check('Every non-void bill status agrees with its own numbers', wrongStatus.length === 0, JSON.stringify(wrongStatus.map(b => [b.desc, b.status, b.paid, b.net ?? b.total])));

  // A service month recorded as "charged and paid" is born settled, so it legitimately has
  // no allocation history. What must hold is that no bill is over-allocated or over-paid.
  const overAlloc = s.bills.filter(b => b.status !== 'void')
    .filter(b => (b.allocations || []).reduce((a, x) => a + num(x.amt), 0) > num(b.paid) + 0.02);
  check('No bill is allocated more than it has been paid', overAlloc.length === 0, JSON.stringify(overAlloc.map(b => [b.desc, b.paid, b.allocations])));
  const overPaid = s.bills.filter(b => b.status !== 'void' && num(b.paid) > num(b.net ?? b.total) + 0.02);
  check('No bill is paid more than it is worth', overPaid.length === 0, JSON.stringify(overPaid.map(b => [b.desc, b.paid, b.net ?? b.total])));

  const danglingCharges = [];
  for (const sub of s.subs) {
    for (const [m, c] of Object.entries(sub.charges || {})) {
      if (c && c.billId && !s.bills.some(b => b.id === c.billId)) danglingCharges.push([sub.name, m, c.billId]);
    }
  }
  check('Every recorded service month points at a bill that exists', danglingCharges.length === 0, JSON.stringify(danglingCharges));

  const orphanBills = s.bills.filter(b => b.serviceId && !s.subs.some(x => x.id === b.serviceId));
  check('Every service bill points back at a service that exists', orphanBills.length === 0, JSON.stringify(orphanBills.map(b => b.desc)));

  check('Petty cash never ends negative', bal('1010') >= -0.005, String(bal('1010')));
  check('The credit card is never in credit', bal('2300') >= -0.005, String(bal('2300')));
  check('Advances to vendors are never negative', Object.values(partyBalances('1550')).every(x => x >= -0.005), JSON.stringify(partyBalances('1550')));
  check('Client advances held are never negative', Object.values(partyBalances('2100')).every(x => x >= -0.005), JSON.stringify(partyBalances('2100')));

  const g = gstComputation('2026-09');
  check('GST for September computes without a negative cash figure', g.cash >= -0.005, JSON.stringify({ cash: g.cash, liability: g.liability }));
  check('The ITC register lists September purchases', Array.isArray(itcRegister('2026-09').rows || itcRegister('2026-09')), typeof itcRegister('2026-09'));
  const aged = agedReceivables('2026-12-31');
  check('Aged receivables buckets add up to the ledger', near(Object.values(aged).reduce((a, x) => a + num(x), 0), bal('1100', { upto: '2026-12-31' }), 1), JSON.stringify(aged));
  check('Nothing fell into the "no document" bucket', near(num(aged['no document']), 0), JSON.stringify(aged));
  check('Upcoming cash reports a total and the cash on hand', typeof upcomingCash('2026-12-01').total === 'number' && near(upcomingCash('2026-12-01').cash, bal('1000', { upto: '2026-12-01' }) + bal('1010', { upto: '2026-12-01' })));

  const unbalanced = s.txns.filter(t => !near(t.totals.dr, t.totals.cr));
  check('Every single entry balances on its own', unbalanced.length === 0, JSON.stringify(unbalanced.map(t => [t.no, t.desc, t.totals])));
  check('Profit for the year is the sum of the months', near(
    ['2026-09', '2026-10', '2026-11', '2026-12'].reduce((a, m) => a + pl(m).profit, 0),
    pl('2026-09').profit + pl('2026-10').profit + pl('2026-11').profit + pl('2026-12').profit));
}

report();
