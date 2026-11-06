// ═══════ INVOICES RAISED ON THEIR OWN ═══════
//
// The Invoices tab's New invoice: numbered lines, the client's billing details, 18% GST split
// CGST/SGST in-state, recorded in the books now or issued as a document only and recorded
// later — and numbered 3PIN{MM}{YY}-serial without ever repeating a number. Runs the real
// event builder through the same harness as every other finance test.
//
//   node tests/finance-invoices-raised.test.mjs

import {
  getState, num, bal, openInvoices, sideInvoiced, gstr1Rows, liveInvoice,
  invoiceTotals, netOfGst, withGst, issueNumber, expandPrefix, highestIssued, counterPatch,
  invoiceServices, DEFAULT_INVOICE_SERVICES, PL_GROUPS, A, presetPatch, COMPANY_PRESET,
} from '../finance-assets/finance-core.js';
import { EV, validateEvent } from '../finance-assets/finance-events.js';
import { invoiceModel } from '../finance-assets/finance-invoice.js';
import { check, eq, near, section, report, fresh, save, party } from './_harness.mjs';

console.log('3 PIN Realty — invoices raised on their own');

section('Lines and GST — the hand-made invoice, figure for figure');
{
  const t = invoiceTotals([{ desc: 'Collaboration charges', amt: 40000 }], 18, 'Tamil Nadu', 'Tamil Nadu');
  eq('Sub total', t.base, 40000);
  eq('SGST 9%', t.sgst, 3600);
  eq('CGST 9%', t.cgst, 3600);
  eq('No IGST in-state', t.igst, 0);
  eq('Total', t.total, 47200);
  const out = invoiceTotals([{ desc: 'a', amt: 1000 }, { desc: 'b', amt: 2500.5 }, { desc: 'empty', amt: 0 }], 18, 'Karnataka', 'Tamil Nadu');
  eq('Two priced lines kept, the empty one dropped', out.items.length, 2);
  eq('Another state is IGST', out.igst, 630.09);
  eq('…and no CGST', out.cgst, 0);
  eq('Typed including GST, the amount before GST is worked out', netOfGst(47200, 18), 40000);
  eq('…and the other way', withGst(40000, 18), 47200);
  eq('No GST: the total is the amount', invoiceTotals([{ desc: 'x', amt: 500 }], 0, '', 'Tamil Nadu').total, 500);
}

section('Numbering — the month and year, a dash, the serial; "3PIN" only if asked for');
{
  eq('The default numbers 1126-001, with no 3PIN', issueNumber({ nextInvoiceNo: 1 }, 'invoice', [], '2026-11-05').no, '1126-001');
  eq('The prefix the books were seeded with gives way to it', issueNumber({ invoicePrefix: '3PIN/26-27/', nextInvoiceNo: 10 }, 'invoice', [], '2026-11-05').no, '1126-010');
}
{
  eq('The prefix takes the invoice month', expandPrefix('3PIN{MM}{YY}-', '2026-11-05'), '3PIN1126-');
  const st = { invoicePrefix: '3PIN{MM}{YY}-', nextInvoiceNo: 57 };
  eq('November 2026, serial 57', issueNumber(st, 'invoice', [], '2026-11-05').no, '3PIN1126-057');
  const held = [{ invoiceNo: '3PIN1026-055' }, { invoiceNo: '3PIN1126-056' }, { invoiceNo: '3PIN/26-27/009' }];
  eq('The serial runs on across months', highestIssued('3PIN{MM}{YY}-', held), 56);
  eq('A number already held in that month is skipped', issueNumber({ ...st, nextInvoiceNo: 56 }, 'invoice', held, '2026-11-20').no, '3PIN1126-057');
  let msg = '';
  try { counterPatch({ invoicePrefix: '3PIN{MM}{YY}-', nextInvoiceNo: 50 }, new Set(['nextInvoiceNo']), st, held); } catch (e) { msg = e.message; }
  check('Winding the serial back under a month-coded prefix is refused', /3PIN1126-056 is already issued/.test(msg) && /57 or more/.test(msg), msg);
}

section('Raised and recorded in the books');
const s = fresh({ invoicePrefix: '{MM}{YY}-', nextInvoiceNo: 57, state: 'Tamil Nadu', sacCodes: { consultancy: '998311' } });
save('funding', { date: '2026-09-01', kind: '3000', who: 'Swaminathan N G', amt: 100000 });
const billTo = { name: 'Sri Suprabhatham Builder', address: '21/1, 21st Street, 4th Main Road, Nanganallur, Chennai 600061', gstin: '33AEDPR4488N1ZV', state: 'Tamil Nadu', phone: '', email: '' };
const values = {
  date: '2026-10-03', party: { __new: true, name: 'Sri Suprabhatham Builder', type: 'client' },
  items: [{ desc: "Collaboration charges for the promotion and marketing of 'SRI SUPRABHATHAM BUILDER' at Adambakkam", amt: 40000 }],
  gstRate: 18, billTo, acc: '4020', via: 'later', notes: '',
};
eq('The form passes its own checks', validateEvent('raiseinv', values).filter(p => !p.warn).length, 0);
save('raiseinv', values);
const ssb = party('Sri Suprabhatham Builder');
const inv = s.invoices.at(-1);
eq('Numbered for October 2026 from the counter', inv.invoiceNo, '1026-057');
eq('The client owes the total', bal('1100', { party: ssb }), 47200);
eq('Income is the amount before GST', bal('4020'), 40000);
eq('CGST payable', bal('2200'), 3600);
eq('SGST payable', bal('2201'), 3600);
check('The lines are on the invoice; a SAC left blank stays blank', inv.items.length === 1 && inv.items[0].sac === '', JSON.stringify(inv.items));
check('No due date given: none is invented', inv.dueDate === null, inv.dueDate);
check('…and the PDF prints no SAC and no due date for it', (() => { const mm = invoiceModel({ invoice: inv, party: {}, settings: s.settings }); return mm.items[0].sac === '' && !mm.dueDate; })());
check('The billing details are kept on the invoice as printed', inv.billTo?.gstin === '33AEDPR4488N1ZV' && /Nanganallur/.test(inv.billTo.address));
const p = s.parties.find(x => x.id === ssb);
check('…and saved onto the client for next time', p.address === billTo.address && p.gstin === billTo.gstin, JSON.stringify(p));
eq('It is open, owed in full', openInvoices(ssb).length, 1);
check('It counts as a live invoice', liveInvoice(inv));

const m = invoiceModel({ invoice: inv, party: p, settings: s.settings });
check('The PDF model numbers its lines', m.items.length === 1 && m.items[0].n === 1);
check('…and prints the client as billed', m.billTo.name === 'Sri Suprabhatham Builder' && m.billTo.gstin === '33AEDPR4488N1ZV');
check('…and CGST + SGST at 9% each', m.tax.halfRate === 9 && m.tax.cgst === 3600 && m.tax.sgst === 3600);
eq('…total', m.total, 47200);

const sig = 'data:image/png;base64,iVBORw0KGgo=';
check('A saved signature reaches the PDF', invoiceModel({ invoice: inv, party: p, settings: { ...s.settings, signature: sig } }).signature === sig);
check('…and anything that is not an image is ignored', invoiceModel({ invoice: inv, party: p, settings: { ...s.settings, signature: 'https://drive.google.com/x' } }).signature === '');

section('Several lines, paid on the spot');
save('raiseinv', {
  date: '2026-10-10', party: ssb, gstRate: 18, billTo, acc: '4020', via: '1000',
  items: [{ desc: 'Site photography', amt: 10000 }, { desc: 'Brochure design', amt: 5000, sac: '998383' }],
});
const two = s.invoices.at(-1);
eq('The next serial', two.invoiceNo, '1026-058');
eq('Two lines', two.items.length, 2);
check('A line keeps the SAC typed for it', two.items[1].sac === '998383');
eq('Total 15,000 + 18%', two.total, 17700);
check('Paid at once, so nothing is open on it', two.paid === 17700 && openInvoices(ssb).every(i => i.id !== two.id));

section('A document only, recorded later — the number does not change');
{
  // finance-sync.js issueInvoice(): the same build, stored without posting.
  const out = EV.raiseinv.build({ ...values, party: ssb, date: '2026-11-04', items: [{ desc: 'Listing support', amt: 20000 }] });
  const { paid, ...docData } = out.invoice;
  const no = issueNumber(s.settings, 'invoice', s.invoices, docData.date);
  s.invoices.push({ ...docData, id: 'DOC1', invoiceNo: no.no, unposted: true, status: 'unposted', allocations: [] });
  Object.assign(s.settings, no.patch);
  eq('Numbered for November', no.no, '1126-059');
  const owedBefore = bal('1100', { party: ssb });
  check('Not owed by anyone while it is a document only', !openInvoices(ssb).some(i => i.id === 'DOC1'));
  check('Not in the GST outward register', !gstr1Rows('2026-11').some(r => r.no === '1126-059'));
  check('Not a live invoice', !liveInvoice(s.invoices.find(i => i.id === 'DOC1')));

  const before = s.invoices.length;
  save('raiseinv', { ...values, party: ssb, date: '2026-11-04', items: [{ desc: 'Listing support', amt: 20000 }], invoiceId: 'DOC1' });
  const doc = s.invoices.find(i => i.id === 'DOC1');
  eq('Recording it raises no second invoice', s.invoices.length, before);
  eq('…and it keeps its number', doc.invoiceNo, '1126-059');
  check('…and points at its entry', !!doc.txnId && s.txns.some(t => t.id === doc.txnId), doc.txnId);
  check('…and is in the books now', !doc.unposted && doc.paid === 0);
  eq('The client now owes it too', bal('1100', { party: ssb }) - owedBefore, 23600);
  check('…and it is open', openInvoices(ssb).some(i => i.id === 'DOC1'));
  eq('The counter did not move for it', s.settings.nextInvoiceNo, 60);
}

section('A document-only invoice on a deal does not count as billing that side');
{
  const d = { id: 'D1', nickname: 'Test deal', seller: { partyId: ssb } };
  s.deals.push(d);
  s.invoices.push({ id: 'DOC2', kind: 'direct', partyId: ssb, dealId: 'D1', invoiceNo: '1126-060', total: 100, unposted: true, status: 'unposted' });
  check('The seller side is still unbilled', !sideInvoiced(d, 'seller'));
}

section('Services — collaboration, marketing, ads, studio — each its own income');
{
  const names = invoiceServices({}).map(x => x.name);
  check('The starting list has collaboration, marketing, ads and studio', ['Collaboration', 'Marketing', 'Ads', 'Studio shoot'].every(n => names.includes(n)), names.join());
  check('Every service books to an income account that exists', DEFAULT_INVOICE_SERVICES.every(x => A[x.acc]?.type === 'income'));
  const revenue = PL_GROUPS.find(g => g.key === 'revenue').codes;
  check('…and is reported as revenue from operations', DEFAULT_INVOICE_SERVICES.every(x => revenue.includes(x.acc)));
  check('A saved list replaces the starting one', invoiceServices({ invoiceServices: [{ name: 'Drone shoot' }] }).map(x => x.name).join() === 'Drone shoot');
  const ads = DEFAULT_INVOICE_SERVICES.find(x => x.name === 'Ads');
  const before = bal(ads.acc);
  save('raiseinv', { date: '2026-11-05', party: ssb, gstRate: 18, billTo, acc: ads.acc, via: 'later', items: [{ desc: ads.desc + ' Velachery launch', sac: ads.sac, amt: 25000 }] });
  eq('An ads invoice is ads income', bal(ads.acc) - before, 25000);
  eq('…and carries the ads SAC', s.invoices.at(-1).items[0].sac, ads.sac);
}

section('Company details — one click fills them from invoice 056');
{
  const p0 = presetPatch({ companyName: '3 PIN Realty Pvt Ltd', gstin: '', bankDetails: { bankName: 'HDFC' } });
  check('An empty profile gets PAN, GSTIN, address and the Indian Bank account', p0.pan === 'DHEPS4381A' && p0.gstin === '33DHEPS4381A1ZJ' && /Anna Nagar West/.test(p0.address) && p0.bankDetails.accountNo === '50527652526' && p0.bankDetails.ifsc === 'IDIB000A641', p0);
  check('…the seeded name becomes 3 Pin Realty', p0.companyName === '3 Pin Realty');
  check('…but a field already filled in is left alone', p0.bankDetails.bankName === 'HDFC');
  check('A complete profile needs nothing', Object.keys(presetPatch({ ...COMPANY_PRESET })).length === 0, presetPatch({ ...COMPANY_PRESET }));
}

section('The form refuses what would make a wrong invoice');
{
  const bad = (v, re, label) => {
    const msgs = validateEvent('raiseinv', { date: '2026-11-05', gstRate: 18, ...v }).filter(p => !p.warn).map(p => p.msg).join(' | ');
    check(label, re.test(msgs), msgs);
  };
  bad({ items: [{ desc: 'x', amt: 10 }] }, /Name the client/, 'No client');
  bad({ party: ssb, items: [{ desc: 'x', amt: 0 }] }, /at least one line/, 'No line with an amount');
  bad({ party: ssb, items: [{ desc: '', amt: 10 }] }, /needs a description/, 'An amount with no description');
  bad({ party: ssb, items: [{ desc: 'x', amt: 10 }], gstRate: 7 }, /check the rate/, 'A GST rate that does not exist');
  bad({ party: ssb, items: [{ desc: 'x', amt: 10 }], billTo: { gstin: '123' } }, /15 characters/, 'A short GSTIN');
}

report();
