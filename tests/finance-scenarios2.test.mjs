// ═══════ SCENARIOS II — WHAT CHANGED SINCE THE DOCUMENTS SUITE ═══════
//
// The owner is not an accountant. Every scenario below is phrased the way it happens to him:
// a vendor who lets him off a few hundred, a rent bill accrued at month-end and paid on the
// 5th, an NBFC loan with TDS on the interest, a credit note on an invoice already paid, the
// box running dry. Each runs through the same harness as the app's save(), and every section
// ends with the trial balance still balancing.
//
// Sections: A GST three ways · B short-pays · C recurring by kind · D loans · E credit notes
//           F money views · G petty cash · H TDS · I edge cases
//
//   node tests/finance-scenarios2.test.mjs

import {
  getState, num, bal, pl, trialBalance, balanceSheet, fyOf, ym, mlabel, A,
  movesMoney, moneyMoved, cashBook, pettyActivity, scoped, setScope, scopeMode,
  tdsRegister, tdsFyTotal, regenerateSchedule, recurringAcc,
  openInvoices, openBills, invoiceOutstanding, billOutstanding, vendorAdvance,
  serviceMonths, expectedFor, GST_RCM,
} from '../finance-assets/finance-core.js';
import { validateEvent } from '../finance-assets/finance-events.js';
import { check, eq, near, section, refuses, report, fresh, save, reverse, byName, party } from './_harness.mjs';

console.log('3 PIN Realty — scenarios II');

const S = () => getState();
const lastTxn = () => S().txns.at(-1);
const txnOf = id => S().txns.find(t => t.id === id);
const heads = () => ({ c: bal('1400'), s: bal('1401'), i: bal('1402'), rcm: bal(GST_RCM) });
const delta = (a, b) => ({ c: b.c - a.c, s: b.s - a.s, i: b.i - a.i, rcm: b.rcm - a.rcm });
const OWNER = { __new: true, name: 'Owner', type: 'director' };
const FY = fyOf('2026-09-07', 4);

// A purchase's GST answer, checked against the four heads it can land in.
function gstShape(label, before, after, want) {
  const d = delta(before, after);
  check(`${label}: CGST`, near(d.c, want.c), `got ${d.c}, expected ${want.c}`);
  check(`${label}: SGST`, near(d.s, want.s), `got ${d.s}, expected ${want.s}`);
  check(`${label}: IGST`, near(d.i, want.i), `got ${d.i}, expected ${want.i}`);
  check(`${label}: reverse-charge payable`, near(d.rcm, want.rcm), `got ${d.rcm}, expected ${want.rcm}`);
}

// ═══════ A. GST ON A PURCHASE — THREE ANSWERS, SIX FORMS ═══════

section('A. GST three ways on every purchase form');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 600000 });
  const owner = g.parties.find(p => p.name === 'Owner');
  check('funding.who is a party — created as a director', owner && owner.type === 'director', JSON.stringify(owner));
  check('…and the capital line carries the party', lastTxn().lines.some(l => l.acc === '3000' && l.party === owner.id));

  const CO = { __new: true, name: 'Toner Co', type: 'vendor' };
  const KA = { __new: true, name: 'Bengaluru Prints', type: 'vendor', state: 'Karnataka' };
  const ADV = { __new: true, name: 'Adv. Kumar', type: 'vendor' };
  const US = { __new: true, name: 'Figma Inc', type: 'vendor' };
  const NONE = { c: 0, s: 0, i: 0, rcm: 0 };

  // ── expense
  let b = heads();
  save('expense', { date: '2026-09-02', desc: 'Parking', acc: '5180', amt: 500, rcm: 'no', via: '1000' });
  gstShape('expense · no GST', b, heads(), NONE);
  eq('expense · no GST: whole amount is the cost', bal('5180'), 500);
  b = heads();
  save('expense', { date: '2026-09-02', desc: 'Toner', acc: '5100', amt: 2000, rcm: 'charged', gstRate: 18, gstAmt: 360, total: 2360, gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'T-1', via: '1000', vendor: CO });
  gstShape('expense · charged intra', b, heads(), { c: 180, s: 180, i: 0, rcm: 0 });
  b = heads();
  save('expense', { date: '2026-09-02', desc: 'Brochures', acc: '5100', amt: 4000, rcm: 'charged', gstRate: 18, gstAmt: 720, total: 4720, gstType: 'inter', vgstin: '29AABCB1234A1Z5', vinv: 'BP-1', via: '1000', vendor: KA });
  gstShape('expense · charged inter', b, heads(), { c: 0, s: 0, i: 720, rcm: 0 });
  b = heads();
  const bankB = bal('1000');
  const advTxn = save('expense', { date: '2026-09-03', desc: 'Sale deed opinion', acc: '5120', amt: 10000, rcm: 'yes', rcmRate: 18, rcmType: 'intra', via: '1000', vendor: ADV });
  gstShape('expense · reverse charge intra', b, heads(), { c: 900, s: 900, i: 0, rcm: 1800 });
  eq('expense · reverse charge: the advocate got only the bare fee', bankB - bal('1000'), 10000);
  check('expense · reverse charge: a self-invoice is numbered', txnOf(advTxn).selfInvoiceNo?.startsWith('3PIN/SI/') && txnOf(advTxn).selfInvoice.place === 'intra', JSON.stringify(txnOf(advTxn).selfInvoice));
  b = heads();
  const impTxn = save('expense', { date: '2026-09-03', desc: 'Design tool', acc: '5080', amt: 8400, rcm: 'yes', rcmRate: 18, rcmType: 'import', rcmCcy: 'USD', rcmFx: 84, via: '1000', vendor: US });
  gstShape('expense · reverse charge import', b, heads(), { c: 0, s: 0, i: 1512, rcm: 1512 });
  const si = txnOf(impTxn).selfInvoice;
  check('expense · import: the self-invoice records the currency and the rate (Rule 34)', si && si.currency === 'USD' && si.fxRate === 84 && si.place === 'import', JSON.stringify(si));

  // ── bill
  const toner = party('Toner Co'), ka = party('Bengaluru Prints'), adv = party('Adv. Kumar'), us = party('Figma Inc');
  b = heads();
  save('bill', { date: '2026-09-04', vendor: toner, desc: 'Paper', acc: '5100', amt: 1000, rcm: 'no' });
  gstShape('bill · no GST', b, heads(), NONE);
  eq('bill · no GST: owed is the bare amount', bal('2000', { party: toner }), 1000);
  b = heads();
  save('bill', { date: '2026-09-04', vendor: toner, desc: 'Cartridges', acc: '5100', amt: 3000, rcm: 'charged', gstRate: 18, gstAmt: 540, total: 3540, gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'T-2' });
  gstShape('bill · charged intra', b, heads(), { c: 270, s: 270, i: 0, rcm: 0 });
  eq('bill · charged: owed with its GST', bal('2000', { party: toner }), 1000 + 3540);
  b = heads();
  save('bill', { date: '2026-09-04', vendor: ka, desc: 'Hoardings', acc: '5090', amt: 5000, rcm: 'charged', gstRate: 18, gstAmt: 900, total: 5900, gstType: 'inter', vgstin: '29AABCB1234A1Z5', vinv: 'BP-2' });
  gstShape('bill · charged inter', b, heads(), { c: 0, s: 0, i: 900, rcm: 0 });
  b = heads();
  save('bill', { date: '2026-09-04', vendor: adv, desc: 'Title search', acc: '5120', amt: 6000, rcm: 'yes', rcmRate: 18, rcmType: 'intra' });
  gstShape('bill · reverse charge intra', b, heads(), { c: 540, s: 540, i: 0, rcm: 1080 });
  eq('bill · reverse charge: the vendor is owed only the bare amount', bal('2000', { party: adv }), 6000);
  b = heads();
  save('bill', { date: '2026-09-04', vendor: us, desc: 'Annual seats', acc: '5080', amt: 42000, rcm: 'yes', rcmRate: 18, rcmType: 'import', rcmCcy: 'USD', rcmFx: 84 });
  gstShape('bill · reverse charge import', b, heads(), { c: 0, s: 0, i: 7560, rcm: 7560 });
  check('bill · import: the bill document carries the reverse-charge tax apart from GST', g.bills.at(-1).rcm === 7560 && g.bills.at(-1).gst === 0, JSON.stringify(g.bills.at(-1)));

  // ── dealcost (company bears it)
  save('newdeal', { date: '2026-09-01', nickname: 'GST deal', seller: { __new: true, name: 'Seller G', type: 'client' }, expSeller: 100000 });
  const dG = byName(g.deals, 'GST deal').id;
  b = heads();
  save('dealcost', { date: '2026-09-05', deal: dG, what: 'EC extract', amt: 700, rcm: 'no', bear: 'self', acc: '5045', how: '1000' });
  gstShape('dealcost · no GST', b, heads(), NONE);
  b = heads();
  save('dealcost', { date: '2026-09-05', deal: dG, what: 'Drone shoot', amt: 5000, rcm: 'charged', gstRate: 18, gstAmt: 900, total: 5900, gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'D-1', bear: 'self', acc: '5110', how: '1000' });
  gstShape('dealcost · charged intra', b, heads(), { c: 450, s: 450, i: 0, rcm: 0 });
  b = heads();
  save('dealcost', { date: '2026-09-05', deal: dG, what: 'Listing boost', amt: 2000, rcm: 'charged', gstRate: 18, gstAmt: 360, total: 2360, gstType: 'inter', vgstin: '29AABCB1234A1Z5', vinv: 'D-2', bear: 'self', acc: '5180', how: '1000' });
  gstShape('dealcost · charged inter', b, heads(), { c: 0, s: 0, i: 360, rcm: 0 });
  b = heads();
  save('dealcost', { date: '2026-09-05', deal: dG, what: 'Lawyer opinion', amt: 3000, rcm: 'yes', rcmRate: 18, rcmType: 'intra', bear: 'self', acc: '5120', how: '1000' });
  gstShape('dealcost · reverse charge intra', b, heads(), { c: 270, s: 270, i: 0, rcm: 540 });
  b = heads();
  save('dealcost', { date: '2026-09-05', deal: dG, what: 'Virtual staging', amt: 4200, rcm: 'yes', rcmRate: 18, rcmType: 'import', rcmCcy: 'USD', rcmFx: 84, bear: 'self', acc: '5110', how: '1000' });
  gstShape('dealcost · reverse charge import', b, heads(), { c: 0, s: 0, i: 756, rcm: 756 });
  // A cost the client bears: the GST rides on the recoverable, it is not our credit.
  b = heads();
  save('dealcost', { date: '2026-09-05', deal: dG, what: 'Patta transfer', amt: 1000, rcm: 'charged', gstRate: 18, gstAmt: 180, total: 1180, gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'D-3', bear: 'seller', how: '1000' });
  gstShape('dealcost · charged but recoverable from the client: no credit for us', b, heads(), NONE);
  eq('…the whole 1,180 is recoverable', bal('1100', { party: party('Seller G') }), 1180);

  // ── asset
  b = heads();
  save('asset', { date: '2026-09-06', name: 'Chairs', amt: 12000, rcm: 'no', life: 60, how: '1000' });
  gstShape('asset · no GST', b, heads(), NONE);
  b = heads();
  save('asset', { date: '2026-09-06', name: 'Laptop', vendor: toner, amt: 60000, rcm: 'charged', gstRate: 18, gstAmt: 10800, total: 70800, gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'T-3', life: 36, how: '1000' });
  gstShape('asset · charged intra', b, heads(), { c: 5400, s: 5400, i: 0, rcm: 0 });
  eq('asset · charged: the asset is capitalised at the bare cost', bal('1300'), 12000 + 60000);
  b = heads();
  save('asset', { date: '2026-09-06', name: 'Camera', vendor: ka, amt: 40000, rcm: 'charged', gstRate: 18, gstAmt: 7200, total: 47200, gstType: 'inter', vgstin: '29AABCB1234A1Z5', vinv: 'BP-3', life: 36, how: '1000' });
  gstShape('asset · charged inter', b, heads(), { c: 0, s: 0, i: 7200, rcm: 0 });
  b = heads();
  save('asset', { date: '2026-09-06', name: 'Office fit-out (unregistered contractor)', amt: 30000, rcm: 'yes', rcmRate: 18, rcmType: 'intra', life: 60, how: '1000' });
  gstShape('asset · reverse charge intra', b, heads(), { c: 2700, s: 2700, i: 0, rcm: 5400 });
  b = heads();
  save('asset', { date: '2026-09-06', name: 'Imported plotter', vendor: us, amt: 84000, rcm: 'yes', rcmRate: 18, rcmType: 'import', rcmCcy: 'USD', rcmFx: 84, life: 60, how: '1000' });
  gstShape('asset · reverse charge import', b, heads(), { c: 0, s: 0, i: 15120, rcm: 15120 });

  // ── confirmcharge (one service, five months)
  save('subnew', { date: '2026-09-01', name: 'Design tool', vendor: us, payMode: 'monthly', billing: 'auto', amt: 3000, via: '1000' });
  const dt = byName(g.subs, 'Design tool');
  b = heads();
  save('confirmcharge', { sub: dt.id, month: '2026-09', date: '2026-09-05', result: 'paid', via: '1000', amt: 3000, rcm: 'no' });
  gstShape('confirmcharge · no GST', b, heads(), NONE);
  b = heads();
  save('confirmcharge', { sub: dt.id, month: '2026-10', date: '2026-10-05', result: 'paid', via: '1000', amt: 3000, rcm: 'charged', gstRate: 18, gstAmt: 540, total: 3540, gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'F-10' });
  gstShape('confirmcharge · charged intra', b, heads(), { c: 270, s: 270, i: 0, rcm: 0 });
  b = heads();
  save('confirmcharge', { sub: dt.id, month: '2026-11', date: '2026-11-05', result: 'paid', via: '1000', amt: 3000, rcm: 'charged', gstRate: 18, gstAmt: 540, total: 3540, gstType: 'inter', vgstin: '29AABCB1234A1Z5', vinv: 'F-11' });
  gstShape('confirmcharge · charged inter', b, heads(), { c: 0, s: 0, i: 540, rcm: 0 });
  b = heads();
  save('confirmcharge', { sub: dt.id, month: '2026-12', date: '2026-12-05', result: 'paid', via: '1000', amt: 3000, rcm: 'yes', rcmRate: 18, rcmType: 'intra' });
  gstShape('confirmcharge · reverse charge intra', b, heads(), { c: 270, s: 270, i: 0, rcm: 540 });
  b = heads();
  save('confirmcharge', { sub: dt.id, month: '2027-01', date: '2027-01-05', result: 'paid', via: '1000', amt: 3000, rcm: 'yes', rcmRate: 18, rcmType: 'import', rcmCcy: 'USD', rcmFx: 84 });
  gstShape('confirmcharge · reverse charge import', b, heads(), { c: 0, s: 0, i: 540, rcm: 540 });
  check('confirmcharge · every month made a bill that records its reverse-charge tax', g.bills.filter(x => x.serviceId === dt.id).length === 5 && g.bills.at(-1).rcm === 540);

  // ── vendorrefund (what: cost) — each answer unwinds the heads it used
  b = heads();
  save('vendorrefund', { date: '2026-09-07', vendor: toner, desc: 'Paper returned', what: 'cost', acc: '5100', amt: 200, rcm: 'no', how: '1000' });
  gstShape('vendorrefund · no GST', b, heads(), NONE);
  b = heads();
  save('vendorrefund', { date: '2026-09-07', vendor: toner, desc: 'One cartridge back', what: 'cost', acc: '5100', amt: 1000, rcm: 'charged', gstRate: 18, gstAmt: 180, total: 1180, gstType: 'intra', how: '1000' });
  gstShape('vendorrefund · charged intra gives the credit back', b, heads(), { c: -90, s: -90, i: 0, rcm: 0 });
  b = heads();
  save('vendorrefund', { date: '2026-09-07', vendor: ka, desc: 'Brochures short-supplied', what: 'cost', acc: '5100', amt: 1000, rcm: 'charged', gstRate: 18, gstAmt: 180, total: 1180, gstType: 'inter', how: '1000' });
  gstShape('vendorrefund · charged inter gives IGST back', b, heads(), { c: 0, s: 0, i: -180, rcm: 0 });
  b = heads();
  save('vendorrefund', { date: '2026-09-07', vendor: adv, desc: 'Opinion fee partly refunded', what: 'cost', acc: '5120', amt: 2000, rcm: 'yes', rcmRate: 18, rcmType: 'intra', how: '1000' });
  gstShape('vendorrefund · reverse charge intra unwinds both sides', b, heads(), { c: -180, s: -180, i: 0, rcm: -360 });
  b = heads();
  save('vendorrefund', { date: '2026-09-07', vendor: us, desc: 'Seat refunded', what: 'cost', acc: '5080', amt: 2100, rcm: 'yes', rcmRate: 18, rcmType: 'import', rcmCcy: 'USD', rcmFx: 84, how: '1000' });
  gstShape('vendorrefund · reverse charge import unwinds IGST and the liability', b, heads(), { c: 0, s: 0, i: -378, rcm: -378 });

  // ── the form's answers
  {
    const w = validateEvent('expense', { date: '2026-09-10', desc: 'Stationery', acc: '5100', amt: 100, rcm: 'charged', gst: 'yes', gstRate: 18, gstAmt: 18, total: 118, via: '1000' });
    check('"charged" with no vendor and no GSTIN is accepted with a warning only', w.length > 0 && w.every(p => p.warn), JSON.stringify(w));
    const n = g.txns.length;
    save('expense', { date: '2026-09-10', desc: 'Stationery', acc: '5100', amt: 100, rcm: 'charged', gstRate: 18, gstAmt: 18, total: 118, via: '1000' });
    check('…and the save goes through', g.txns.length === n + 1);
    const w2 = validateEvent('expense', { date: '2026-09-10', desc: 'Stationery', acc: '5100', amt: 100, rcm: 'charged', gst: 'yes', gstRate: 18, gstAmt: 18, total: 118, via: '1000', vendor: toner });
    // BUG: expected at least a warning on vgstin when the vendor is named but the GSTIN is
    // blank on a claimable purchase (the field's own hint says the credit cannot be claimed
    // without it); actual is an empty problem list — nothing warns. EV.expense.check /
    // gstChecks only validate a GSTIN's shape when one is typed.
    check('"charged" with a vendor but no GSTIN still warns — the credit cannot be claimed without it', w2.some(p => p.warn && p.k === 'vgstin'), JSON.stringify(w2));
    const w3 = validateEvent('expense', { date: '2026-09-10', desc: 'x', acc: '5080', amt: 100, rcm: 'yes', gst: 'no', rcmRate: 18, rcmType: 'import', rcmCcy: 'USD', rcmFx: 0, via: '1000' });
    check('An import under reverse charge with no exchange rate warns, not blocks', w3.length === 1 && w3[0].warn && w3[0].k === 'rcmFx', JSON.stringify(w3));
  }
  refuses('Reverse charge at 7% is refused — not a GST rate',
    () => save('expense', { date: '2026-09-10', desc: 'x', acc: '5120', amt: 1000, rcm: 'yes', rcmRate: 7, rcmType: 'intra', via: '1000' }), 'check the rate');
  refuses('…on a bill too', () => save('bill', { date: '2026-09-10', vendor: adv, desc: 'x', acc: '5120', amt: 1000, rcm: 'yes', rcmRate: 7, rcmType: 'intra' }), 'check the rate');
  eq('Nothing under reverse charge is ever owed to a vendor: 2205 equals the RCM tax on record', bal(GST_RCM),
    1800 + 1512 + 1080 + 7560 + 540 + 756 + 5400 + 15120 + 540 + 540 - 360 - 378);
  check('A: trial balance balances', trialBalance().balanced);
}

// ═══════ B. SHORT-PAYS ═══════

section('B. Short-pays — vendor side and client side');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 200000 });
  save('bill', { date: '2026-09-02', vendor: { __new: true, name: 'Two-Bill Vendor', type: 'vendor' }, desc: 'Boards', acc: '5100', amt: 10000, rcm: 'no' });
  const tv = party('Two-Bill Vendor');
  save('bill', { date: '2026-09-03', vendor: tv, desc: 'Flex', acc: '5100', amt: 6000, rcm: 'no' });
  const [b1, b2] = openBills(tv);
  refuses('Let off more than what is left across both bills — refused',
    () => save('paybill', { date: '2026-09-10', party: tv, amt: 15500, short: 501, via: '1000' }), 'let you off');
  const twoBills = save('paybill', { date: '2026-09-10', party: tv, amt: 15500, short: 500, via: '1000' });
  check('Two bills, one payment, a little let off: both close', b1.status === 'paid' && b2.status === 'paid', JSON.stringify([b1.status, b2.status]));
  check('Oldest closes fully first…', near(b1.paid, 10000) && txnOf(twoBills).allocations[0].id === b1.id && near(txnOf(twoBills).allocations[0].amt, 10000));
  check('…the newer one absorbs the let-off (its allocation is still the full 6,000)', near(b2.paid, 6000) && txnOf(twoBills).allocations.length === 2, JSON.stringify(txnOf(twoBills).allocations));
  eq('Only 15,500 left the bank', bal('1000'), 200000 - 15500);
  eq('The 500 is discounts received', bal('4060'), 500);
  eq('Nothing owed', bal('2000', { party: tv }), 0);

  // The vendor holds an advance; the next bill is settled with cash + advance + a let-off.
  save('bill', { date: '2026-09-11', vendor: tv, desc: 'Stickers', acc: '5100', amt: 4000, rcm: 'no' });
  save('paybill', { date: '2026-09-12', party: tv, amt: 5000, via: '1000', over: 'advance' });
  eq('An advance of 1,000 sits with the vendor', vendorAdvance(tv), 1000);
  save('bill', { date: '2026-09-15', vendor: tv, desc: 'Vinyl', acc: '5100', amt: 5000, rcm: 'no' });
  const vinyl = openBills(tv)[0];
  const bankB = bal('1000');
  save('paybill', { date: '2026-09-16', party: tv, amt: 3800, short: 200, via: '1000', useAdvance: 'yes' });
  check('Cash + advance + let-off close the bill', vinyl.status === 'paid' && near(vinyl.paid, 5000), JSON.stringify(vinyl));
  eq('The advance is used up', vendorAdvance(tv), 0);
  eq('Only 3,800 cash', bankB - bal('1000'), 3800);
  eq('Discounts received now 700', bal('4060'), 700);

  // The vendor waives a whole small bill: nothing moves, the bill still closes.
  save('bill', { date: '2026-09-17', vendor: tv, desc: 'Sample', acc: '5100', amt: 300, rcm: 'no' });
  const sample = openBills(tv)[0];
  const waived = save('paybill', { date: '2026-09-18', party: tv, amt: 0, short: 300, via: '1000' });
  check('A fully waived bill closes with no money moving', sample.status === 'paid' && !movesMoney(txnOf(waived)), JSON.stringify(sample));
  eq('…and the waiver is income', bal('4060'), 1000);

  // Over-pay AND let off is contradictory: refused on both sides.
  save('bill', { date: '2026-09-19', vendor: tv, desc: 'Poster', acc: '5100', amt: 2000, rcm: 'no' });
  refuses('Paying a vendor more than owed while also being "let off" is refused',
    () => save('paybill', { date: '2026-09-20', party: tv, amt: 2500, short: 100, via: '1000', over: 'advance' }), 'let you off');
  save('newdeal', { date: '2026-09-03', nickname: 'Short deal', seller: { __new: true, name: 'Client S', type: 'client' }, expSeller: 60000 });
  const dS = byName(g.deals, 'Short deal').id;
  save('invoice', { date: '2026-09-05', deal: dS, from: 'seller', amt: 10000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  const cs = party('Client S');
  refuses('A client who over-pays and is "let off" at the same time is refused',
    () => save('dealpay', { date: '2026-09-12', party: cs, amt: 10500, short: 300, via: '1000', over: 'hold' }), 'let them off');
  // Two invoices, one receipt, bank charges taken on their side.
  save('invoice', { date: '2026-09-06', deal: dS, from: 'seller', amt: 5000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  const [i1, i2] = openInvoices(cs);
  save('dealpay', { date: '2026-09-13', party: cs, amt: 14700, short: 300, shortWhy: 'charges', via: '1000' });
  check('Both invoices close', i1.status === 'paid' && i2.status === 'paid');
  eq('Their bank\'s charges are bank charges', bal('5140'), 300);
  eq('…not a discount', bal('5225'), 0);
  eq('Nothing owed by the client', bal('1100', { party: cs }), 0);
  check('B: trial balance balances', trialBalance().balanced);
}

// ═══════ C. RECURRING BY KIND ═══════

section('C. Recurring costs by kind — rent, utility, salary, and a vendor named late');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 300000 });

  // Rent: accrued at month-end, paid on the 5th.
  save('subnew', { date: '2026-09-01', kind: 'rent', name: 'Office rent — Anna Nagar', vendor: { __new: true, name: 'Landlord', type: 'vendor' }, payMode: 'monthly', billing: 'invoice', amt: 25000, via: '1000' });
  const rent = byName(g.subs, 'Office rent — Anna Nagar');
  const landlord = party('Landlord');
  check('A rent line posts to Rent, not Software', rent.kind === 'rent' && rent.acc === '5000' && recurringAcc(rent) === '5000', JSON.stringify([rent.kind, rent.acc]));
  save('confirmcharge', { sub: rent.id, month: '2026-09', date: '2026-09-30', result: 'invoice', amt: 25000, rcm: 'no', dueDate: '2026-10-05' });
  eq('September carries the rent cost in 5000', num(pl('2026-09').exp['5000']), 25000);
  eq('…nothing in 5080', num(pl('2026-09').exp['5080']), 0);
  eq('…and the landlord is owed', bal('2000', { party: landlord }), 25000);
  const rentBill = g.bills.find(x => x.serviceId === rent.id);
  // BUG: expected accrued === true on a month put on Owed with no vendor bill number; actual
  // the bill has no `accrued` property at all. EV.confirmcharge.build passes accrued: !v.vinv
  // to billDoc(), but billDoc() in finance-events.js copies a fixed list of fields into data
  // and drops it — the flag never reaches the document.
  check('The bill is an accrual (no vendor bill number) with the due date', rentBill.accrued === true && rentBill.status === 'open' && rentBill.dueDate === '2026-10-05', JSON.stringify(rentBill));
  check('The month record points at it and says not paid', rent.charges['2026-09'].billId === rentBill.id && rent.charges['2026-09'].paid === false);
  save('paybill', { date: '2026-10-05', party: landlord, amt: 25000, via: '1000', method: 'netbanking' });
  eq('October carries no rent cost — it was September\'s', num(pl('2026-10').exp['5000']), 0);
  eq('The landlord is cleared in October', bal('2000', { party: landlord }), 0);
  check('The accrued bill is paid by allocation', rentBill.status === 'paid' && rentBill.allocations.length === 1);
  eq('Rent counted once across the two months', num(pl('2026-09').exp['5000']) + num(pl('2026-10').exp['5000']), 25000);
  check('The service grid shows September recorded', serviceMonths(rent, '2026-09').find(m => m.month === '2026-09').status === 'recorded', JSON.stringify(serviceMonths(rent, '2026-09')));

  // Utility: auto-charged, lands in Internet & phone.
  save('subnew', { date: '2026-09-01', kind: 'utility', name: 'Airtel', vendor: { __new: true, name: 'Airtel', type: 'vendor' }, payMode: 'monthly', billing: 'auto', amt: 1500, via: '1000' });
  const airtel = byName(g.subs, 'Airtel');
  check('A utility line posts to 5070', airtel.acc === '5070');
  save('confirmcharge', { sub: airtel.id, month: '2026-09', date: '2026-09-08', result: 'paid', via: '1000', amt: 1500, rcm: 'no' });
  eq('The month lands in Internet & phone', bal('5070'), 1500);
  eq('…and nowhere else', bal('5080'), 0);

  // Salary: the recurring line is a reminder; the month is recorded through the salary form.
  save('subnew', { date: '2026-09-01', kind: 'salary', name: 'Priya — retainer', vendor: { __new: true, name: 'Priya', type: 'employee' }, payMode: 'monthly', billing: 'auto', amt: 30000, via: '1000' });
  const priyaSub = byName(g.subs, 'Priya — retainer');
  const priya = party('Priya');
  check('A salary line posts to 5010', priyaSub.acc === '5010');
  save('salary', { date: '2026-09-30', emp: priya, kind: '5010', month: '2026-09', gross: 30000, pf: 0, via: '1000', sub: priyaSub.id });
  eq('The salary is a cost in 5010', bal('5010'), 30000);
  const sep = priyaSub.charges?.['2026-09'];
  check('The recurring line is marked recorded for the month, via salary', sep && sep.viaSalary === true && sep.paid === true && near(sep.actual, 30000) && near(sep.variance, 0), JSON.stringify(sep));
  check('…and the grid agrees', serviceMonths(priyaSub, '2026-09').find(m => m.month === '2026-09').status === 'recorded', JSON.stringify(serviceMonths(priyaSub, '2026-09')));
  refuses('Recording the same month again through the recurring form is refused',
    () => save('confirmcharge', { sub: priyaSub.id, month: '2026-09', date: '2026-09-30', result: 'paid', via: '1000', amt: 30000, rcm: 'no' }), 'already recorded');
  check('The salary entry names the recurring line and the month', lastTxn().meta.sub === priyaSub.id && lastTxn().meta.month === '2026-09');
  refuses('A recurring cost cannot be added without naming who is paid', () => save('subnew', { date: '2026-09-01', kind: 'service', name: 'Nameless', payMode: 'monthly', billing: 'invoice', amt: 100, via: '1000' }), 'vendor');

  // A commitment recorded before vendors were records: the month form asks once, then remembers.
  g.subs.push({
    id: 'SLEGACY', kind: 'service', acc: '5080', name: 'Legacy CRM', plan: '', vendor: '', vendorId: null, use: '',
    payMode: 'monthly', billing: 'invoice', amount: 2000, monthly: 2000, via: '1000', start: '2026-09', end: null, months: 1,
    history: [{ from: '2026-09', amount: 2000, plan: '' }], amortized: [], charges: {}, status: 'active', hasTxns: false,
  });
  const legacy = g.subs.find(x => x.id === 'SLEGACY');
  refuses('A month put on Owed needs someone to owe it to',
    () => save('confirmcharge', { sub: legacy.id, month: '2026-09', date: '2026-09-03', result: 'invoice', amt: 2000, rcm: 'no' }), 'name who you pay');
  save('confirmcharge', { sub: legacy.id, month: '2026-09', date: '2026-09-03', result: 'invoice', amt: 2000, rcm: 'no', vendor: { __new: true, name: 'Legacy Vendor Co', type: 'vendor' } });
  const lv = party('Legacy Vendor Co');
  check('The vendor named on the month form is stored back on the commitment', legacy.vendorId === lv && legacy.vendor === 'Legacy Vendor Co', JSON.stringify([legacy.vendorId, legacy.vendor]));
  eq('…and the month is owed to them', bal('2000', { party: lv }), 2000);
  check('The bill names them too', g.bills.at(-1).partyId === lv && g.bills.at(-1).serviceId === legacy.id);
  save('confirmcharge', { sub: legacy.id, month: '2026-10', date: '2026-10-03', result: 'invoice', amt: 2000, rcm: 'no' });
  eq('The next month needs no vendor — it is remembered', bal('2000', { party: lv }), 4000);
  check('C: trial balance balances', trialBalance().balanced);
}

// ═══════ D. LOANS ═══════

section('D. An NBFC loan — fee with GST, a five-part EMI with 194A, a prepayment, a closure');
{
  const g = fresh({ tdsEnabled: true });
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 100000 });
  save('bankloan', { date: '2026-09-01', lender: { __new: true, name: 'Bajaj Finance', type: 'lender' }, purpose: 'Working capital', amt: 500000, rate: 12, n: 24, fee: 5000, feeGst: 900, kind: 'nbfc' });
  const loan = g.loans.find(l => l.lender === 'Bajaj Finance');
  const lender = loan.partyId;
  eq('The bank received the loan net of the fee and its GST', bal('1000'), 100000 + 500000 - 5000 - 900);
  eq('The whole principal is owed', bal('2400', { party: lender }), 500000);
  eq('The fee is a finance cost', bal('5150'), 5000);
  eq('The GST on the fee is input credit, split CGST/SGST', bal('1400') + bal('1401'), 900);
  eq('…half and half', bal('1400'), 450);
  check('24 instalments, starting next month, and the lender is flagged NBFC', loan.schedule.length === 24 && loan.start === '2026-10' && loan.lenderKind === 'nbfc', JSON.stringify([loan.schedule.length, loan.start, loan.lenderKind]));
  eq('The schedule returns exactly the principal', loan.schedule.reduce((a, x) => a + x.prin, 0), 500000);

  // EMI 1: principal and interest from the schedule, charges, a late penalty, TDS on the interest.
  const i1 = loan.schedule[0];
  const tds1 = Math.round(i1.int * 0.10);
  const bankB = bal('1000');
  const emi1 = save('emi', { date: '2026-10-05', loan: loan.id, charges: 100, extra: 500, prepay: 0, tds: tds1, via: '1000', method: 'netbanking' });
  const t1 = txnOf(emi1);
  eq('Principal per the schedule came off the loan', bal('2400', { party: lender }), 500000 - i1.prin);
  eq('Interest is a finance cost', bal('5150'), 5000 + i1.int);
  eq('The lender\'s charges are bank & card charges', bal('5140'), 100);
  eq('The penalty is kept apart (disallowed)', bal('5165'), 500);
  eq('TDS on the interest is withheld', bal('2250'), tds1);
  eq('Cash out is the five parts less the TDS', bankB - bal('1000'), i1.prin + i1.int + 100 + 500 - tds1);
  check('The bank line remembers how it moved', t1.lines.find(l => l.acc === '1000').method === 'netbanking' && t1.meta.method === 'netbanking');
  check('Instalment 1 is marked paid', loan.paid.length === 1 && loan.paid[0] === 1 && loan.status === 'active');
  refuses('TDS cannot exceed the interest', () => save('emi', { date: '2026-11-05', loan: loan.id, charges: 0, extra: 0, prepay: 0, tds: 99999, via: '1000' }), 'exceed');
  refuses('Paying ahead more than is owed is refused', () => save('emi', { date: '2026-11-05', loan: loan.id, charges: 0, extra: 0, prepay: 999999, tds: 0, via: '1000' }), 'still owed');

  // EMI 2 with a prepayment: the rest of the schedule is rebuilt on the lower balance.
  const i2 = loan.schedule[1];
  const intBefore = loan.schedule.filter(x => x.n > 2).reduce((a, x) => a + x.int, 0);
  const lastMonthBefore = loan.schedule.at(-1).month;
  const tds2 = Math.round(i2.int * 0.10);
  save('emi', { date: '2026-11-05', loan: loan.id, charges: 0, extra: 0, prepay: 100000, tds: tds2, via: '1000' });
  const after = bal('2400', { party: lender });
  eq('Balance after: previous balance less this principal less the prepayment', after, 500000 - i1.prin - i2.prin - 100000);
  eq('The prepayment is recorded on the loan', loan.prepaid, 100000);
  const remaining = loan.schedule.filter(x => x.n > 2);
  check('Instalments 1–2 are kept as they were, the rest rebuilt', loan.schedule.length === 24 && !loan.schedule[0].rebuilt && !loan.schedule[1].rebuilt && remaining.every(x => x.rebuilt), JSON.stringify(loan.schedule.slice(0, 4)));
  eq('The rebuilt principal adds up to the new balance', remaining.reduce((a, x) => a + x.prin, 0), after, 1);
  check('Interest still to come is lower than before', remaining.reduce((a, x) => a + x.int, 0) < intBefore - 1000, `${remaining.reduce((a, x) => a + x.int, 0)} vs ${intBefore}`);
  check('Same end date, same count', loan.schedule.at(-1).month === lastMonthBefore && remaining.length === 22);
  check('The instalment fell', remaining[0].emi < i2.emi);
  const direct = regenerateSchedule(loan, after, loan.paid);
  check('regenerateSchedule is what the EMI used', direct.length === 24 && near(direct[2].prin, loan.schedule[2].prin) && near(direct[2].int, loan.schedule[2].int));
  check('The next EMI picks up the rebuilt figures', (() => { const nxt = loan.schedule.find(x => !loan.paid.includes(x.n)); return nxt.n === 3 && nxt.rebuilt === true; })());
  eq('194A withheld across both EMIs', bal('2250'), tds1 + tds2);
  const reg = tdsRegister(FY);
  // BUG: expected the two EMI deductions under withheld['194A']; actual they file under a
  // section named after the rupee amount (e.g. withheld['982']). tdsRegister in
  // finance-core.js does `m.tds && m.tds !== 'none' ? m.tds : (... 'emi' ? '194A' ...)`, but on
  // an emi (and a salary) entry meta.tds is the AMOUNT withheld, not a section, so the
  // fallback to 194A/192 is never reached.
  eq('The TDS register files the EMI deductions under 194A', (reg.withheld['194A'] || []).reduce((a, r) => a + r.amt, 0), tds1 + tds2);
  save('statutory', { date: '2026-11-07', kind: 'tds', amt: tds1, tdsMonth: '2026-10', tdsSection: '194A', challan: 'CH-194A-1', bsr: '0012345', interest: 0, late: 0 });
  const dep = tdsRegister(FY).deposited['194A'];
  check('…and the deposit against it, with challan and BSR', dep && dep.length === 1 && near(dep[0].amt, tds1) && dep[0].challan === 'CH-194A-1' && dep[0].bsr === '0012345' && dep[0].month === '2026-10', JSON.stringify(dep));

  // A small loan closes when its balance hits zero.
  save('bankloan', { date: '2026-09-02', lender: { __new: true, name: 'Quick Loan Co', type: 'lender' }, purpose: 'Laptop', amt: 20000, rate: 12, n: 3, fee: 0, kind: 'bank' });
  const small = g.loans.find(l => l.lender === 'Quick Loan Co');
  const q1 = small.schedule[0];
  save('emi', { date: '2026-10-06', loan: small.id, charges: 0, extra: 0, prepay: 20000 - q1.prin, tds: 0, via: '1000' });
  check('Balance zero closes the loan', small.status === 'closed' && near(bal('2400', { party: small.partyId }), 0), JSON.stringify([small.status, bal('2400', { party: small.partyId })]));
  check('…and the schedule is not rebuilt for a closed loan', !small.schedule.some(x => x.rebuilt));
  refuses('A closed loan takes no more EMIs', () => save('emi', { date: '2026-11-06', loan: small.id, charges: 0, extra: 0, prepay: 0, tds: 0, via: '1000' }), 'active loan');
  check('D: trial balance balances', trialBalance().balanced);
}

// ═══════ E. CREDIT NOTES ═══════

section('E. Credit notes — partial, on a paid invoice, the s.34 window, and reversal guards');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 200000 });
  save('newdeal', { date: '2026-09-01', nickname: 'CN deal', seller: { __new: true, name: 'Client A', type: 'client' }, expSeller: 100000 });
  const dA = byName(g.deals, 'CN deal').id;
  const invTxnA = save('invoice', { date: '2026-09-05', deal: dA, from: 'seller', amt: 100000, gst: 'yes', gstRate: 18, gstAmt: 18000, total: 118000, tds: 0, adv: 0, recv: 'later', dueDate: '2026-10-05' });
  const clientA = party('Client A');
  const invA = openInvoices(clientA)[0];
  eq('Invoice: 1100 up by the total', bal('1100', { party: clientA }), 118000);
  eq('…GST split CGST/SGST for an in-state client', bal('2200'), 9000);

  // Partial credit note on the unpaid invoice.
  save('creditnote', { date: '2026-09-20', inv: invA.id, why: 'Brokerage renegotiated', amt: 20000, refund: 'hold' });
  eq('Income comes down by the base', bal('4000'), 80000);
  eq('CGST comes down', bal('2200'), 7200);
  eq('SGST comes down', bal('2201'), 7200);
  eq('The client owes 23,600 less', bal('1100', { party: clientA }), 94400);
  check('The invoice is part-settled by the credit note', invA.status === 'part' && near(invA.credited, 23600) && near(invoiceOutstanding(invA), 94400) && invA.allocations.some(a => a.creditNote), JSON.stringify(invA));
  const cn = g.invoices.find(i => i.kind === 'creditnote');
  check('A numbered credit note is on record against the invoice', cn && cn.invoiceNo === '3PIN/CN/26-27/001' && cn.against === invA.invoiceNo && near(cn.total, 23600) && cn.commercial === false, JSON.stringify(cn));
  eq('September income is what is left', pl('2026-09').ti, 80000);
  refuses('A credit note cannot exceed the invoice base', () => save('creditnote', { date: '2026-09-21', inv: invA.id, why: 'x', amt: 200000, refund: 'hold' }), 'only');
  refuses('A credit note needs a reason — it is printed', () => save('creditnote', { date: '2026-09-21', inv: invA.id, why: '', amt: 100, refund: 'hold' }), 'reason');
  refuses('An invoice with a credit note against it cannot be reversed', () => reverse(invTxnA), 'credit note');
  save('dealpay', { date: '2026-09-25', party: clientA, amt: 94400, via: '1000' });
  check('The rest is collected and the invoice is paid', invA.status === 'paid' && bal('1100', { party: clientA }) === 0);

  // Credit note on a fully paid invoice: refunded from the bank.
  const bankB = bal('1000');
  save('creditnote', { date: '2026-09-28', inv: invA.id, why: 'Goodwill reduction', amt: 10000, refund: '1000' });
  eq('The excess on a paid invoice is refunded from the bank', bankB - bal('1000'), 11800);
  eq('Income down again', bal('4000'), 70000);
  eq('Nothing held for the client', bal('2100', { party: clientA }), 0);
  check('The invoice status is unchanged — there was nothing left to apply to', invA.status === 'paid');

  // Credit note on a paid invoice, held, then refunded through the token settlement.
  save('newdeal', { date: '2026-09-01', nickname: 'CN deal 2', seller: { __new: true, name: 'Client B', type: 'client' }, expSeller: 50000 });
  const dB = byName(g.deals, 'CN deal 2').id;
  save('invoice', { date: '2026-09-06', deal: dB, from: 'seller', amt: 50000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  const clientB = party('Client B');
  save('dealpay', { date: '2026-09-10', party: clientB, amt: 50000, via: '1000' });
  const invB = g.invoices.find(i => i.partyId === clientB && i.kind !== 'creditnote');
  save('creditnote', { date: '2026-09-29', inv: invB.id, why: 'Fee renegotiated after registration', amt: 5000, refund: 'hold' });
  eq('The excess is held for the client, tagged to the deal', bal('2100', { party: clientB, deal: dB }), 5000);
  // Heads so far: 9,000 + 9,000 on the invoice, less 1,800 × 2 (first note) and 900 × 2 (second).
  eq('No GST on a no-GST invoice\'s credit note', bal('2200') + bal('2201') + bal('2202'), 7200 + 7200 - 900 * 2);
  save('settle', { date: '2026-09-30', deal: dB, from: 'seller', refund: 5000, via: '1000', keep: 0, move: '', drop: 'no' });
  eq('The held amount is refunded through the settlement', bal('2100', { party: clientB }), 0);
  eq('Second credit note numbered in sequence', g.invoices.filter(i => i.kind === 'creditnote').length, 3);

  // The s.34(2) window: with an April year and a 366-day date limit it cannot be crossed.
  check('The window on a FY 26-27 invoice is 30 Nov 2027', cn.s34Window === '2027-11-30', cn.s34Window);
  {
    const past = validateEvent('creditnote', { date: '2027-12-01', inv: invA.id, why: 'late', amt: 100 });
    check('A credit note dated past the window is beyond the date limit — the branch is unreachable with default settings (documented limitation)', past.some(p => !p.warn && p.k === 'date'), JSON.stringify(past));
    const near31 = validateEvent('creditnote', { date: '2027-08-01', inv: invA.id, why: 'late', amt: 100 });
    check('…a date within the year only warns', near31.every(p => p.warn), JSON.stringify(near31));
  }
  // Guards on what a credit note may target.
  const cnDoc = g.invoices.find(i => i.kind === 'creditnote');
  // BUG: expected refusal — a credit note is not an invoice and cannot itself be reduced;
  // actual: accepted, and posts income/1100 movements against the credit note document.
  // EV.creditnote.check finds the target with S().invoices.find(i => i.id === v.inv) and never
  // checks kind or status (the field's option list excludes them, the validation does not).
  refuses('A credit note cannot be raised against a credit note', () => save('creditnote', { date: '2026-09-30', inv: cnDoc.id, why: 'x', amt: 100, refund: 'hold' }));

  // Reversal guards: a paid invoice cannot be reversed until the payment is.
  save('newdeal', { date: '2026-09-01', nickname: 'Reverse deal', seller: { __new: true, name: 'Client C', type: 'client' }, expSeller: 30000 });
  const dC = byName(g.deals, 'Reverse deal').id;
  const invTxnC = save('invoice', { date: '2026-09-07', deal: dC, from: 'seller', amt: 30000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  const clientC = party('Client C');
  const invC = openInvoices(clientC)[0];
  const payC = save('dealpay', { date: '2026-09-12', party: clientC, amt: 30000, via: '1000' });
  refuses('An invoice with a payment against it cannot be reversed', () => reverse(invTxnC), 'reverse the payment first');
  reverse(payC);
  check('Reversing the payment reopens the invoice', invC.status === 'open' && near(invC.paid, 0), JSON.stringify(invC));
  reverse(invTxnC);
  check('…then the invoice itself can be reversed, which voids it', invC.status === 'void');
  eq('The client owes nothing', bal('1100', { party: clientC }), 0);
  eq('Income for that deal is gone', pl('2026-09', dC).ti, 0);
  // BUG: expected refusal — a void invoice has nothing left to reduce; actual: accepted, income
  // and 1100 are reduced again against an invoice that was already reversed.
  // EV.creditnote.check does not look at inv.status.
  refuses('A credit note cannot be raised against a void invoice', () => save('creditnote', { date: '2026-09-30', inv: invC.id, why: 'x', amt: 100, refund: 'hold' }));
  check('E: trial balance balances', trialBalance().balanced);
}

section('E2. The s.34 window can be crossed with an off-April year — the commercial branch');
{
  // Artifice: a financial year starting in October puts a September invoice in FY 2025-26,
  // whose window (30 Nov 2026) is inside the 366-day date limit. Not the owner's real year.
  const g = fresh({ fyStartMonth: 10 });
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 100000 });
  save('newdeal', { date: '2026-09-01', nickname: 'Old FY deal', seller: { __new: true, name: 'Client O', type: 'client' }, expSeller: 50000 });
  const dO = byName(g.deals, 'Old FY deal').id;
  save('invoice', { date: '2026-09-05', deal: dO, from: 'seller', amt: 50000, gst: 'yes', gstRate: 18, gstAmt: 9000, total: 59000, tds: 0, adv: 0, recv: 'later' });
  const clientO = party('Client O');
  const invO = openInvoices(clientO)[0];
  const gstB = bal('2200') + bal('2201');
  save('creditnote', { date: '2026-12-01', inv: invO.id, why: 'Late renegotiation', amt: 10000, refund: 'hold' });
  const cnO = g.invoices.find(i => i.kind === 'creditnote');
  check('Past the window the note is commercial — base only', cnO.commercial === true && near(cnO.total, 10000) && cnO.s34Window === '2026-11-30', JSON.stringify(cnO));
  eq('GST on the invoice is not reduced', bal('2200') + bal('2201'), gstB);
  eq('Income is', bal('4000'), 40000);
  eq('The client owes only the base less', bal('1100', { party: clientO }), 49000);
  check('E2: trial balance balances', trialBalance().balanced);
}

// ═══════ F. MONEY VIEWS ═══════

section('F. What moves money — movesMoney, cashBook, scope');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 100000 });
  save('transfer', { date: '2026-09-02', kind: '1000>1010', amt: 10000, method: 'cash' });
  let n = g.txns.length;
  save('newdeal', { date: '2026-09-03', nickname: 'View deal', seller: { __new: true, name: 'Client V', type: 'client' }, buyer: { __new: true, name: 'Buyer V', type: 'client' }, expSeller: 50000 });
  save('subnew', { date: '2026-09-03', name: 'Notion', vendor: { __new: true, name: 'Notion Labs', type: 'vendor' }, payMode: 'monthly', billing: 'auto', amt: 1000, via: '1000' });
  const notion = byName(g.subs, 'Notion');
  save('subchange', { from: '2026-11', sub: notion.id, plan: 'Plus', payMode: 'monthly', amt: 1500 });
  check('newdeal, subnew (monthly) and subchange post no entry at all', g.txns.length === n);
  const dV = byName(g.deals, 'View deal').id;
  const billT = save('bill', { date: '2026-09-04', vendor: { __new: true, name: 'View Vendor', type: 'vendor' }, desc: 'Signage', acc: '5100', amt: 3000, rcm: 'no' });
  const invT = save('invoice', { date: '2026-09-05', deal: dV, from: 'seller', amt: 50000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  check('A bill does not move money', !movesMoney(txnOf(billT)));
  check('An invoice does not move money', !movesMoney(txnOf(invT)));
  const vv = party('View Vendor'), cv = party('Client V');
  const moved = {
    expense: save('expense', { date: '2026-09-06', desc: 'Fuel', acc: '5050', amt: 800, rcm: 'no', via: '1000' }),
    paybill: save('paybill', { date: '2026-09-07', party: vv, amt: 3000, via: '1000' }),
    dealpay: save('dealpay', { date: '2026-09-08', party: cv, amt: 50000, via: '1000' }),
    token: save('token', { date: '2026-09-09', deal: dV, from: 'buyer', amt: 5000, via: '1000' }),
    transfer: save('transfer', { date: '2026-09-10', kind: '1000>1010', amt: 2000, method: 'cash' }),
    petty: save('petty', { date: '2026-09-11', d1: 'Auto', a1: 150, c1: '5050', a2: 0, a3: 0 }),
    salary: save('salary', { date: '2026-09-30', emp: { __new: true, name: 'Ravi', type: 'employee' }, kind: '5010', month: '2026-09', gross: 15000, pf: 0, via: '1000' }),
  };
  save('bankloan', { date: '2026-09-12', lender: { __new: true, name: 'HDFC', type: 'lender' }, purpose: 'Van', amt: 120000, rate: 10, n: 12, fee: 0, kind: 'bank' });
  moved.emi = save('emi', { date: '2026-10-05', loan: g.loans[0].id, charges: 0, extra: 0, prepay: 0, via: '1000' });
  for (const [k, id] of Object.entries(moved)) check(`${k} moves money`, movesMoney(txnOf(id)));
  const upfront = save('subnew', { date: '2026-10-06', name: 'Domain', vendor: { __new: true, name: 'GoDaddy', type: 'vendor' }, payMode: 'upfront', amt: 1200, months: 12, via: '1000', rcm: 'no' });
  check('An upfront plan is a payment, so it does move money', movesMoney(txnOf(upfront)));
  const mm = moneyMoved(txnOf(moved.transfer));
  check('moneyMoved on a bank-to-box transfer nets to zero across both pockets', mm.in === 2000 && mm.out === 2000 && mm.net === 0, JSON.stringify(mm));
  check('…and to -2,000 for the bank alone', moneyMoved(txnOf(moved.transfer), ['1000']).net === -2000);

  // Cash book across two months, opening + in - out = closing = what the pockets hold.
  save('expense', { date: '2026-10-10', desc: 'Ads', acc: '5090', amt: 4000, rcm: 'no', via: '2300' });
  save('transfer', { date: '2026-10-12', kind: '1000>2300', amt: 4000, method: 'netbanking' });
  const sep = cashBook('2026-09-01', '2026-09-30');
  const oct = cashBook('2026-10-01', '2026-10-31');
  eq('September opens at zero', sep.opening, 0);
  eq('September: opening + in - out = closing', sep.opening + sep.in - sep.out, sep.closing);
  eq('September closing = bank + box on the 30th', sep.closing, bal('1000', { upto: '2026-09-30' }) + bal('1010', { upto: '2026-09-30' }));
  eq('October opens where September closed', oct.opening, sep.closing);
  eq('October: opening + in - out = closing', oct.opening + oct.in - oct.out, oct.closing);
  eq('October closing = bank + box today', oct.closing, bal('1000') + bal('1010'));
  check('The bill and the invoice are not in the cash book', !sep.rows.some(r => r.t.id === billT || r.t.id === invT));
  check('A bank-to-box transfer shows once, with both pockets named', sep.rows.filter(r => r.t.id === moved.transfer).length === 1 && sep.rows.find(r => r.t.id === moved.transfer).pocket.includes('Bank') && sep.rows.find(r => r.t.id === moved.transfer).pocket.includes('Petty'));
  const octCard = cashBook('2026-10-01', '2026-10-31', ['1000', '1010', '2300']);
  eq('With the card, the ad spend is money out and the card bill is not double-counted', octCard.out, oct.out + 4000);
  eq('…and closing still equals the three pockets', octCard.closing, bal('1000') + bal('1010') - bal('2300'));

  // Scope: only / without / with.
  const onlyPl = scoped(() => pl('2026-09'), 'only');
  const withoutPl = scoped(() => pl('2026-09'), 'without');
  const withPl = pl('2026-09');
  const manual = g.txns.filter(t => ym(t.date) === '2026-09' && t.lines.some(l => l.acc === '1010'))
    .reduce((a, t) => a + t.lines.filter(l => A[l.acc].type === 'expense').reduce((x, l) => x + num(l.dr) - num(l.cr), 0), 0);
  eq('"Only petty cash" P&L is exactly the box\'s spends', onlyPl.te, manual);
  eq('…which is the auto voucher', onlyPl.te, 150);
  eq('without + only = with (costs)', withoutPl.te + onlyPl.te, withPl.te);
  eq('without + only = with (income)', withoutPl.ti + onlyPl.ti, withPl.ti);
  check('The default scope is "with" and a bad mode falls back to it', scopeMode() === 'with' && setScope('bogus') === 'with');
  setScope('only');
  check('setScope drives scoped() when no mode is passed', scoped(() => pl('2026-09')).te === onlyPl.te);
  setScope('with');
  check('The books are intact after a scoped read', g.txns.length > 10 && pl('2026-09').te === withPl.te);
  check('F: trial balance balances', trialBalance().balanced);
}

// ═══════ G. PETTY CASH ═══════

section('G. The box — top-ups, spends, sweeps, cash in, and the guard');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 50000 });
  // The box is an account, so a spend before it was funded is recorded and shows overdrawn.
  check('A spend dated before the box was funded warns, and saves',
    validateEvent('petty', { date: '2026-09-05', d1: 'Tea', a1: 100, c1: '5030', a2: 0, a3: 0 }).some(p => p.warn && /box/i.test(p.msg)));
  save('transfer', { date: '2026-09-10', kind: '1000>1010', amt: 5000, method: 'cash' });
  check('…and so does an expense from the box dated before the top-up',
    validateEvent('expense', { date: '2026-09-08', desc: 'Auto', acc: '5050', amt: 100, rcm: 'no', via: '1010' }).some(p => p.warn && /box/i.test(p.msg)));
  save('petty', { date: '2026-09-12', d1: 'Tea', a1: 200, c1: '5030', d2: 'Courier', a2: 500, c2: '5100', a3: 0 });
  save('funding', { date: '2026-09-15', kind: '2450', who: OWNER, amt: 2000, via: '1010' });
  save('transfer', { date: '2026-09-20', kind: '1010>1000', amt: 1000 });
  save('petty', { date: '2026-10-03', d1: 'Auto', a1: 300, c1: '5050', a2: 0, a3: 0 });
  const pa = pettyActivity();
  const kinds = Object.fromEntries(pa.rows.map(r => [r.t.date, r.kind]));
  check('Each movement is classified', kinds['2026-09-10'] === 'topup' && kinds['2026-09-12'] === 'spend' && kinds['2026-09-15'] === 'in' && kinds['2026-09-20'] === 'sweep' && kinds['2026-10-03'] === 'spend', JSON.stringify(kinds));
  eq('Top-ups', pa.topups, 5000);
  eq('Spent', pa.spent, 1000);
  eq('Cash put in by the director', pa.received, 2000);
  eq('Swept back to the bank', pa.swept, 1000);
  eq('Balance is what the ledger says', pa.balance, bal('1010'));
  eq('…which is', bal('1010'), 5000 - 700 + 2000 - 1000 - 300);
  check('Newest first', pa.rows[0].t.date === '2026-10-03');
  check('A spend row says what it paid for', pa.rows.find(r => r.t.date === '2026-09-12').what.includes('Staff welfare'));
  const octOnly = pettyActivity({ month: '2026-10' });
  check('The month filter narrows the rows', octOnly.rows.length === 1 && octOnly.spent === 300 && octOnly.topups === 0, JSON.stringify(octOnly));
  eq('…but the balance is the box today', octOnly.balance, bal('1010'));
  eq('Up to a date, the balance is as of that date', pettyActivity({ upto: '2026-09-12' }).balance, 4300);
  check('Going below zero on the entry date warns', validateEvent('petty', { date: '2026-10-04', d1: 'Big', a1: 5001, c1: '5180', a2: 0, a3: 0 }).some(p => p.warn && /box/i.test(p.msg)));
  check('Sweeping more than the box holds warns too', validateEvent('transfer', { date: '2026-10-04', kind: '1010>1000', amt: 5001 }).some(p => p.warn && /box/i.test(p.msg)));
  eq('Neither warning changed anything — the box is exactly 5,000 today', bal('1010'), 5000);
  save('petty', { date: '2026-10-05', d1: 'Everything', a1: 5000, c1: '5180', a2: 0, a3: 0 });
  eq('Spending exactly the balance leaves zero', bal('1010'), 0);
  // A back-dated sweep: on its own date the box held 5,000, but every later day it did not.
  // The warning looks forward, not only at the entry's own day, so it fires even though the
  // balance on 11 September was enough.
  check('A back-dated sweep that pushes later days negative is warned about',
    validateEvent('transfer', { date: '2026-09-11', kind: '1010>1000', amt: 4800 }).some(p => p.warn && /later entries/i.test(p.msg)));
  save('transfer', { date: '2026-09-11', kind: '1010>1000', amt: 4800 });
  const run = cashBook('2026-09-01', '2026-12-31', ['1010']);
  check('…and the cash book shows exactly where it went overdrawn', run.rows.some(r => r.after < -0.005), JSON.stringify(run.rows.map(r => [r.t.date, r.after])));
  eq('The box ends the period overdrawn, in full view', bal('1010'), -4800);
  save('transfer', { date: '2026-12-31', kind: '1000>1010', amt: 4800 });
  eq('Recording the top-up that was missing squares it', bal('1010'), 0);
  check('G: trial balance balances', trialBalance().balanced);
}

// ═══════ H. TDS ═══════

section('H. TDS — 194J on an expense, a recurring month and a bill; the year\'s total; the register');
{
  const g = fresh({ tdsEnabled: true });
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 300000 });
  refuses('TDS is deducted from someone — an expense with a section but no vendor is refused',
    () => save('expense', { date: '2026-09-05', desc: 'Audit fee', acc: '5120', amt: 10000, rcm: 'no', via: '1000', tds: '194J' }), 'name the vendor');
  const bankB = bal('1000');
  save('expense', { date: '2026-09-05', desc: 'Audit fee', acc: '5120', amt: 10000, rcm: 'no', via: '1000', vendor: { __new: true, name: 'Rao & Co', type: 'vendor' }, tds: '194J' });
  const rao = party('Rao & Co');
  eq('194J: 10% is withheld', bal('2250'), 1000);
  eq('…the vendor gets the net', bankB - bal('1000'), 9000);
  eq('…the cost is the gross', bal('5120'), 10000);
  check('The section rides on the entry', lastTxn().meta.tds === '194J' && lastTxn().meta.tdsrate === 10, JSON.stringify(lastTxn().meta));

  save('subnew', { date: '2026-09-01', name: 'Retainer — CA', vendor: rao, payMode: 'monthly', billing: 'invoice', amt: 5000, via: '1000' });
  const ret = byName(g.subs, 'Retainer — CA');
  save('confirmcharge', { sub: ret.id, month: '2026-09', date: '2026-09-30', result: 'invoice', amt: 5000, rcm: 'no', tds: '194J' });
  eq('A recurring month with 194J: the vendor is owed the net', bal('2000', { party: rao }), 4500);
  eq('…and TDS grows', bal('2250'), 1500);
  const retBill = g.bills.find(x => x.serviceId === ret.id);
  check('The bill records gross, TDS and net', near(retBill.total, 5000) && near(retBill.tds, 500) && near(retBill.net, 4500) && near(billOutstanding(retBill), 4500), JSON.stringify(retBill));
  save('paybill', { date: '2026-10-05', party: rao, amt: 4500, via: '1000' });
  check('Paying the net closes it', retBill.status === 'paid');
  save('confirmcharge', { sub: ret.id, month: '2026-10', date: '2026-10-31', result: 'paid', via: '1000', amt: 5000, rcm: 'no', tds: '194J' });
  eq('A month paid on the spot also withholds', bal('2250'), 2000);
  save('bill', { date: '2026-11-02', vendor: rao, desc: 'Tax filing', acc: '5120', amt: 8000, rcm: 'no', tds: '194J' });
  eq('A bill with 194J is owed net', bal('2000', { party: rao }), 7200);
  eq('TDS payable after all four', bal('2250'), 2800);

  // The year's total billed by the vendor — what the threshold is measured against.
  // BUG: expected 28,000 (10,000 expense + 5,000 invoiced month + 5,000 spot-paid month +
  // 8,000 bill); actual 23,000 — the spot-paid recurring month has no 2000 line and no
  // meta.vendor (the vendor lives on the subscription), so tdsFyTotal in finance-core.js
  // never attributes it to the payee. It should fall back to the sub's vendorId or the
  // bill the entry created.
  eq('The FY total for the vendor counts the expense, both recurring months and the bill', tdsFyTotal(rao, FY), 28000);
  eq('The total under 194J is the same set', tdsFyTotal(rao, FY, '194J'), tdsFyTotal(rao, FY));
  eq('Under another section, entries tagged 194J are left out', tdsFyTotal(rao, FY, '194C'), 0);
  eq('Someone else has no total', tdsFyTotal('nobody', FY), 0);

  save('salary', { date: '2026-09-30', emp: { __new: true, name: 'Meera', type: 'employee' }, kind: '5010', month: '2026-09', gross: 60000, tds: 3000, pf: 0, via: '1000' });
  const reg = tdsRegister(FY);
  eq('Register: 194J withheld', (reg.withheld['194J'] || []).reduce((a, r) => a + r.amt, 0), 2800);
  // BUG: expected 3,000 under withheld['192']; actual it files under withheld['3000'] — the
  // same defect as the EMI case in section D: tdsRegister reads the salary form's numeric
  // `tds` (the amount) as if it were a section code.
  eq('Register: salary TDS files under 192', (reg.withheld['192'] || []).reduce((a, r) => a + r.amt, 0), 3000);
  // BUG: expected every 194J row to name Rao & Co; actual the spot-paid recurring month
  // (October) has party null — tdsRegister looks for a party line or meta.vendor/meta.emp,
  // and a month paid on the spot has neither (the vendor lives on the subscription and on
  // the bill it created). Same root cause as the tdsFyTotal gap above.
  check('Each withheld row names the payee and the month', (reg.withheld['194J'] || []).every(r => r.party === rao && r.month), JSON.stringify(reg.withheld['194J']?.map(r => [r.party, r.month])));
  check('Nothing deposited yet', Object.keys(reg.deposited).length === 0);
  refuses('Depositing more TDS than is held is refused', () => save('statutory', { date: '2026-10-07', kind: 'tds', amt: 99999, tdsMonth: '2026-09', tdsSection: '194J', challan: 'x', bsr: 'x', interest: 0, late: 0 }), 'only');
  save('statutory', { date: '2026-10-07', kind: 'tds', amt: 1500, tdsMonth: '2026-09', tdsSection: '194J', challan: 'CH-0001', bsr: '0012345', interest: 0, late: 0 });
  save('statutory', { date: '2026-10-07', kind: 'tds', amt: 3000, tdsMonth: '2026-09', tdsSection: '192', challan: 'CH-0002', bsr: '0012345', interest: 0, late: 0 });
  const reg2 = tdsRegister(FY);
  const d194j = reg2.deposited['194J'];
  check('The deposit shows by section with challan, BSR and the month it was for', d194j && d194j.length === 1 && near(d194j[0].amt, 1500) && d194j[0].challan === 'CH-0001' && d194j[0].bsr === '0012345' && d194j[0].month === '2026-09', JSON.stringify(d194j));
  eq('Withheld 194J less deposited is what is still to pay for that section', (reg2.withheld['194J'] || []).reduce((a, r) => a + r.amt, 0) - d194j.reduce((a, r) => a + r.amt, 0), 1300);
  eq('The liability agrees', bal('2250'), 2800 + 3000 - 1500 - 3000);
  check('The remittance entry says which section and month', lastTxn().desc.includes('192') && lastTxn().desc.includes(mlabel('2026-09')), lastTxn().desc);
  check('H: trial balance balances', trialBalance().balanced);
}

// ═══════ I. EDGE CASES THE OWNER WILL HIT ═══════

section('I. Edge cases — zero amounts, dates, opening balances, references, undo, double-dip');
{
  const g = fresh();
  save('funding', { date: '2026-09-01', kind: '3000', who: OWNER, amt: 100000 });
  save('transfer', { date: '2026-09-01', kind: '1000>1010', amt: 3000 });
  save('bill', { date: '2026-09-02', vendor: { __new: true, name: 'Zero Vendor', type: 'vendor' }, desc: 'Boards', acc: '5100', amt: 1000, rcm: 'no' });
  const zv = party('Zero Vendor');
  save('newdeal', { date: '2026-09-02', nickname: 'Zero deal', seller: { __new: true, name: 'Client Z', type: 'client' }, expSeller: 20000 });
  const dZ = byName(g.deals, 'Zero deal').id;
  save('invoice', { date: '2026-09-03', deal: dZ, from: 'seller', amt: 20000, gst: 'no', tds: 0, adv: 0, recv: 'later' });
  const cz = party('Client Z');
  const invZ = openInvoices(cz)[0];
  save('bankloan', { date: '2026-09-02', lender: { __new: true, name: 'Zero Bank', type: 'lender' }, purpose: 'x', amt: 12000, rate: 10, n: 12, fee: 0, kind: 'bank' });
  const zeroCases = {
    bill: { date: '2026-09-04', vendor: zv, desc: 'x', acc: '5100', amt: 0, rcm: 'no' },
    paybill: { date: '2026-09-04', party: zv, amt: 0, short: 0, via: '1000', useAdvance: 'no' },
    dealpay: { date: '2026-09-04', party: cz, amt: 0, via: '1000' },
    token: { date: '2026-09-04', deal: dZ, from: 'seller', amt: 0, via: '1000' },
    transfer: { date: '2026-09-04', kind: '1000>1010', amt: 0 },
    petty: { date: '2026-09-04', d1: 'x', a1: 0, c1: '5030', a2: 0, a3: 0 },
    salary: { date: '2026-09-04', emp: { __new: true, name: 'Zed', type: 'employee' }, kind: '5010', gross: 0, pf: 0, via: '1000' },
    asset: { date: '2026-09-04', name: 'x', amt: 0, rcm: 'no', life: 12, how: '1000' },
    funding: { date: '2026-09-04', kind: '3000', who: OWNER, amt: 0 },
    dealcost: { date: '2026-09-04', deal: dZ, what: 'x', amt: 0, rcm: 'no', bear: 'self', acc: '5045', how: '1000' },
    creditnote: { date: '2026-09-04', inv: invZ.id, why: 'x', amt: 0, refund: 'hold' },
    vendorrefund: { date: '2026-09-04', vendor: zv, desc: 'x', what: 'cost', acc: '5100', amt: 0, rcm: 'no', how: '1000' },
    bankloan: { date: '2026-09-04', lender: { __new: true, name: 'Nil Bank', type: 'lender' }, purpose: 'x', amt: 0, rate: 10, n: 12, fee: 0 },
    statutory: { date: '2026-09-04', kind: 'tds', amt: 0, tdsMonth: '2026-08', tdsSection: '194J', interest: 0, late: 0 },
    emi: { date: '2026-10-04', loan: g.loans[0].id, prin: 0, int: 0, charges: 0, extra: 0, prepay: 0, tds: 0, via: '1000' },
    otherinc: { date: '2026-09-04', party: cz, desc: 'x', acc: '4040', amt: 0, gst: 'no', via: '1000' },
  };
  const before = g.txns.length;
  for (const [ev, v] of Object.entries(zeroCases)) refuses(`Zero amount refused: ${ev}`, () => save(ev, v));
  check('…and none of them posted anything', g.txns.length === before);
  refuses('A bill dated before the books start is refused', () => save('bill', { date: '2026-08-15', vendor: zv, desc: 'Old', acc: '5100', amt: 500, rcm: 'no' }), 'before the books start');
  refuses('A bill dated more than a year ahead is refused', () => save('bill', { date: '2027-10-01', vendor: zv, desc: 'Far', acc: '5100', amt: 500, rcm: 'no' }), 'check the year');

  // An opening-style payable: owed on the ledger with no bill document behind it.
  g.txns.push({
    id: 'TXOPEN', no: 900, date: '2026-09-01', event: 'opening', desc: 'Opening balance — Old Supplier', lines: [{ acc: '3100', dr: 5000 }, { acc: '2000', cr: 5000, party: zv }],
    totals: { dr: 5000, cr: 5000 }, meta: {}, attachments: [], auto: false, allocations: [], fy: FY, createdBy: 'test', createdAt: Date.now(),
  });
  eq('The vendor is owed the opening amount plus the bill', bal('2000', { party: zv }), 6000);
  check('Only the bill is an open document', openBills(zv).length === 1);
  const payOpen = save('paybill', { date: '2026-09-05', party: zv, amt: 6000, via: '1000', ref: 'UPI-778899', method: 'upi' });
  eq('Paying it all works without a document for the opening part', bal('2000', { party: zv }), 0);
  check('The bill got its allocation; the opening balance needed none', txnOf(payOpen).allocations.length === 1 && near(txnOf(payOpen).allocations[0].amt, 1000) && openBills(zv).length === 0, JSON.stringify(txnOf(payOpen).allocations));
  const tp = txnOf(payOpen);
  check('Reference and method are kept on the entry', tp.meta.ref === 'UPI-778899' && tp.meta.method === 'upi', JSON.stringify(tp.meta));
  check('…and the method on the bank line', tp.lines.find(l => l.acc === '1000').method === 'upi' && !tp.lines.find(l => l.acc === '2000').method, JSON.stringify(tp.lines));
  const cashIn = save('dealpay', { date: '2026-09-06', party: cz, amt: 2000, via: '1010', method: 'cash', ref: 'RCPT-1' });
  check('A receipt into the box keeps the method on the entry but not on the box line (bank only)', txnOf(cashIn).meta.method === 'cash' && txnOf(cashIn).meta.ref === 'RCPT-1' && !txnOf(cashIn).lines.find(l => l.acc === '1010').method, JSON.stringify(txnOf(cashIn).lines));

  // Undoing a short-paid payment gives the bill back and takes the income away.
  save('bill', { date: '2026-09-08', vendor: zv, desc: 'Banner', acc: '5100', amt: 10000, rcm: 'no' });
  const banner = openBills(zv)[0];
  const shortPay = save('paybill', { date: '2026-09-09', party: zv, amt: 9500, short: 500, via: '1000' });
  check('Short-paid and closed', banner.status === 'paid' && bal('4060') === 500);
  reverse(shortPay);
  check('Reversal reopens the bill in full', banner.status === 'open' && near(banner.paid, 0) && near(billOutstanding(banner), 10000), JSON.stringify(banner));
  eq('The discount income is gone', bal('4060'), 0);
  eq('The vendor is owed the full bill again', bal('2000', { party: zv }), 10000);
  check('The reversal is on the bill\'s history', banner.allocations.some(a => a.reversal));

  // Double-dip: a discount taken at payment, then the vendor's credit note for the same amount.
  save('paybill', { date: '2026-09-10', party: zv, amt: 9500, short: 500, via: '1000' });
  eq('Discount received once', bal('4060'), 500);
  refuses('A credit note for the same 500 against a closed bill is refused — nothing is owed',
    () => save('vendorrefund', { date: '2026-09-11', vendor: zv, desc: 'Banner discount note', what: 'cost', acc: '5100', amt: 500, rcm: 'no', how: 'credit' }), 'only owe');
  eq('So the cost stands', bal('5100'), 1000 + 10000);
  // PRODUCT GAP (not asserted as a bug): once the vendor has another open bill, the same
  // credit note is accepted and applied to that bill — the 500 is then counted twice, once
  // as discount income and once as a cost reduction. The engine cannot know the note refers
  // to a discount already taken; the owner has to reverse the discount instead.
  save('bill', { date: '2026-09-12', vendor: zv, desc: 'Stand', acc: '5100', amt: 3000, rcm: 'no' });
  save('vendorrefund', { date: '2026-09-13', vendor: zv, desc: 'Banner discount note', what: 'cost', acc: '5100', amt: 500, rcm: 'no', how: 'credit' });
  eq('The note now lands on the newer bill', bal('2000', { party: zv }), 2500);
  // Printing booked so far: 1,000 + 10,000 + 3,000 = 14,000 before the note.
  eq('…and the books count the 500 twice (income 500 + cost down 500) — a known gap', bal('4060') + (14000 - bal('5100')), 1000);

  // An advance returned as money is not a cost change.
  save('paybill', { date: '2026-09-14', party: zv, amt: 3000, via: '1000', over: 'advance' });
  eq('The over-payment sits as an advance', vendorAdvance(zv), 500);
  refuses('An advance cannot come back as a credit note', () => save('vendorrefund', { date: '2026-09-15', vendor: zv, desc: 'Advance back', what: 'advance', amt: 500, how: 'credit' }), 'money, not as a credit');
  refuses('…nor more than they hold', () => save('vendorrefund', { date: '2026-09-15', vendor: zv, desc: 'Advance back', what: 'advance', amt: 600, how: '1000' }), 'only hold');
  const costB = bal('5100'), bankB = bal('1000');
  save('vendorrefund', { date: '2026-09-15', vendor: zv, desc: 'Advance back', what: 'advance', amt: 500, how: '1000' });
  eq('The advance comes back to the bank', bal('1000') - bankB, 500);
  eq('…the advance account clears', vendorAdvance(zv), 0);
  eq('…and no cost changes', bal('5100'), costB);
  check('I: trial balance balances', trialBalance().balanced);
  check('I: balance sheet balances', balanceSheet().balanced);
}

report();
