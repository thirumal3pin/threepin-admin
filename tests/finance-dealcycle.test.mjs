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

import { getState, bal, invoiceOutstanding, partyAndLeadHits, leadAsParty, matchParty, propertyPeople } from '../finance-assets/finance-core.js';
import { EV, fieldsFor, brokerageSync, dealBrokerage } from '../finance-assets/finance-events.js';
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
check('...on a numbered invoice like any other', /^\d{4}-\d{3}$/.test(lastInv().invoiceNo || ''), lastInv().invoiceNo);
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

// ═══════ A DEAL'S SELLER OR BUYER, PICKED FROM THE CRM ═══════

section('A seller or buyer can be a CRM lead — it becomes a client that remembers the lead');

const LEADS = [
  { id: 'L1', name: 'Akash Kumar', phone: '+91 98400 12345', enquiryType: 'Property enquiry', propertyInterest: 'ANR003' },
  { id: 'L2', name: 'Akshaya Raman', phone: '98400 55555', enquiryType: 'Seller listing', propertyInterest: '3BHK Adyar' },
  { id: 'L3', name: 'Ramesh', phone: '98400 77777', enquiryType: 'Property enquiry' },
];
const s1 = s => JSON.stringify(s);
fresh({ booksStartDate: '2026-09-01' });
save('newdeal', { date: '2026-09-05', nickname: 'Old client deal', buyer: { __new: true, name: 'Ramesh', type: 'client' }, expBuyer: 10000 });

let hits = partyAndLeadHits(getState().parties, LEADS, 'ak', 'seller');
eq('Typing "ak": both Akash and Akshaya from the CRM', hits.leads.length, 2);
check('...for the seller, the seller lead comes first', hits.leads[0].id === 'L2', s1(hits.leads.map(l => l.id)));
hits = partyAndLeadHits(getState().parties, LEADS, 'ak', 'buyer');
check('...for the buyer, the buyer lead comes first', hits.leads[0].id === 'L1', s1(hits.leads.map(l => l.id)));
check('Found by phone digits too', partyAndLeadHits(getState().parties, LEADS, '12345', 'buyer').leads.map(l => l.id).join() === 'L1');
check('Found by the property they asked about', partyAndLeadHits(getState().parties, LEADS, 'anr003', 'buyer').leads.map(l => l.id).join() === 'L1');
check('Nothing typed: no CRM list (it is searched, not listed)', partyAndLeadHits(getState().parties, LEADS, '', 'buyer').leads.length === 0);
const rh = partyAndLeadHits(getState().parties, LEADS, 'ramesh', 'buyer');
check('A CRM "Ramesh" is still offered next to the client "Ramesh" — a different person', rh.parties.length === 1 && rh.leads.map(l => l.id).join() === 'L3');

save('newdeal', { date: '2026-09-06', nickname: 'Akash — ANR003', buyer: leadAsParty(LEADS[0]), seller: leadAsParty(LEADS[1]), expBuyer: 50000, expSeller: 50000 });
const dl = getState().deals.at(-1);
const akash = getState().parties.find(p => p.crmRef === 'L1');
check('The buyer is now a client, with the lead\'s name and phone', akash && akash.name === 'Akash Kumar' && akash.phone === '+91 98400 12345' && akash.type === 'client', s1(akash));
check('The deal keeps each side\'s CRM lead and phone', dl.buyer.crmRef === 'L1' && dl.seller.crmRef === 'L2' && dl.buyer.phone === '+91 98400 12345', s1([dl.buyer, dl.seller]));
check('...and a side typed by hand has no CRM lead', !('crmRef' in getState().deals[0].buyer), s1(getState().deals[0].buyer));

const before = getState().parties.length;
save('newdeal', { date: '2026-09-07', nickname: 'Akash again', buyer: leadAsParty(LEADS[0]), expBuyer: 1 });
eq('The same lead picked again: the same client, not a second one', getState().parties.length, before);
check('...the second deal points at the same party', getState().deals.at(-1).buyer.partyId === akash.id);
check('Once a client, the lead is not offered twice in the picker', !partyAndLeadHits(getState().parties, LEADS, 'akash', 'buyer').leads.length);

save('newdeal', { date: '2026-09-08', nickname: 'Ramesh from CRM', buyer: leadAsParty(LEADS[2]), expBuyer: 1 });
const rameshes = getState().parties.filter(p => p.name === 'Ramesh');
eq('A CRM lead never merges into a client just because the name matches', rameshes.length, 2);

fresh({ booksStartDate: '2026-09-01' });
save('newdeal', { date: '2026-09-05', nickname: 'Phone client', buyer: { __new: true, name: 'Mr Akash', type: 'client', phone: '9840012345' }, expBuyer: 1 });
const pc = getState().parties[0];
check('A lead whose phone is already a client\'s: matched to that client', matchParty(getState().parties, leadAsParty(LEADS[0]))?.id === pc.id);
save('newdeal', { date: '2026-09-06', nickname: 'Same person', buyer: leadAsParty(LEADS[0]), expBuyer: 1 });
check('...no new party, and the client now remembers the lead', getState().parties.length === 1 && pc.crmRef === 'L1' && getState().deals.at(-1).buyer.crmRef === 'L1', s1(getState().parties));

// ═══════ CAPTURING A DEAL: SALE PRICE, BROKERAGE AS % OR AMOUNT, GST ═══════

section('Brokerage is an amount or a % of the sale — each fills the other — and GST is optional');

{
  const v = { salePrice: 18000000, gst: 'yes', gstRate: 18 };
  v.sellerPct = 1; brokerageSync('sellerPct', v);
  eq('1% of 1.8 Cr is 1,80,000', v.expSeller, 180000);
  v.expBuyer = 90000; brokerageSync('expBuyer', v);
  eq('An amount of 90,000 is 0.5% of the sale', v.buyerPct, 0.5);
  eq('Total with 18% GST: 2,70,000 + 48,600', v.totalWithGst, 318600);
  v.salePrice = 20000000; brokerageSync('salePrice', v);
  check('A new sale price moves the % fee, not the fixed amount (whose % is shown again)', v.expSeller === 200000 && v.expBuyer === 90000 && v.buyerPct === 0.45, JSON.stringify(v));
  v.gst = 'no'; brokerageSync('gst', v);
  eq('No GST: the total is the brokerage', v.totalWithGst, 290000);
  const w = { expSeller: 50000 }; brokerageSync('expSeller', w);
  check('An amount with no sale price yet: no % is made up', w.sellerPct === '' && w.totalWithGst === 50000, JSON.stringify(w));
}

fresh({ booksStartDate: '2026-09-01' });
save('newdeal', {
  date: '2026-09-05', nickname: 'Akash — ANR003', property: { id: 'prop_anr', propertyCode: 'ANR003', name: 'Anna Nagar 3BHK' },
  seller: { __new: true, name: 'Meenakshi', type: 'client', phone: '98400 66666', crmRef: 'L4' }, buyer: { __new: true, name: 'Akash', type: 'client' },
  salePrice: 18000000, sellerPct: 1, expBuyer: 100000, gst: 'yes', gstRate: 18,
});
let D = getState().deals[0];
check('The deal keeps the sale price, each side\'s % and the GST choice', D.salePrice === 18000000 && D.sellerPct === 1 && D.buyerPct === null && D.gst.on === true && D.gst.rate === 18, JSON.stringify(D));
const br = dealBrokerage(D);
check('…brokerage 2,80,000 + GST 50,400 = 3,30,400', br.base === 280000 && br.gst === 50400 && br.total === 330400, JSON.stringify(br));
eq('Nothing posts for a new deal', getState().txns.length, 0);
check('A fixed amount keeps no % (it was only shown) — so the closed price will not move it', D.buyerPct === null && D.expSeller === 180000);
check('Saved without GST: kept as off', (save('newdeal', { date: '2026-09-05', nickname: 'No GST deal', buyer: { __new: true, name: 'X', type: 'client' }, expBuyer: 1000, gst: 'no' }), getState().deals.at(-1).gst.on === false));
refuses('A % above 100 is refused', () => save('newdeal', { date: '2026-09-05', nickname: 'Bad', buyer: { __new: true, name: 'Y', type: 'client' }, salePrice: 100, buyerPct: 120, expBuyer: 120 }));
refuses('A % with no sale price is refused (type the amount instead)', () => save('newdeal', { date: '2026-09-05', nickname: 'Bad2', buyer: { __new: true, name: 'Z', type: 'client' }, buyerPct: 1 }));

section('Registered: the closed sale price is captured, and a %-based fee follows it');

{
  const v = {}; EV.register.onchange('deal', Object.assign(v, { deal: D.id }));
  eq('Marking it registered starts from the deal\'s sale price', v.salePrice, 18000000);
}
save('register', { date: '2026-10-01', deal: D.id, salePrice: 19000000 });
D = getState().deals[0];
check('Closed at 1.9 Cr: the price is kept', D.status === 'registered' && D.salePrice === 19000000, JSON.stringify(D));
eq('…the seller\'s 1% is now 1,90,000', D.expSeller, 190000);
eq('…the buyer\'s fixed amount does not move', D.expBuyer, 100000);

section('The invoice starts from the deal\'s GST choice');
{
  const v = { deal: D.id, from: 'seller' }; EV.invoice.onchange('from', v);
  check('Seller invoice: the expected amount, GST on at the deal\'s rate', v.amt === 190000 && v.gst === 'yes' && v.gstRate === 18 && v.gstAmt === 34200, JSON.stringify(v));
  const nd = getState().deals.find(d => d.nickname === 'No GST deal');
  const w = { deal: nd.id, from: 'buyer', gst: 'yes' }; EV.invoice.onchange('from', w);
  check('A deal without GST: the invoice starts with GST off', w.gst === 'no' && w.gstAmt === 0, JSON.stringify(w));
}

section('A linked property offers its sellers, and the people who enquired about it as buyers');
{
  const prop = { id: 'prop_anr', propertyCode: 'ANR003', name: 'Anna Nagar 3BHK', contactName: 'Swaminathan', contactNumber: '98848 83370' };
  const leads = [
    { id: 'L4', name: 'Meenakshi Sundaram', phone: '98400 66666', enquiryType: 'Seller listing', propertyCodes: ['prop_anr'] },
    { id: 'L5', name: 'Divya', phone: '98400 88888', enquiryType: 'Property enquiry', propertyCodes: ['ANR003'] },
    { id: 'L6', name: 'Elsewhere', phone: '98400 99999', enquiryType: 'Property enquiry', propertyCodes: ['ADY010'] },
  ];
  const listings = [{ propertyCode: 'ANR003', sellerName: 'Meenakshi S', sellerPhone: '9840066666', leadId: 'L4' }];
  const sellers = propertyPeople({ prop, leads, listings, parties: [], side: 'seller' });
  check('Sellers: the board\'s owner (named as in the CRM, carrying her lead) — once, though she is also a seller lead', sellers.length === 2 && sellers[0].value.name === 'Meenakshi Sundaram' && sellers[0].value.crmRef === 'L4' && /Property & Media/.test(sellers[0].why), JSON.stringify(sellers));
  check('…and the contact on the property', sellers[1].value.name === 'Swaminathan' && sellers[1].value.phone === '98848 83370' && !sellers[1].value.crmRef);
  const buyers = propertyPeople({ prop, leads, listings, parties: [], side: 'buyer' });
  check('Buyers: only who enquired about this property, matched by its code or its id', buyers.length === 1 && buyers[0].value.crmRef === 'L5', JSON.stringify(buyers));
  const parties = getState().parties;   // Meenakshi is a client now (L4, 98400 66666)
  const again = propertyPeople({ prop, leads, listings, parties, side: 'seller' });
  check('Someone already a client comes back as that client', again[0].party && again[0].party.crmRef === 'L4', JSON.stringify(again[0]));
  check('No property, nobody offered', propertyPeople({ prop: null, leads, listings, side: 'seller' }).length === 0);
  check('A property\'s contact with a phone matches a client by that phone, not a namesake', matchParty([{ id: 'a', name: 'Swaminathan', phone: '90000 00000' }, { id: 'b', name: 'S. Swami', phone: '9884883370' }], sellers[1].value)?.id === 'b');
}

report();
