// Builders and their projects: a channel partner's deals counted per builder and project, a
// property code tagged to a project filling in the builder, a booking recorded as closed (and
// invoiced in the same save), the builder's invoice saying what it is for, and the closed
// bookings not yet invoiced listed so none is missed.
//
//   node tests/finance-builders.test.mjs

import { check, eq, section, refuses, report, fresh, save } from './_harness.mjs';
import { getState, builderBook, projectForCode, isBuilderDeal, partySides, dealInvoiceDesc, bal } from '../finance-assets/finance-core.js';
import { EV, fieldsFor, validateEvent } from '../finance-assets/finance-events.js';

const keys = v => fieldsFor('newdeal', v).map(f => f.k);

fresh({ booksStartDate: '2026-09-01' });
const S = getState();
S.parties.push(
  { id: 'B_SHR', name: 'Shriram Properties', type: 'client', builder: true, commissionPct: 2, gstin: '33AAACS1234A1Z5', address: 'Chennai', state: 'Tamil Nadu',
    projects: [{ id: 'pj_kl', name: 'Kinglife', location: 'Koyambedu', pct: 2.5, codes: ['KOY0003', 'KOY0004'] }] },
  { id: 'B_PUR', name: 'Purvankara', type: 'client', builder: true, commissionPct: 3, gstin: '',
    projects: [{ id: 'pj_som', name: 'Somerset', codes: [] }, { id: 'pj_win', name: 'Windermere', codes: [] }] },
  { id: 'C_RAJ', name: 'Rajan', type: 'client', phone: '98400 22222' },
);

section('A property code belongs to a builder\'s project');
{
  const hit = projectForCode(' koy0003 ');
  check('KOY0003 is Shriram — Kinglife (case and spaces do not matter)', hit?.builder.id === 'B_SHR' && hit?.project.id === 'pj_kl');
  check('A code no project lists belongs to nobody', projectForCode('ANR003') === null);
}

section('The deal form: who is selling — an owner or a builder');
{
  const v = {};
  check('An owner by default: the seller picker, no builder fields', keys(v).includes('seller') && !keys(v).includes('builder'));
  const w = { sellerKind: 'builder' };
  check('A builder: builder, project and unit — no owner seller picker', ['builder', 'unit'].every(k => keys({ ...w, builder: 'B_PUR' }).includes(k)) && !keys(w).includes('seller'));
  check('…and the buyer\'s brokerage drops into "More details" (optional)', fieldsFor('newdeal', w).find(f => f.k === 'expBuyer').tier === 'detail');

  // Linking a property tagged to a project fills in the builder, the project and its %.
  const x = { salePrice: 12000000, gst: 'yes', gstRate: 18 };
  x.property = { id: 'p_koy', propertyCode: 'KOY0003', name: 'Kinglife 2BHK' };
  EV.newdeal.onchange('property', x);
  check('Linking KOY0003: Shriram, Kinglife, at Kinglife\'s 2.5%', x.sellerKind === 'builder' && x.builder === 'B_SHR' && x.project === 'pj_kl' && x.sellerPct === 2.5, JSON.stringify(x));
  eq('…which is 3,00,000 on 1.2 Cr', x.expSeller, 300000);
  x.unit = 'A-1203'; EV.newdeal.onchange('unit', x);
  x.buyer = { __new: true, name: 'Akash', type: 'client' }; EV.newdeal.onchange('buyer', x);
  check('The nickname fills itself: "Akash — Kinglife A-1203"', x.nickname === 'Akash — Kinglife A-1203', x.nickname);
  x.nickname = 'My own name'; x.unit = 'B-1'; EV.newdeal.onchange('unit', x);
  check('…and is left alone once typed over', x.nickname === 'My own name');

  // The builder's default % when the project has none; a typed % is kept.
  const y = { sellerKind: 'builder', salePrice: 10000000 };
  y.builder = 'B_PUR'; EV.newdeal.onchange('builder', y);
  check('Purvankara: first project picked, the builder\'s 3%', y.project === 'pj_som' && y.sellerPct === 3 && y.expSeller === 300000, JSON.stringify(y));
  y.sellerPct = 2; EV.newdeal.onchange('sellerPct', y);
  y.project = 'pj_win'; EV.newdeal.onchange('project', y);
  check('A % typed by hand stays when the project changes', y.sellerPct === 2 && y.expSeller === 200000, JSON.stringify(y));
}

section('Recorded as closed: registered, waiting to be invoiced');
save('newdeal', {
  date: '2026-09-10', property: { id: 'p_koy', propertyCode: 'KOY0003', name: 'Kinglife 2BHK' }, unit: 'A-1203',
  buyer: { __new: true, name: 'Akash', type: 'client' }, salePrice: 12000000, stage: 'closed',
});
let D = S.deals.at(-1);
check('The deal: Shriram as seller, Kinglife, unit, registered on the day', D.seller.partyId === 'B_SHR' && D.sellerKind === 'builder' && D.projectId === 'pj_kl' && D.projectName === 'Kinglife'
  && D.unit === 'A-1203' && D.status === 'registered' && D.registeredOn === '2026-09-10' && D.sellerPct === 2.5 && D.expSeller === 300000, JSON.stringify(D));
eq('Nothing posts', S.txns.length, 0);
check('It is a builder deal; its sides say "Builder —"', isBuilderDeal(D) && partySides(D.id)[0][1] === 'Builder — Shriram Properties', JSON.stringify(partySides(D.id)));
let shr = builderBook(S).find(x => x.builder.id === 'B_SHR');
check('Builders tab: Kinglife has 1 closed deal, 1.2 Cr booked, 3,00,000 commission, 1 to invoice', shr.projects[0].closed === 1 && shr.projects[0].sale === 12000000 && shr.projects[0].expected === 300000 && shr.totals.toInvoice.length === 1, JSON.stringify(shr.totals));

section('The builder\'s invoice says what it is for');
{
  const v = { deal: D.id, from: 'seller' }; EV.invoice.onchange('from', v);
  check('Starts from the commission and the deal\'s GST', v.amt === 300000 && v.gst === 'yes' && v.gstRate === 18, JSON.stringify(v));
}
save('invoice', { date: '2026-09-12', deal: D.id, from: 'seller' });
let inv = S.invoices.at(-1);
check('Invoice: project, unit, buyer, agreement value and % — in Rs. (the PDF has no ₹)', inv.desc === 'Brokerage on booking — Kinglife, Unit A-1203 · Buyer: Akash · Agreement value Rs. 1,20,00,000 @ 2.5%', inv.desc);
check('…billed to Shriram, 3,00,000 + 18% GST', inv.partyId === 'B_SHR' && inv.base === 300000 && inv.total === 354000, JSON.stringify(inv));
shr = builderBook(S).find(x => x.builder.id === 'B_SHR');
check('Builders tab: nothing to invoice now; invoiced 3,00,000; owed 3,54,000', shr.totals.toInvoice.length === 0 && shr.totals.invoiced === 300000 && Math.round(shr.totals.owed) === 354000, JSON.stringify(shr.totals));
check('An owner\'s invoice keeps its plain description', dealInvoiceDesc({ seller: { partyId: 'C_RAJ' } }, 'seller') === '');

section('Closed and invoiced in one save');
const before = S.invoices.length;
save('newdeal', {
  date: '2026-10-05', sellerKind: 'builder', builder: 'B_PUR', project: 'pj_win', unit: 'T2-804',
  buyer: 'C_RAJ', salePrice: 9000000, stage: 'invoice', dueDate: '2026-10-20',
});
D = S.deals.at(-1);
inv = S.invoices.at(-1);
check('The deal: Purvankara, Windermere, registered', D.seller.partyId === 'B_PUR' && D.projectName === 'Windermere' && D.status === 'registered' && D.expSeller === 270000, JSON.stringify(D));
check('One invoice, on THIS deal (not a placeholder id)', S.invoices.length === before + 1 && inv.dealId === D.id && inv.partyId === 'B_PUR' && inv.dueDate === '2026-10-20', JSON.stringify(inv));
check('…its income line is on the deal too', S.txns.at(-1).lines.some(l => l.acc === '4000' && l.deal === D.id && l.cr === 270000), JSON.stringify(S.txns.at(-1).lines));
eq('Purvankara owes 2,70,000 + GST on this deal', bal('1100', { party: 'B_PUR', deal: D.id }), 318600);
check('The buyer was not invoiced', !S.invoices.some(i => i.partyId === 'C_RAJ'));
check('…and the deal\'s nickname filled itself', D.nickname === 'Rajan — Windermere T2-804', D.nickname);

section('What the form refuses or warns about');
refuses('A builder deal with no builder', () => save('newdeal', { date: '2026-10-05', nickname: 'X', sellerKind: 'builder', builder: '', buyer: 'C_RAJ' }), 'builder');
refuses('Invoicing now with no commission', () => save('newdeal', { date: '2026-10-05', nickname: 'Y', sellerKind: 'builder', builder: 'B_PUR', project: 'pj_som', stage: 'invoice', sellerPct: '', expSeller: 0 }), 'commission');
check('Invoicing a builder with no GSTIN: a warning, not a block', validateEvent('newdeal', { date: '2026-10-05', nickname: 'Z', sellerKind: 'builder', builder: 'B_PUR', stage: 'invoice', expSeller: 1000 }).some(p => p.warn && p.k === 'builder'));
{
  const v = { sellerKind: 'owner' };
  check('An owner deal still needs a seller or buyer', validateEvent('newdeal', { date: '2026-10-05', nickname: 'O', ...v }).some(p => !p.warn && p.k === 'seller'));
}

section('Deals and invoices that sit outside a project');
save('newdeal', { date: '2026-10-06', nickname: 'Old Purvankara booking', sellerKind: 'builder', builder: 'B_PUR', project: '', expSeller: 50000 });
const pur = builderBook(S).find(x => x.builder.id === 'B_PUR');
check('A deal on no project shows on its own row', pur.projects.some(r => r.project === null && r.open === 1), JSON.stringify(pur.projects.map(r => [r.project?.name, r.open, r.closed])));
S.invoices.push({ id: 'I_OLD', kind: 'brokerage', partyId: 'B_PUR', base: 40000, total: 47200, status: 'issued', invoiceNo: 'OLD/1' });
const pur2 = builderBook(S).find(x => x.builder.id === 'B_PUR');
check('An invoice to the builder on no deal: listed, and in the builder\'s invoiced total', pur2.unlinked.length === 1 && pur2.totals.invoiced === 270000 + 40000, JSON.stringify(pur2.totals));
check('A builder with no deals yet still shows, with its projects', builderBook(S).length === 2);

report();
