// ═══════ 3 PIN REALTY — FINANCE EVENTS ═══════
//
// One event per thing that actually happens in the business. Each builds a balanced journal
// plus a plain-English explanation of what saving it will do, and describes the documents it
// creates or settles. Ported from reference/3PIN-Finance-System-v2.html, then reworked around
// three linked layers a chartered accountant expects:
//
//   commitment  — what is expected (a service's monthly charge, with a dated history)
//   document    — a bill or invoice with identity, GST, due date and what has been paid on it
//   settlement  — a payment ALLOCATED to specific documents, oldest first unless overridden
//
// build(v) MUST stay pure: it creates nothing and writes nothing, because the Record screen
// calls it on every keystroke to render the live preview. Anything that needs to be created
// is DESCRIBED in the returned `docs` / `updates` / `allocations` and applied by
// finance-sync.js inside the same transaction as the journal, only when Save is pressed.
//
// check(v) returns field-level problems ({k, msg}) so the form can point at the exact input.
// Save is disabled until check() is empty and the journal balances.

import {
  A, EXP, PAY_VIA, TDS_SECTIONS, num, today, ym, addMonths, mlabel, fmt, esc,
  getState, deal, pname, partySides, sideParty, bal, partyBalances,
  schedule, prepaidLeft, splitGst, fyOf,
  gstHeads, outputTaxLines, inputTaxLines, gstComputation, tdsFyTotal, STATES,
  GST_OUTPUT, GST_INPUT, GST_RCM,
  openBills, openInvoices, billOutstanding, invoiceOutstanding, allocate, vendorAdvance,
  expectedFor, currentPlan, addDays, lastDayOfMonth,
  PAY_METHODS, RECURRING_KINDS, recurringAcc, recurringKindLabel, regenerateSchedule, pettyRoom,
  awaitingBill, docStatus, monthPicture,
} from './finance-core.js';

// ═══════ FIELD + PARTY HELPERS ═══════

// F('key', 'Label', 'type', {extras}) — types: text number date month select textarea
//                                              party property deal alloc
const F = (k, label, type = 'text', x = {}) => ({ k, label, type, ...x });

const S = () => getState();
const tdsOn = () => !!S().settings.tdsEnabled;
const gstRate = () => num(S().settings.gstRate) || 18;
const r2 = x => Math.round(num(x) * 100) / 100;

// Category options carry their account code, so the chart of accounts is visible on the
// form itself: "5000 · Rent" rather than "Rent" with the posting hidden.
const expOpts = () => EXP.map(a => [a.code, `${a.code} · ${a.name}`]);
const accOpt = (code, label) => [code, `${code} · ${label || A[code]?.name || code}`];

// How the money moved, when it moved through the bank. Never an account.
const methodField = (viaKey = 'via', o = {}) => F('method', 'How it moved', 'select', {
  opts: PAY_METHODS, def: 'upi',
  show: x => x[viaKey] === '1000' && (!o.show || o.show(x)),
  hint: 'The account is the bank either way; this is just how — it helps match the statement later.',
});
// The bank line remembers the method, so the drawer and the statement match can show it.
const cashLine = (v, line) => (line.acc === '1000' && v.method) ? { ...line, method: v.method } : line;

// A party field holds either an existing id (string) or a not-yet-created
// {__new:true, name, phone, type} from the "add new" row of the picker. During preview we
// stand in a sentinel id so the journal still renders; finance-sync.js swaps in the real id
// before build() is called for real on Save.
export const pidOf = x =>
  !x ? null : (typeof x === 'string' ? x : 'pending:' + (x.name || 'New party'));

export const pnameOf = x =>
  !x ? '—' : (typeof x === 'string' ? pname(x) : (x.name || 'New party'));

const partyState = x => typeof x === 'string' ? (S().parties.find(p => p.id === x)?.state || '') : (x?.state || '');

const dealOpts = () => S().deals
  .filter(d => d.status !== 'cancelled')
  .map(d => [d.id, d.nickname || d.propertyName || d.id]);

const dealsWith = (code, test) => S().deals
  .filter(d => test(bal(code, { deal: d.id })))
  .map(d => [d.id, d.nickname || d.propertyName || d.id]);

const dealLabel = d => d ? (d.nickname || d.propertyName || d.id) : '';

const need = msg => ({ desc: '', lines: [], effects: [msg], incomplete: true });

// ═══════ VALIDATION HELPERS ═══════
//
// Every check returns [{k, msg}]. The form shows each message under its field; the preview
// shows the first. Nothing here blocks a legitimate edge case — a future-dated entry is a
// warning at a week and an error at a month, because post-dated cheques exist but a typo in
// the year is far more common.

const err = (k, msg) => ({ k, msg });
// Every rate the law actually uses. Anything else is a typo, and a wrong rate on a claim is
// worse than no claim at all.
const GST_RATES = [0.25, 1.5, 3, 5, 12, 18, 28];
const warn = (k, msg) => ({ k, msg, warn: true });

function dateChecks(v, key = 'date') {
  const d = v[key];
  if (!d) return [err(key, 'Pick a date')];
  const out = [];
  const start = S().settings.booksStartDate;
  if (start && d < start) out.push(err(key, `Before the books start on ${start}`));
  if (d > addDays(today(), 366)) out.push(err(key, 'More than a year in the future — check the year'));
  else if (d > addDays(today(), 31)) out.push(warn(key, 'More than a month ahead — fine for a post-dated entry, otherwise check the date'));
  return out;
}

const posAmt = (v, k = 'amt', label = 'Enter an amount above zero') =>
  num(v[k]) > 0 ? [] : [err(k, label)];

const partyReq = (v, k, label) => pidOf(v[k]) ? [] : [err(k, label)];

// A cost belongs to the month it was used. The entry is dated the last day of that month
// unless the month is already closed, in which case it lands on the document's own date —
// reopening a closed month behind the owner's back would be worse than a late cost.
// The bill has grown past the section's yearly limit but nothing was withheld on it. The app
// cannot know which section applies, so it says so and leaves the decision with the owner.
function tdsThresholdWarn(b, v) {
  if (!b || !tdsOn() || num(b.tds) > 0.005 || !b.partyId) return [];
  const st = S().settings;
  const fy = fyOf(v.date || today(), st.fyStartMonth);
  const already = tdsFyTotal(b.partyId, fy);
  const total = r2(already - num(b.taxable) + num(v.amt));
  const limits = Object.entries(st.tdsThresholds || {}).filter(([, t]) => num(t) > 0);
  const hit = limits.filter(([, t]) => total > num(t)).sort((x, y) => num(y[1]) - num(x[1]))[0];
  if (!hit || already > num(hit[1])) return [];
  return [warn('amt', `This vendor is now at ${fmt(total)} for FY ${fy}, past the ${esc(hit[0])} limit of ${fmt(num(hit[1]))}. Nothing was withheld on this bill — check with your CA whether TDS applies.`)];
}
// Whether a TDS deposit covering this bill's month has already been made, in which case the
// challan is filed and a downward adjustment belongs in the next one.
function depositedFor(b) {
  const m = b.period || b.month || ym(b.date);
  return S().txns.some(t => t.event === 'statutory' && !t.reversedBy && (t.meta?.tdsMonth === m));
}
function postDateFor(period, fallback) {
  const d = fallback || today();
  if (!period || period >= ym(d)) return d;
  if ((S().monthEnds || {})[period]) return d;
  const start = S().settings.booksStartDate;
  const end = lastDayOfMonth(period);
  if (start && end < start) return d;
  return end;
}
function periodChecks(v, k = 'period') {
  const p = v[k];
  if (!p) return [];
  const out = [];
  if (p > ym(v.date || today())) out.push(err(k, 'A cost cannot belong to a month after the bill date'));
  if (p < addMonths(ym(v.date || today()), -12)) out.push(warn(k, 'More than a year before the bill — check the month'));
  else if (p < ym(v.date || today()) && (S().monthEnds || {})[p]) out.push(warn(k, `${mlabel(p)} is already closed, so this lands in ${mlabel(ym(v.date || today()))} instead`));
  return out;
}
// The cash box is an account in its own right, like the bank — not a wallet that has to be
// filled before it can be used. A spend is recorded when it happens, and if the account ends up
// overdrawn the books say so rather than refusing the entry: an overdrawn box almost always
// means a top-up has not been recorded yet, and blocking the spend does not make that top-up
// appear. So this warns, and never blocks.
function pettyCheck(k, v, need) {
  const room = pettyRoom(v.date);
  if (num(need) <= room + 0.005) return [];
  const onDay = bal('1010', { upto: v.date || today() });
  const after = r2(onDay - num(need));
  return [warn(k, room < onDay - 0.005
    ? `The box held ${fmt(onDay)} on ${v.date}, and later entries have already spent it down to ${fmt(room)}. This will show the box overdrawn — record the top-up that is missing, or carry on if that is right.`
    : `The box holds ${fmt(onDay)}, so this takes it to ${fmt(after)}. That is fine if a top-up has not been recorded yet; otherwise check the amount.`)];
}
function gstChecks(v) {
  if (v.gst !== 'yes') return [];
  const out = [];
  if (!(num(v.gstRate) > 0)) out.push(err('gstRate', 'GST % must be above zero'));
  else if (!GST_RATES.includes(num(v.gstRate))) out.push(err('gstRate', 'GST in India is 0.25, 1.5, 3, 5, 12, 18 or 28% — check the rate'));
  if (Math.abs(num(v.amt) + num(v.gstAmt) - num(v.total)) > 0.02) out.push(err('total', 'Amount plus GST does not equal the total — check one of the three'));
  if (v.vgstin && !/^[0-9]{2}[A-Z0-9]{10}[A-Z0-9]{3}$/i.test(String(v.vgstin).replace(/\s/g, ''))) out.push(err('vgstin', 'A GSTIN is 15 characters — 2 digits, then 10 of the PAN, then 3'));
  else if (!v.vgstin && v.rcm === 'charged' && v.vendor && !BLOCKED_ITC.has(v.acc)) out.push(warn('vgstin', 'Add their GSTIN — without it this credit cannot be claimed in the return'));
  return out;
}

// ═══════ GST ON A FORM ═══════
//
// The same five fields on every form where GST applies: the taxable amount, whether GST is
// on, the rate, the tax and the total. Typing in any of them keeps the rest consistent — enter
// an amount and a rate and the total fills in; correct the total to what the bill actually
// says and the amount and tax adjust to match. Money OUT carries GST as input credit
// (1400–1402 by head); money IN carries it as GST payable (2200–2202 by head).
export function gstFields(amtLabel, o = {}) {
  const base = v => !o.show || o.show(v);
  const gstVisible = v => base(v) && (!o.gstShow || o.gstShow(v));
  const on = v => gstVisible(v) && v.gst === 'yes';
  const home = S().settings.state || 'Tamil Nadu';
  const fields = [
    F('amt', amtLabel, 'number', { hint: o.hint, show: o.show, required: true }),
    F('gst', o.kind === 'output' ? 'Charge GST on this?' : 'GST on this?', 'select', {
      opts: [['no', 'No GST'], ['yes', 'Yes']], def: o.def || 'no',
      // A purchase asks this as one three-way question instead; fieldsFor() drops this field
      // whenever the form carries that one. It used to be hidden by testing whether `rcm` had
      // a value yet, which was true only AFTER the first render — so the very first paint of
      // an expense form showed both questions, and answering the wrong one could not be undone.
      show: gstVisible,
    }),
    F('gstRate', 'GST %', 'number', { def: gstRate(), show: on }),
    F('gstAmt', 'GST amount', 'number', { def: 0, show: on }),
    F('total', 'Total including GST', 'number', {
      show: on, hint: 'Change either the amount or the total — the other one adjusts.',
    }),
  ];
  // On a purchase the credit is only as good as the invoice behind it: the vendor's GSTIN and
  // invoice number are what GSTR-2B matches on, and whether the vendor is in-state decides
  // which heads the credit lands in.
  if (o.kind !== 'output') {
    fields.push(
      F('gstType', 'GST charged as', 'select', {
        opts: [['intra', `CGST + SGST — vendor in ${home}`], ['inter', 'IGST — vendor in another state']],
        def: 'intra', show: on,
      }),
      F('vgstin', 'Vendor GSTIN', 'text', { show: on, hint: 'From the vendor\'s tax invoice. Without it the credit cannot be claimed.' }),
      F('vinv', 'Bill number', 'text', { show: o.refAlways ? base : on, hint: o.refAlways ? 'From the vendor\'s bill, so you can find it again.' : '' }),
    );
  }
  return fields;
}

export function gstSync(k, v) {
  // The three-way answer drives the flag the engine works with. It is the ONLY GST question on
  // a purchase form — fieldsFor() drops the old yes/no toggle wherever this one exists — so
  // answering it again is always enough to change the decision, in either direction.
  if (k === 'rcm') { v.gst = v.rcm === 'charged' ? 'yes' : 'no'; k = 'gst'; }
  if (!['amt', 'gst', 'gstRate', 'gstAmt', 'total'].includes(k)) return;
  if (v.gst !== 'yes') { v.gstAmt = 0; v.total = r2(v.amt); return; }
  const rate = num(v.gstRate);
  if (k === 'total') {
    v.amt = r2(num(v.total) / (1 + rate / 100));
    v.gstAmt = r2(num(v.total) - v.amt);
  } else if (k === 'gstAmt') {
    v.total = r2(num(v.amt) + num(v.gstAmt));
  } else {
    v.gstAmt = r2(num(v.amt) * rate / 100);
    v.total = r2(num(v.amt) + v.gstAmt);
  }
}

// The tax a form produced, or nothing when GST is off.
const gstOf = v => v.gst === 'yes' ? num(v.gstAmt) : 0;

// Input credit is blocked by s.17(5) on food and beverages, and on motor-vehicle running
// costs for a business that does not deal in vehicles. GST paid under these categories cannot
// be claimed back, so it is added to the cost rather than parked in 1400 as if it were.
// s.17(5): credit is blocked on food and beverages and staff welfare (b)(i), club and
// fitness membership (b)(ii), motor vehicles and their running (a), and goods given away
// as gifts or free samples (h). Claiming any of it is a demand with interest waiting.
export const BLOCKED_ITC = new Set(['5030', '5050', '5075', '5185']);

// Where the tax on a purchase goes: the cost line itself when credit is blocked, 1400–1402
// when it can be claimed.
function inputTax(acc, gi, v = {}, o = {}) {
  if (!gi) return { onCost: 0, credit: 0, lines: [], parked: 0 };
  if (BLOCKED_ITC.has(acc)) return { onCost: gi, credit: 0, lines: [], parked: 0 };
  // s.16(2)(a) and (aa): credit needs a tax invoice, and the invoice has to be in GSTR-2B.
  // A month closed on the owner's own figure has neither yet, so the tax is parked in 1405
  // and released to the input heads by "Bill arrived", dated the invoice.
  if (o.parked) return { onCost: 0, credit: 0, parked: gi, lines: [{ acc: '1405', dr: gi }] };
  return { onCost: 0, credit: gi, parked: 0, lines: inputTaxLines(gi, (v.gstType || 'intra') !== 'inter') };
}

// Reverse charge on a bill: the tax is a liability to the government paid in cash, and at the
// same time our own input credit. The vendor is owed only the bare amount. This is how an
// advocate's fee works, and how a subscription from a FOREIGN vendor (an import of services —
// Anthropic, Google, Meta billed from abroad) works: the vendor charges no Indian GST, and the
// recipient pays IGST under reverse charge and claims it back.
// The value 'yes' means reverse charge and 'charged' means the vendor put GST on the bill —
// the names are historical, the meaning is: no GST at all / GST I can claim / GST I must pay.
const RCM_OPTS = [
  ['no', 'No GST — not charged, or not applicable'],
  ['charged', 'Yes — GST is on the bill, I can claim it'],
  ['yes', 'No, but I must pay it myself — reverse charge'],
];
// Common reverse-charge rates, so a typo cannot quietly overstate a credit.
const RCM_RATES = [5, 12, 18, 28];
function rcmFields(showFn, o = {}) {
  const home = S().settings.state || 'Tamil Nadu';
  const on = x => showFn(x) && x.rcm === 'yes';
  return [
    F('rcm', 'GST on this?', 'select', {
      opts: RCM_OPTS, def: o.gstDef || 'no', show: showFn,
      hint: x => x.rcm === 'yes'
        ? 'An advocate, a goods transporter, a landlord who is not registered, or any vendor abroad charges you no GST — you pay it with the return and claim the same amount back. It costs nothing, but leaving it out is a real liability.'
        : x.rcm === 'charged' ? 'Enter the GST from the bill. The vendor\'s GSTIN and bill number are what make it claimable.'
          : 'Most small purchases, anything from an unregistered shop, salaries, interest, government fees.',
    }),
    F('rcmRate', 'GST % you must pay', 'number', { def: gstRate(), show: on, hint: 'Advocate and rent 18%, goods transport 5%.' }),
    F('rcmType', 'Where is the vendor', 'select', {
      opts: [['intra', `In ${home} — CGST + SGST`], ['inter', 'In another state — IGST'], ['import', 'Outside India — IGST']],
      def: o.def || 'intra', show: on,
    }),
    F('rcmCcy', 'Billed in', 'text', { def: 'USD', show: x => on(x) && x.rcmType === 'import', hint: 'The currency on the vendor\'s invoice.' }),
    F('rcmFx', 'Exchange rate used', 'number', { def: 0, show: x => on(x) && x.rcmType === 'import', hint: 'Rupees per unit, at the rate you actually paid. Kept for the record (Rule 34); the amount above is already in rupees.' }),
  ];
}
function rcmLines(amt, v) {
  if (v.rcm !== 'yes') return { tax: 0, lines: [] };
  const tax = r2(amt * num(v.rcmRate) / 100);
  if (!tax) return { tax: 0, lines: [] };
  const intra = (v.rcmType || 'intra') === 'intra';
  return { tax, lines: [...inputTaxLines(tax, intra), { acc: GST_RCM, cr: tax }] };
}
// s.31(3)(f) with Rule 47A: the recipient raises its own invoice for a reverse-charge
// supply. It is numbered in its own series and rides on the transaction.
function selfInvoiceOf(v, amt, tax, vendorName) {
  if (!tax) return null;
  return {
    vendor: vendorName || '', base: r2(amt), rate: num(v.rcmRate), tax: r2(tax),
    place: v.rcmType || 'intra', date: v.date || today(),
    ...(v.rcmType === 'import' ? { currency: v.rcmCcy || '', fxRate: num(v.rcmFx) } : {}),
  };
}
function rcmChecks(v, show = true) {
  if (!show || v.rcm !== 'yes') return [];
  const out = [];
  if (!RCM_RATES.includes(num(v.rcmRate))) out.push(err('rcmRate', 'Reverse charge is 5, 12, 18 or 28% — check the rate'));
  if (v.rcmType === 'import' && !(num(v.rcmFx) > 0)) out.push(warn('rcmFx', 'Record the exchange rate you paid — the return asks for it'));
  return out;
}

// Is a place of supply inside the company's own state? Unknown counts as in-state.
const isIntra = place => {
  const home = (S().settings.state || 'Tamil Nadu').trim().toLowerCase();
  const p = String(place || '').trim().toLowerCase();
  return !p || p === home;
};

// A bill document. `_key` lets an update elsewhere in the same save refer to this document's
// id before it exists ('$bill'); finance-sync.js substitutes the real id.
function billDoc(v, o) {
  return {
    coll: 'bills', _key: 'bill', _linkTxn: true,
    data: {
      partyId: o.partyId, vendorName: o.vendorName || '',
      billNo: v.vinv || '', date: v.date || today(), dueDate: o.dueDate || addDays(v.date || today(), 30),
      desc: o.desc, acc: o.acc || null,
      taxable: r2(o.taxable), gst: r2(o.gst || 0), rcm: r2(o.rcm || 0), tds: r2(o.tds || 0),
      total: r2(o.total), net: r2(o.net ?? o.total),
      paid: r2(o.paid || 0), status: o.status || 'open',
      serviceId: o.serviceId || null, month: o.month || null, dealId: o.dealId || null,
      period: o.period || o.month || ym(v.date || today()),
      ...(o.gstParked ? { gstParked: r2(o.gstParked) } : {}),
      allocations: [], no: null,
      ...(o.accrued ? { accrued: true } : {}),
    },
  };
}

export const EV = {};

// ═══════ DEALS ═══════

EV.newdeal = {
  title: 'Add a deal', group: 'Deals', dir: 'setup',
  when: 'Sets a deal up so income and costs can be mapped to it. The expected brokerage is an <b>estimate</b> for your pipeline — <b>nothing here counts as income</b>. Mark the deal registered when the sale deed is signed; invoice each side when its fee is due — normally that same day. Income is recorded by the invoice. A deal can be added without linking a property.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('nickname', 'Deal nickname', 'text', { required: true, hint: 'e.g. Rajan — Nungambakkam 2BHK' }),
    F('property', 'Link a property (optional)', 'property', { hint: 'Search your dashboard by code or name' }),
    F('propertyState', 'State the property is in', 'select', {
      opts: STATES.map(x => [x, x]), def: S().settings.state || 'Tamil Nadu',
      hint: 'Decides CGST+SGST or IGST on the invoice. The tax follows the property, not where the client lives.',
    }),
    F('seller', 'Seller', 'party', { partyType: 'client' }),
    F('buyer', 'Buyer', 'party', { partyType: 'client', hint: 'Leave blank until you have one' }),
    F('expSeller', 'Expected brokerage from seller', 'number', { def: 0 }),
    F('expBuyer', 'Expected brokerage from buyer', 'number', { def: 0 }),
    F('expMonth', 'Expected to close in', 'month', { hint: 'Optional — puts the brokerage into that month\'s projection.' }),
  ],
  check: v => [
    ...dateChecks(v),
    ...(String(v.nickname || '').trim() ? [] : [err('nickname', 'Give the deal a nickname you will recognise')]),
    ...(pidOf(v.seller) || pidOf(v.buyer) ? [] : [err('seller', 'Add a seller or a buyer — at least one')]),
    ...(num(v.expSeller) < 0 || num(v.expBuyer) < 0 ? [err('expSeller', 'Expected brokerage cannot be negative')] : []),
  ],
  build: v => {
    if (!String(v.nickname || '').trim()) return need('Give the deal a nickname.');
    const expected = num(v.expSeller) + num(v.expBuyer);
    return {
      desc: '', lines: [],
      effects: [
        `Deal "<b>${esc(v.nickname)}</b>" opens in the pipeline with expected brokerage <b>${fmt(expected)}</b>.`,
        'Nothing hits the books yet — no money has moved and nothing is owed.',
      ],
      docs: [{
        coll: 'deals',
        data: {
          nickname: String(v.nickname).trim(),
          propertyRef: v.property?.id || null,
          propertyCode: v.property?.propertyCode || '',
          propertyName: v.property?.name || '',
          propertyState: String(v.propertyState || S().settings.state || 'Tamil Nadu').trim(),
          seller: v.seller ? { partyId: pidOf(v.seller), name: pnameOf(v.seller), phone: v.seller?.phone || '' } : null,
          buyer: v.buyer ? { partyId: pidOf(v.buyer), name: pnameOf(v.buyer), phone: v.buyer?.phone || '' } : null,
          others: [],
          expSeller: num(v.expSeller), expBuyer: num(v.expBuyer), expMonth: v.expMonth || null,
          status: 'open',
          opened: v.date || today(),
        },
      }],
    };
  },
};

// Registration is a fact about the DEAL; an invoice is a document about one party's fee. They
// used to be one action, which meant billing the buyer in September "registered" the deal
// and billing the seller in November registered it again — and a deal could not be marked
// registered at all without inventing an invoice. Now the milestone posts nothing and each
// side is invoiced when its fee falls due.
EV.register = {
  title: 'Deal registered', group: 'Deals', dir: 'setup',
  when: 'The sale deed has been signed and registered. This records the milestone and the date — <b>nothing posts to the books</b>. Raise each side\'s invoice when its brokerage is due, which for most deals is this same day; income is counted by the invoice, not by this.',
  fields: () => [
    F('date', 'Registration date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: S().deals.filter(d => d.status === 'open').map(d => [d.id, dealLabel(d)]) }),
    F('note', 'Document number', 'text', { hint: 'Optional — the registered deed number, for your own reference.' }),
  ],
  check: v => [
    ...dateChecks(v),
    ...(deal(v.deal) ? [] : [err('deal', 'Pick the deal that registered')]),
    ...(deal(v.deal) && deal(v.deal).status !== 'open' ? [err('deal', 'This deal is already ' + deal(v.deal).status)] : []),
  ],
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Pick the deal that registered.');
    if (d.status !== 'open') return need('This deal is already ' + d.status + '.');
    const unbilled = ['seller', 'buyer'].filter(side => d[side]?.partyId && !S().invoices.some(i => i.dealId === d.id && i.partyId === d[side].partyId && i.kind !== 'creditnote' && i.status !== 'void'));
    return {
      desc: '', lines: [],
      effects: [
        `"<b>${esc(dealLabel(d))}</b>" marked registered on ${esc(v.date || today())}. Nothing posts.`,
        unbilled.length
          ? `Still to invoice: ${unbilled.map(side => `the ${side} (${esc(pname(d[side].partyId))})`).join(' and ')} — raise each when its fee is due; income is counted then.`
          : 'Both sides are already invoiced.',
      ],
      updates: [{ coll: 'deals', id: d.id, data: { status: 'registered', registeredOn: v.date || today(), ...(String(v.note || '').trim() ? { deedNo: String(v.note).trim() } : {}) } }],
    };
  },
};

EV.token = {
  title: 'Token / advance received', group: 'Deals', dir: 'in',
  when: 'Money a client hands over before you have invoiced them. <b>Not income</b>: it is held for the client on this deal and comes off their invoice, is refunded, or is kept if they back out. Once an invoice exists for this client on this deal, record money as "Client payment received" instead, so it is matched to the invoice. Ask your CA whether your tokens are refundable deposits (no GST until adjusted) or non-refundable advances (GST is due in the month received).',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealOpts() }),
    F('from', 'Who paid', 'select', { opts: partySides(v.deal) }),
    F('amt', 'Amount', 'number', { required: true }),
    F('via', 'Received into', 'select', { opts: [['1000', 'Bank (1000)'], ['1010', 'Petty cash (1010)']], def: '1000' }),
    methodField(),
    F('ref', 'Reference', 'text', { hint: 'UPI reference or cheque number.' }),
  ],
  check: v => [
    ...dateChecks(v),
    ...(deal(v.deal) ? [] : [err('deal', 'Pick the deal this token is for')]),
    ...(deal(v.deal) && !sideParty(deal(v.deal), v.from) ? [err('from', 'This deal has no such party yet — add them on the Deals tab')] : []),
    ...((() => { const d = deal(v.deal); const p = d && sideParty(d, v.from); return p && openInvoices(p, v.deal).length
      ? [err('from', `${pname(p)} has an open invoice on this deal — record this as "Client payment received" so it is matched to the invoice`)] : []; })()),
    ...posAmt(v),
  ],
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Pick a deal.');
    const pid = sideParty(d, v.from);
    if (!pid) return need('This deal has no ' + (v.from || 'party') + ' yet.');
    if (openInvoices(pid, d.id).length) return need(pname(pid) + ' has an open invoice on this deal — use "Client payment received".');
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount received.');
    return {
      desc: `Token — ${dealLabel(d)} (${pname(pid)})`,
      lines: [cashLine(v, { acc: v.via || '1000', dr: amt }), { acc: '2100', cr: amt, party: pid, deal: d.id }],
      effects: [
        `Cash in ${fmt(amt)}, held for ${esc(pname(pid))} on this deal.`,
        '<b>Not income.</b> This month\'s profit is unchanged.',
      ],
    };
  },
};

EV.dealcost = {
  title: 'Cost for a deal', group: 'Money out', dir: 'out',
  when: 'EC, patta, legal, documentation, travel — spent on one particular deal. Choose who bears it: <b>you</b> (a deal expense, reduces profit) or the <b>client</b> (you paid on their behalf — it sits as recoverable from them and goes onto their settlement, not your profit).',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealOpts() }),
    F('what', 'What', 'text', { hint: 'EC extract, patta transfer, lawyer opinion, site travel…' }),
    ...rcmFields(() => true),
    ...gstFields('Amount (before GST)', { kind: 'input', gstShow: x => x.rcm !== 'yes' }),
    F('bear', 'Who bears it', 'select', {
      opts: [['self', 'Company (deal expense)'], ['seller', 'Recover from seller'], ['buyer', 'Recover from buyer']],
      def: 'self',
    }),
    F('acc', 'Expense category', 'select', {
      opts: [accOpt('5045', 'Deal costs (EC, patta, legal)'), accOpt('5050'), accOpt('5110'), accOpt('5120'), accOpt('5180')],
      def: '5045', show: x => x.bear === 'self',
    }),
    F('how', 'Paid from', 'select', {
      opts: [['1000', 'Now — from Bank (1000)'], ['1010', 'Now — from Petty cash (1010)'],
      ['2300', 'Now — on the Credit card (2300)'], ['bill', 'Bill received — pay later']],
      def: '1000',
    }),
    F('vendor', 'Vendor', 'party', { partyType: 'vendor', show: x => x.how === 'bill' }),
    F('dueDate', 'Due on', 'date', { show: x => x.how === 'bill', hint: 'Leave blank for 30 days' }),
  ],
  onchange: gstSync,
  check: v => [
    ...dateChecks(v),
    ...(deal(v.deal) ? [] : [err('deal', 'Pick the deal this cost belongs to')]),
    ...posAmt(v), ...(v.rcm === 'yes' ? [] : gstChecks(v)), ...rcmChecks(v),
    ...(v.bear !== 'self' && deal(v.deal) && !sideParty(deal(v.deal), v.bear) ? [err('bear', `No ${v.bear} on this deal yet — add them on the Deals tab, or let the company bear it`)] : []),
    ...(v.how === 'bill' ? partyReq(v, 'vendor', 'Name the vendor you owe') : []),
    ...(v.how === '1010' ? pettyCheck('how', v, num(v.amt) + gstOf(v)) : []),
  ],
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Pick a deal.');
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    const rcm = rcmLines(amt, v);
    const gi = v.rcm === 'yes' ? 0 : gstOf(v);
    const total = amt + gi;
    const lines = [], eff = [], docs = [];
    if (rcm.tax) {
      lines.push(...rcm.lines);
      eff.push(`${fmt(rcm.tax)} GST is yours to pay under reverse charge — out with the return, back as credit.`);
    }

    if (v.bear === 'self') {
      const tax = inputTax(v.acc || '5045', gi, v);
      lines.push({ acc: v.acc || '5045', dr: amt + tax.onCost, deal: d.id }, ...tax.lines);
      eff.push(`Deal expense ${fmt(amt + tax.onCost)} — reduces this deal's net and this month's profit.`);
      if (tax.credit) eff.push(`${fmt(gi)} GST on it becomes input credit, not a cost.`);
    } else {
      const pid = sideParty(d, v.bear);
      if (!pid) return need(`This deal has no ${v.bear} yet — add one on the deal, or choose "Company".`);
      lines.push({ acc: '1100', dr: total, party: pid, deal: d.id });
      eff.push(`${fmt(total)} paid on behalf of ${esc(pname(pid))} — <b>recoverable</b>, not your expense. It joins their settlement and your chase list.`);
    }

    if (v.how === 'bill') {
      const vid = pidOf(v.vendor);
      if (!vid) return need('Name the vendor you owe.');
      lines.push({ acc: '2000', cr: total, party: vid });
      eff.push(`You owe ${esc(pnameOf(v.vendor))} ${fmt(total)} — a bill is opened against them, due ${v.dueDate || 'in 30 days'}.`);
      docs.push(billDoc(v, {
        partyId: vid, vendorName: pnameOf(v.vendor), desc: `${v.what || 'Deal cost'} — ${dealLabel(d)}`,
        acc: v.bear === 'self' ? (v.acc || '5045') : '1100', taxable: amt, gst: gi, total, dealId: d.id, dueDate: v.dueDate || null,
      }));
    } else {
      lines.push({ acc: v.how || '1000', cr: total });
      eff.push(`${fmt(total)} leaves ${A[v.how || '1000'].name}.`);
    }

    return { desc: `${v.what || 'Deal cost'} — ${dealLabel(d)}`, lines, effects: eff, docs, selfInvoice: selfInvoiceOf(v, amt, rcm.tax, pnameOf(v.vendor)) };
  },
};

EV.invoice = {
  title: 'Raise a brokerage invoice', group: 'Deals', dir: 'in',
  when: 'Raise this when a side\'s brokerage falls due under your agreement — for most deals, the day the sale deed registers; for a staged fee, on each milestone. <b>This is when income exists</b> and when the GST becomes payable, whether or not the client has paid. Any token held from this client comes off the bill and an invoice is numbered for you. One invoice per side, or more if the fee is staged. Raising it does not change the deal\'s status — use "Deal registered" for that.',
  fields: v => [
    F('date', 'Invoice date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealOpts() }),
    F('from', 'Who is paying you', 'select', { opts: partySides(v.deal) }),
    ...gstFields('Brokerage (before GST)', {
      kind: 'output', def: 'yes',
      hint: x => { const d = deal(x.deal); return d ? 'Expected: ' + fmt(x.from === 'buyer' ? d.expBuyer : d.expSeller) : ''; },
    }),
    F('tds', 'TDS % the client deducts', 'number', { def: 0, show: () => tdsOn() }),
    F('adv', 'Token to knock off this bill', 'number', {
      def: 0,
      hint: x => {
        const d = deal(x.deal); const p = d && sideParty(d, x.from);
        if (!p) return '';
        const h = bal('2100', { party: p, deal: x.deal });
        const r = bal('1100', { party: p, deal: x.deal });
        return `Held from this client on this deal: ${fmt(h)}${r ? ` · Recoverable costs already due: ${fmt(r)}` : ''}`;
      },
    }),
    F('recv', 'Balance payment', 'select', {
      opts: [['later', 'Not yet paid — will follow up'], ['now', 'Received now into bank']], def: 'later',
    }),
    F('dueDate', 'Payment due by', 'date', { show: x => x.recv !== 'now', hint: 'Leave blank for 30 days' }),
  ],
  onchange: (k, v) => {
    if (k === 'deal' || k === 'from') {
      const d = deal(v.deal);
      if (d) {
        v.amt = v.from === 'buyer' ? d.expBuyer : d.expSeller;
        const p = sideParty(d, v.from);
        v.adv = p ? bal('2100', { party: p, deal: v.deal }) : 0;
      }
      gstSync('amt', v);
      return;
    }
    gstSync(k, v);
  },
  check: v => {
    const d = deal(v.deal);
    const p = d && sideParty(d, v.from);
    const held = p ? bal('2100', { party: p, deal: v.deal }) : 0;
    return [
      ...dateChecks(v),
      ...(d ? [] : [err('deal', 'Pick the deal')]),
      ...(d && d.status === 'open' ? [warn('deal', 'This deal is not marked registered yet. A tax invoice counts the brokerage as income now and makes the GST payable this month whether or not the client pays — raise it only if this amount is already due under your agreement. If it is not due yet, record a token instead.')] : []),
      ...(d && !p ? [err('from', 'This deal has no such client yet — add them on the Deals tab')] : []),
      ...posAmt(v, 'amt', 'Enter the brokerage'), ...gstChecks(v),
      ...(num(v.adv) > held + 0.005 ? [err('adv', `Only ${fmt(held)} is held from this client`)] : []),
      ...(num(v.adv) < 0 ? [err('adv', 'Enter zero or more')] : []),
      ...(tdsOn() && num(v.tds) > 10 ? [err('tds', 'TDS on brokerage is normally 2% (194H) — check the rate')] : []),
    ];
  },
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Pick a deal.');
    const pid = sideParty(d, v.from);
    if (!pid) return need('No ' + (v.from || 'party') + ' on this deal yet.');
    const base = num(v.amt);
    if (!base) return need('Enter the brokerage amount.');

    const gst = gstOf(v);
    const rate = v.gst === 'yes' ? num(v.gstRate) : 0;
    const total = base + gst;
    const tds = tdsOn() ? Math.round(base * num(v.tds) / 100) : 0;
    const held = bal('2100', { party: pid, deal: d.id });
    const adv = Math.min(num(v.adv), held, r2(total - tds));
    const rem = r2(total - tds - adv);
    const recov = bal('1100', { party: pid, deal: d.id });
    const acc = v.from === 'buyer' ? '4010' : '4000';

    const lines = [{ acc, cr: base, deal: d.id, party: pid }];
    if (gst) lines.push(...outputTaxLines(gst, isIntra(d.propertyState), { deal: d.id }));
    if (tds) lines.push({ acc: '1150', dr: tds, party: pid, deal: d.id });
    if (adv) lines.push({ acc: '2100', dr: adv, party: pid, deal: d.id });
    if (rem > 0.5) {
      lines.push(v.recv === 'now'
        ? { acc: '1000', dr: rem }
        : { acc: '1100', dr: rem, party: pid, deal: d.id });
    }

    const eff = [`Income <b>${fmt(base)}</b> earned this month (${A[acc].name}). Profit goes up by that.`];
    if (gst) eff.push(`${fmt(gst)} GST collected — owed to the government, not yours.`);
    if (adv) eff.push(`${fmt(adv)} token converts to income.`);
    if (tds) eff.push(`${fmt(tds)} TDS withheld by the client — claim it at year-end.`);
    if (rem > 0.5) {
      eff.push(v.recv === 'now'
        ? `${fmt(rem)} into bank.`
        : `${fmt(rem)} now owed by ${esc(pname(pid))}${recov ? ` (plus ${fmt(recov)} recoverable costs = <b>${fmt(rem + recov)}</b> to collect)` : ''}.`);
    }
    if (held - adv > 0.5) eff.push(`${fmt(held - adv)} token still held — settle it separately.`);
    if (gst) eff.push('A GST invoice will be generated and numbered automatically.');

    // Brokerage is a service "directly in relation to immovable property" (IGST Act s.12(3)),
    // so the place of supply is where the PROPERTY is. A Bengaluru buyer of a Chennai flat is
    // charged CGST+SGST; IGST only arises when the property itself is in another state.
    const st = S().settings;
    const placeOfSupply = d.propertyState || st.state;
    const gstSplit = splitGst(base, rate, placeOfSupply, st.state);

    // The invoice's paid figure starts with what was already settled by the token and by a
    // payment received on the spot, so its status is right from the first second.
    const paidNow = adv + tds + (v.recv === 'now' ? rem : 0);

    return {
      desc: `Brokerage — ${dealLabel(d)} (${pname(pid)})`,
      lines, effects: eff,
      invoice: {
        kind: 'brokerage', partyId: pid, dealId: d.id, base, gstRate: rate, placeOfSupply,
        cgst: gstSplit.cgst, sgst: gstSplit.sgst, igst: gstSplit.igst,
        total, paid: r2(Math.min(paidNow, total)), dueDate: v.recv === 'now' ? null : (v.dueDate || addDays(v.date || today(), 30)),
        date: v.date || today(),
      },
    };
  },
};

EV.dealpay = {
  title: 'Client pays what they owe', group: 'Money in', dir: 'in',
  when: 'Money arriving against what a client owes you — an invoice, or costs you recovered on their behalf. The payment is <b>matched to their open invoices</b>, oldest first, so each one shows paid, part-paid or open. Cash goes up, what they owe goes down. <b>Profit does not change</b> — the income was counted when the invoice was raised.',
  fields: v => {
    const p = v.party || null;
    return [
      F('date', 'Date', 'date', { def: today() }),
      F('party', 'Client', 'select', {
        opts: Object.entries(partyBalances('1100')).filter(([, b]) => b > 0.5).map(([id, b]) => [id, `${pname(id)} — owes ${fmt(b)}`]),
        hint: 'Only clients who owe something are listed.',
      }),
      F('amt', 'Amount received', 'number', { required: true, hint: p ? `Owes ${fmt(bal('1100', { party: p }))} in total` : '' }),
      F('tds', 'TDS the client deducted', 'number', {
        def: 0, show: x => !!x.party && tdsOn(),
        hint: 'Deducted under 194H before paying you (2% of the brokerage). It settles that much of the invoice and is claimed at year-end.',
      }),
      F('short', 'Discount you gave them', 'number', {
        def: 0, show: x => !!x.party,
        hint: 'A discount you agreed, a rounding-off, or charges their bank deducted. The invoice closes in full.',
      }),
      F('shortWhy', 'Because', 'select', {
        opts: [['discount', 'A discount or rounding I allowed'], ['charges', 'Bank charges deducted on their side']],
        def: 'discount', show: x => num(x.short) > 0,
      }),
      F('via', 'Received into', 'select', { opts: [['1000', 'Bank (1000)'], ['1010', 'Petty cash (1010)']], def: '1000' }),
      methodField(),
      F('ref', 'Reference', 'text', { hint: 'UPI reference or cheque number — it is what matches this to the bank statement later.' }),
      F('alloc', 'Applied to', 'alloc', { source: 'invoices', partyKey: 'party', show: x => !!x.party }),
      F('over', 'If they paid extra', 'select', {
        opts: [['hold', 'Keep the extra for them'], ['stop', 'Stop me — I will fix the amount']],
        def: 'hold', show: x => num(x.amt) > bal('1100', { party: x.party }) + 0.005,
      }),
    ];
  },
  onchange: (k, v) => {
    if (k === 'party') { v.amt = r2(bal('1100', { party: v.party })); v.alloc = null; }
    if (k === 'amt' || k === 'party' || k === 'short' || k === 'tds') v.alloc = autoAllocInvoices(v);
  },
  check: v => {
    const owed = v.party ? bal('1100', { party: v.party }) : 0;
    const short = num(v.short);
    const tds = Math.max(0, num(v.tds));
    const applied = num(v.amt) + short + tds;
    const allocSum = (v.alloc || []).reduce((a, r) => a + num(r.amt), 0);
    return [
      ...dateChecks(v),
      ...(v.party ? [] : [err('party', 'Pick who is paying')]),
      ...(v.party && owed <= 0.5 ? [err('party', 'They owe nothing right now — money received ahead of a deal is a token; record it as one')] : []),
      ...posAmt(v, 'amt', 'Enter what was received'),
      ...(short < 0 ? [err('short', 'Enter zero or more')] : []),
      ...(num(v.tds) < 0 ? [err('tds', 'Enter zero or more')] : []),
      ...(tds > 0 && tds > owed - num(v.amt) + 0.005 ? [err('tds', `TDS cannot exceed what is left — ${fmt(Math.max(0, owed - num(v.amt)))}`)] : []),
      ...(short > 0 && short > owed - num(v.amt) - tds + 0.005 ? [err('short', `You can only let them off what is left — ${fmt(Math.max(0, owed - num(v.amt) - tds))}`)] : []),
      ...(num(v.amt) > owed + 0.005 && v.over === 'stop' ? [err('amt', `They only owe ${fmt(owed)} — reduce the amount, or hold the extra as an advance`)] : []),
      ...(allocSum > applied + 0.005 ? [err('alloc', 'You have split more than you received — lower one of the amounts')] : []),
      ...(openInvoices(v.party).length
        && allocSum + 0.005 < Math.min(applied, owed, openInvoices(v.party).reduce((a, i) => a + invoiceOutstanding(i), 0))
        && v.over !== 'hold'
        ? [err('alloc', 'Apply the whole payment to their invoices, or choose to hold the rest for them')] : []),
    ];
  },
  build: v => {
    const pid = v.party;
    if (!pid) return need('Pick who is paying.');
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount received.');
    const owed = bal('1100', { party: pid });
    // TDS the client withheld settles that much of the invoice too — it is money you will
    // recover from the government at year-end, sitting in 1150 against this client.
    const tds = r2(Math.min(Math.max(0, num(v.tds)), Math.max(0, owed - amt)));
    // What you let them off closes the invoice as well; it is a cost — a discount allowed, or
    // charges their bank took — and the GST on the invoice stands.
    const short = r2(Math.min(Math.max(0, num(v.short)), Math.max(0, owed - amt - tds)));
    const applied = Math.min(amt + tds + short, owed);
    const extra = r2(amt - Math.max(0, applied - short - tds));
    const rows = (v.alloc || []).filter(r => num(r.amt) > 0);
    const lines = [cashLine(v, { acc: v.via || '1000', dr: amt })];
    if (tds > 0.005) lines.push({ acc: '1150', dr: tds, party: pid });
    if (short > 0.005) lines.push({ acc: v.shortWhy === 'charges' ? '5140' : '5225', dr: short, party: pid });
    // One receivable line per allocated invoice keeps the deal tags right on the ledger.
    let tagged = 0;
    for (const r of rows) {
      const inv = S().invoices.find(i => i.id === r.id);
      const a = Math.min(num(r.amt), applied - tagged);
      if (a <= 0.005) continue;
      lines.push({ acc: '1100', cr: a, party: pid, deal: inv?.dealId || undefined });
      tagged = r2(tagged + a);
    }
    if (applied - tagged > 0.005) lines.push({ acc: '1100', cr: r2(applied - tagged), party: pid });
    if (extra > 0.005) {
      // Tag the surplus with a deal the client is on, otherwise "Settle a token" — which
      // only lists deals holding money — could never reach it again.
      const lastDeal = rows.map(r => S().invoices.find(i => i.id === r.id)?.dealId).filter(Boolean).at(-1);
      const anyDeal = S().deals.find(d => d.seller?.partyId === pid || d.buyer?.partyId === pid)?.id;
      const tag = lastDeal || anyDeal;
      lines.push({ acc: '2100', cr: extra, party: pid, ...(tag ? { deal: tag } : {}) });
    }

    const eff = [`Cash in ${fmt(amt)}. What ${esc(pname(pid))} owes drops by ${fmt(applied)}.${short ? '' : ' Profit unchanged.'}`];
    if (tds > 0.005) eff.push(`${fmt(tds)} TDS withheld by the client — settles that much of the invoice; claim it at year-end.`);
    if (short) eff.push(`${fmt(short)} you let them off — ${v.shortWhy === 'charges' ? 'booked as bank charges' : 'booked as a discount allowed'}; the invoice still closes in full.`);
    rows.forEach(r => { const inv = S().invoices.find(i => i.id === r.id); if (inv) eff.push(`${fmt(r.amt)} applied to invoice ${esc(inv.invoiceNo)}${num(r.amt) + 0.005 < invoiceOutstanding(inv) ? ' (part)' : ' — now paid'}.`); });
    if (extra > 0.005) eff.push(`${fmt(extra)} more than they owed — held as an advance for them, not income.`);

    return {
      desc: `Payment — ${pname(pid)}`,
      lines, effects: eff,
      allocations: rows.map(r => ({ coll: 'invoices', id: r.id, amt: num(r.amt) })),
    };
  },
};

function autoAllocInvoices(v) {
  if (!v.party) return [];
  const docs = openInvoices(v.party);
  return allocate(num(v.amt) + Math.max(0, num(v.short)) + Math.max(0, num(v.tds)), docs, invoiceOutstanding).rows;
}

EV.settle = {
  title: 'Settle a token — refund / keep / apply', group: 'Deals', dir: 'fix',
  when: 'What happens to a token you are holding. <b>Apply</b> it to the client\'s open invoice on this deal (what they owe drops, no cash moves), <b>refund</b> it (no profit effect), <b>keep</b> it because the client backed out (becomes income now), or move it to another of their deals.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealsWith('2100', x => x > 0.5) }),
    F('from', 'Client', 'select', {
      opts: partySides(v.deal),
      hint: x => { const d = deal(x.deal); const p = d && sideParty(d, x.from); return p ? 'Held: ' + fmt(bal('2100', { party: p, deal: x.deal })) : ''; },
    }),
    F('apply', 'Apply to their open invoice', 'number', {
      def: 0,
      show: x => { const d = deal(x.deal); const p = d && sideParty(d, x.from); return !!(p && openInvoices(p, x.deal).length); },
      hint: x => { const d = deal(x.deal); const p = d && sideParty(d, x.from); const inv = p && openInvoices(p, x.deal)[0]; return inv ? `${inv.invoiceNo} has ${fmt(invoiceOutstanding(inv))} open` : ''; },
    }),
    F('refund', 'Refund to client', 'number', { def: 0 }),
    F('via', 'Refund from', 'select', { opts: [['1000', 'Bank / UPI'], ['1010', 'Petty cash']], def: '1000', show: x => num(x.refund) > 0 }),
    F('keep', 'Keep as income (client agreed / non-refundable)', 'number', { def: 0 }),
    F('gst', 'GST % on the kept amount', 'number', { def: 0, show: x => num(x.keep) > 0, hint: 'Most forfeited advances are compensation, not a sale, so no GST is due (CBIC Circular 178/10/2022). Enter a rate only if your CA says this one is taxable.' }),
    F('move', 'Move remainder to another deal', 'select', {
      opts: x => [['', 'No — keep holding on this deal'],
      ...S().deals.filter(d => d.id !== x.deal && d.status !== 'cancelled').map(d => [d.id, dealLabel(d)])],
    }),
    F('drop', 'Mark this deal cancelled?', 'select', { opts: [['no', 'No'], ['yes', 'Yes — deal is off']], def: 'no' }),
  ],
  check: v => {
    const d = deal(v.deal); const p = d && sideParty(d, v.from);
    const held = p ? bal('2100', { party: p, deal: v.deal }) : 0;
    return [
      ...dateChecks(v),
      ...(d ? [] : [err('deal', 'Pick the deal holding the token')]),
      ...(num(v.refund) + num(v.keep) + num(v.apply) > held + 0.005 ? [err('refund', `Only ${fmt(held)} is held`)] : []),
      ...((() => { const inv = p && openInvoices(p, v.deal)[0]; return inv && num(v.apply) > invoiceOutstanding(inv) + 0.005 ? [err('apply', `Only ${fmt(invoiceOutstanding(inv))} is open on ${inv.invoiceNo}`)] : []; })()),
      ...(num(v.apply) < 0 ? [err('apply', 'Enter zero or more')] : []),
      ...(num(v.refund) <= 0 && num(v.keep) <= 0 && num(v.apply) <= 0 && !v.move ? [err('refund', 'Enter an amount to apply, refund or keep, or a deal to move it to')] : []),
      ...(num(v.refund) > 0 && (v.via || '1000') === '1010' ? pettyCheck('via', v, num(v.refund)) : []),
    ];
  },
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('No deal is holding a token.');
    const pid = sideParty(d, v.from);
    if (!pid) return need('Pick the client.');
    const held = bal('2100', { party: pid, deal: d.id });
    const lines = [], eff = [], allocations = [];

    // Applied first: this is the normal end of a token once the invoice exists, and until now
    // there was no way back from money held (2100) to the invoice it was meant for.
    const inv = openInvoices(pid, d.id)[0];
    const apply = inv ? r2(Math.min(Math.max(0, num(v.apply)), held, invoiceOutstanding(inv))) : 0;
    if (apply > 0.005) {
      lines.push({ acc: '2100', dr: apply, party: pid, deal: d.id }, { acc: '1100', cr: apply, party: pid, deal: d.id });
      allocations.push({ coll: 'invoices', id: inv.id, amt: apply });
      eff.push(`${fmt(apply)} applied to invoice ${esc(inv.invoiceNo)} — what ${esc(pname(pid))} owes drops by that. No cash moves, profit unchanged.`);
    }
    const ref = Math.min(num(v.refund), held - apply);
    const keep = Math.min(num(v.keep), held - apply - ref);
    const rest = held - apply - ref - keep;

    if (ref) {
      lines.push({ acc: '2100', dr: ref, party: pid, deal: d.id }, { acc: v.via || '1000', cr: ref });
      eff.push(`Refund ${fmt(ref)} — cash out, profit untouched.`);
    }
    if (keep) {
      const base = keep / (1 + num(v.gst) / 100);
      const g = keep - base;
      lines.push({ acc: '2100', dr: keep, party: pid, deal: d.id },
        { acc: '4030', cr: base, deal: d.id, party: pid });
      if (g > 0.5) lines.push(...outputTaxLines(g, isIntra(d.propertyState), { deal: d.id }));
      eff.push(`Keep ${fmt(keep)} → <b>income ${fmt(base)}</b> this month${g > 0.5 ? ' + ' + fmt(g) + ' GST' : ''}. No cash moves.`);
    }
    if (rest > 0.5) {
      if (v.move) {
        const t = deal(v.move);
        lines.push({ acc: '2100', dr: rest, party: pid, deal: d.id },
          { acc: '2100', cr: rest, party: pid, deal: t.id });
        eff.push(`${fmt(rest)} moves to "${esc(dealLabel(t))}" — still held, still not income.`);
      } else {
        eff.push(`${fmt(rest)} stays held on this deal.`);
      }
    }
    if (!lines.length) return need('Enter an amount to apply, refund or keep.');

    const updates = [];
    if (v.drop === 'yes') updates.push({ coll: 'deals', id: d.id, data: { status: 'cancelled' } });

    // When the forfeiture is taxed it is an outward supply, so it needs a numbered document
    // or the month's GSTR-1 will not tie back to the tax in the ledger.
    const keepBase = keep ? r2(keep / (1 + num(v.gst) / 100)) : 0;
    const keepTax = r2(keep - keepBase);
    const st = S().settings;
    const pos = d.propertyState || st.state;
    const split = gstHeads(keepTax, isIntra(pos));
    return {
      desc: `Token settled — ${dealLabel(d)} (${pname(pid)})`,
      lines, effects: eff, updates, allocations,
      invoice: keepTax > 0.5 ? {
        kind: 'forfeit', partyId: pid, dealId: d.id, base: keepBase, gstRate: num(v.gst),
        cgst: split.cgst, sgst: split.sgst, igst: split.igst, total: r2(keep),
        paid: r2(keep), dueDate: null, placeOfSupply: pos,
        sac: st.sacCodes?.brokerage || '997221',
        desc: 'Advance forfeited — ' + dealLabel(d), date: v.date || today(),
      } : null,
    };
  },
};

EV.writeoff = {
  title: 'Write off what a client will never pay', group: 'Corrections', dir: 'fix',
  when: 'After real effort to collect. Removes the receivable and books the loss, so your books stop claiming money you do not have. If a GST invoice was raised, your CA may also issue a credit note — ask.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealsWith('1100', x => x > 0.5) }),
    F('from', 'Client', 'select', {
      opts: partySides(v.deal),
      hint: x => { const d = deal(x.deal); const p = d && sideParty(d, x.from); return p ? 'Owes: ' + fmt(bal('1100', { party: p, deal: x.deal })) : ''; },
    }),
    F('amt', 'Amount', 'number', { required: true }),
    F('why', 'Reason (kept for audit)', 'text', { required: true }),
  ],
  check: v => {
    const d = deal(v.deal); const p = d && sideParty(d, v.from);
    const owed = p ? bal('1100', { party: p, deal: v.deal }) : 0;
    return [
      ...dateChecks(v),
      ...(d ? [] : [err('deal', 'Pick the deal')]),
      ...posAmt(v),
      ...(num(v.amt) > owed + 0.005 ? [err('amt', `They only owe ${fmt(owed)} on this deal`)] : []),
      ...(String(v.why || '').trim() ? [] : [err('why', 'Write the reason — an auditor will ask')]),
    ];
  },
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Nothing outstanding to write off.');
    const pid = sideParty(d, v.from);
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount to write off.');
    // Close the invoices it relates to, oldest first, so they leave the chase list. The
    // allocation carries this entry's id, so the document shows what settled it and why.
    const closing = allocate(amt, openInvoices(pid, d.id), invoiceOutstanding).rows;
    return {
      desc: `Write-off — ${dealLabel(d)} (${pname(pid)})${v.why ? ': ' + v.why : ''}`,
      lines: [{ acc: '5190', dr: amt, deal: d.id }, { acc: '1100', cr: amt, party: pid, deal: d.id }],
      effects: [
        `Loss ${fmt(amt)} this month. Keep evidence of your follow-ups.`,
        closing.length ? `${closing.length} invoice${closing.length === 1 ? '' : 's'} closed — they leave the chase list.` : '',
      ].filter(Boolean),
      allocations: closing.map(r => ({ coll: 'invoices', id: r.id, amt: num(r.amt), writtenOff: true })),
    };
  },
};

EV.absorb = {
  title: 'Client will not repay a cost you paid', group: 'Corrections', dir: 'fix',
  when: 'You paid something for the client and they will not pay it back. Moves it from "recoverable" to your own deal expense.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealsWith('1100', x => x > 0.5) }),
    F('from', 'Client', 'select', {
      opts: partySides(v.deal),
      hint: x => { const d = deal(x.deal); const p = d && sideParty(d, x.from); return p ? 'Owed by them on this deal: ' + fmt(bal('1100', { party: p, deal: x.deal })) : ''; },
    }),
    F('amt', 'Amount to absorb', 'number', { required: true }),
  ],
  check: v => {
    const d = deal(v.deal); const p = d && sideParty(d, v.from);
    const owed = p ? bal('1100', { party: p, deal: v.deal }) : 0;
    return [...dateChecks(v), ...(d ? [] : [err('deal', 'Pick the deal')]), ...posAmt(v),
      ...(num(v.amt) > owed + 0.005 ? [err('amt', `Only ${fmt(owed)} is recoverable on this deal`)] : [])];
  },
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Pick a deal.');
    const pid = sideParty(d, v.from);
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    const closing = allocate(amt, openInvoices(pid, d.id), invoiceOutstanding).rows;
    return {
      desc: `Absorbed cost — ${dealLabel(d)}`,
      lines: [{ acc: '5045', dr: amt, deal: d.id }, { acc: '1100', cr: amt, party: pid, deal: d.id }],
      effects: [`${fmt(amt)} becomes your deal expense. Receivable from ${esc(pname(pid))} drops.`],
      allocations: closing.map(r => ({ coll: 'invoices', id: r.id, amt: num(r.amt), writtenOff: true })),
    };
  },
};

// ═══════ SERVICES ═══════
//
// A subscription is a COMMITMENT: an expected charge each month, with a dated history of plan
// changes. Each month produces a DOCUMENT — the vendor's bill, whether it was auto-charged to
// a card or invoiced for later payment — and the difference between expected and actual is
// recorded with a reason. That is what lets the Services tab show, month by month, what you
// expected, what you were billed, what you paid, and why they differ.

const activeMonthly = () => S().subs.filter(s => s.payMode === 'monthly' && s.status === 'active');

EV.subnew = {
  title: 'Add a recurring cost', group: 'Recurring', dir: 'setup',
  when: 'Sets the <b>expected</b> charge. Nothing is posted for a monthly plan until you record a month\'s bill or charge. An upfront plan is paid once now and its cost is released month by month at month-end.',
  fields: () => [
    F('date', 'Start date', 'date', { def: today() }),
    F('kind', 'What is it', 'select', { opts: RECURRING_KINDS.map(k => [k[0], k[1]]), def: 'service' }),
    F('name', 'Name', 'text', { required: true, hint: x => ({ rent: 'e.g. Office rent — Anna Nagar', salary: 'e.g. Priya — retainer', utility: 'e.g. TNEB, Airtel' })[x.kind] || 'e.g. Claude Pro, Zoho CRM, Meta ads' }),
    F('plan', 'Plan', 'text', { hint: 'e.g. Pro, Max, Team — optional', show: x => (x.kind || 'service') === 'service' }),
    F('vendor', 'Who you pay', 'party', { partyType: 'vendor', hint: 'Bills are raised against them, so name them.' }),
    F('acc', 'Posts to', 'select', {
      opts: expOpts(), def: '5080',
      hint: 'The expense account every month of this goes to. Set from what it is; change it if you know better.',
    }),
    F('use', 'What for', 'text'),
    F('payMode', 'How it is paid', 'select', {
      opts: [['monthly', 'Charged every month'], ['upfront', 'Paid upfront for a term']], def: 'monthly',
    }),
    F('billing', 'How does it reach you each month', 'select', {
      opts: [['auto', 'Auto-charged to a card / bank'], ['invoice', 'Invoiced, and I pay it']], def: 'auto',
      show: x => x.payMode !== 'upfront',
    }),
    ...rcmFields(x => x.payMode === 'upfront', { def: 'import' }),
    ...gstFields('Amount', {
      kind: 'input',
      hint: x => x.payMode === 'upfront' ? 'Total paid upfront, before GST' : 'Expected per month, before GST (pay-as-you-go: your best estimate)',
      gstShow: x => x.payMode === 'upfront' && x.rcm !== 'yes',
    }),
    F('months', 'Term (months)', 'number', { def: 12, show: x => x.payMode === 'upfront' }),
    F('via', 'Paid from', 'select', { opts: PAY_VIA, def: '1000' }),
  ],
  onchange: (k, v) => {
    gstSync(k, v);
    if (k === 'kind') v.acc = RECURRING_KINDS.find(x => x[0] === v.kind)?.[2] || '5080';
  },
  check: v => [
    ...dateChecks(v),
    ...(String(v.name || '').trim() ? [] : [err('name', 'Give it a name')]),
    ...partyReq(v, 'vendor', 'Name the vendor — every bill is raised against them'),
    ...posAmt(v),
    ...(v.payMode === 'upfront' ? [...(v.rcm === 'yes' ? [] : gstChecks(v)), ...rcmChecks(v), ...(num(v.months) >= 1 ? [] : [err('months', 'Term must be at least one month')])] : []),
    ...(v.payMode === 'upfront' && v.via === '1010' ? pettyCheck('via', v, num(v.amt) + gstOf(v)) : []),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    if (!String(v.name || '').trim()) return need('Name the service.');
    const up = v.payMode === 'upfront';
    const m = up ? Math.max(1, num(v.months)) : 1;
    const monthly = up ? r2(amt / m) : amt;
    const rcm = up ? rcmLines(amt, v) : { tax: 0, lines: [] };
    const gi = up && v.rcm !== 'yes' ? gstOf(v) : 0;
    const start = ym(v.date || today());
    const lines = [];
    if (up) {
      lines.push({ acc: '1200', dr: amt });
      if (gi) lines.push(...inputTaxLines(gi, (v.gstType || 'intra') !== 'inter'));
      lines.push(...rcm.lines);
      lines.push({ acc: v.via || '1000', cr: amt + gi });
    }

    return {
      desc: up ? `Subscription paid upfront — ${v.name}` : '',
      lines,
      effects: up
        ? [`Cash out ${fmt(amt + gi)} now — but it is <b>not</b> all this month's cost.`,
        `Cost ${fmt(monthly)}/month for ${m} months, released automatically at each month-end.`,
        gi ? `${fmt(gi)} GST becomes input credit.` : '',
        rcm.tax ? `${fmt(rcm.tax)} IGST under reverse charge — paid with the month's return, then claimed back. Not owed to the vendor.` : '']
          .filter(Boolean)
        : [`Expected ${fmt(amt)}/month from ${mlabel(start)}${v.billing === 'invoice' ? ', billed each month' : ', auto-charged'}, posting to ${A[v.acc || recurringAcc(v)]?.name || 'Software & subscriptions'}.`,
        'Nothing is posted yet. Each month you record what was actually billed — the amount, and why it differs if it does.'],
      docs: [{
        coll: 'subscriptions',
        data: {
          kind: v.kind || 'service', acc: v.acc || recurringAcc(v),
          name: v.name, plan: v.plan || '', vendor: pnameOf(v.vendor), vendorId: pidOf(v.vendor), use: v.use || '',
          payMode: v.payMode || 'monthly', billing: up ? 'upfront' : (v.billing || 'auto'),
          amount: amt, monthly, via: v.via || '1000',
          start, end: up ? addMonths(start, m - 1) : null, months: m,
          history: [{ from: start, amount: monthly, plan: v.plan || '' }],
          amortized: [], charges: {}, status: 'active', hasTxns: up,
        },
      }],
    };
  },
};

const VARIANCE_REASONS = [
  ['prorate', 'Plan changed mid-month — prorated'],
  ['usage', 'Usage-based — varies every month'],
  ['price', 'Vendor changed the price'],
  ['discount', 'Discount or credit applied'],
  ['fx', 'Foreign currency — exchange rate moved'],
  ['other', 'Other'],
];

EV.confirmcharge = {
  title: "Recurring — record this month", group: 'Recurring', dir: 'out',
  when: 'What the vendor actually billed for the month — auto-charged to your card, or invoiced for you to pay. Enter the real amount. If it differs from what you expected, say why; if the plan is changing, set the new expected amount here and the months ahead update. For a vendor abroad (Anthropic, Google, Meta billed from outside India) switch on reverse charge: they charge no Indian GST, you pay IGST with the return and claim it back.',
  fields: v => {
    const s = S().subs.find(x => x.id === v.sub);
    const expected = s ? expectedFor(s, v.month || ym(today())) : 0;
    const differs = x => s && x.result !== 'skipped' && Math.abs(num(x.amt) - expectedFor(s, x.month || ym(today()))) > 0.5;
    return [
      F('sub', 'Service', 'select', {
        opts: activeMonthly().map(x => [x.id, `${x.name}${x.plan ? ' (' + x.plan + ')' : ''} — expected ${fmt(expectedFor(x, v.month || ym(today())))}`]),
      }),
      F('month', 'For the month', 'month', { def: ym(today()) }),
      F('date', 'Billed / charged on', 'date', { def: today() }),
      F('result', 'What happened', 'select', {
        opts: [
          ['paid', 'Paid — the money has already gone out'],
          ['invoice', 'Not paid yet — put it on Owed'],
          ['skipped', 'Skipped — nothing charged'],
        ], def: s?.billing === 'invoice' ? 'invoice' : 'paid',
      }),
      // A commitment recorded before vendors were records can name its vendor here, once,
      // and it is stored back so it never has to be asked again.
      F('vendor', 'Who you pay', 'party', { partyType: 'vendor', show: () => !!s && !s.vendorId, hint: 'This one was added without a vendor record. Name them once and it is remembered.' }),
      F('via', 'Paid from', 'select', { opts: PAY_VIA, def: s?.via || '1000', show: x => x.result === 'paid' }),
      methodField('via', { show: x => x.result === 'paid' }),
      F('dueDate', 'Due on', 'date', { show: x => x.result === 'invoice', hint: 'Leave blank for 30 days' }),
      ...gstFields('Actual amount (before GST)', {
        kind: 'input', show: x => x.result !== 'skipped', gstShow: x => x.rcm !== 'yes',
        hint: () => expected ? `Expected ${fmt(expected)} this month` : '',
      }),
      ...rcmFields(x => x.result !== 'skipped', { def: (s?.kind || 'service') === 'service' ? 'import' : 'intra' }),
      F('tds', 'TDS section', 'select', { opts: TDS_SECTIONS.map(t => [t[0], t[1]]), show: x => tdsOn() && x.result !== 'skipped' }),
      F('tdsrate', 'TDS %', 'number', { def: 0, show: x => tdsOn() && x.result !== 'skipped' && x.tds && x.tds !== 'none' }),
      F('reason', 'Why it differs from what you expected', 'select', { opts: VARIANCE_REASONS, def: 'usage', show: x => differs(x) || x.result === 'skipped' }),
      F('note', 'Note', 'text', { show: x => differs(x) || x.result === 'skipped', hint: 'One line, e.g. "upgraded to Max on the 14th"' }),
      F('newPlan', 'Does the expected amount change from here?', 'select', {
        opts: [['no', 'No — same plan continues'], ['yes', 'Yes — new plan or price from a given month']], def: 'no',
        show: x => x.result !== 'skipped',
      }),
      F('newAmount', 'New expected amount per month (before GST)', 'number', { show: x => x.newPlan === 'yes' }),
      F('newPlanName', 'New plan name', 'text', { show: x => x.newPlan === 'yes', hint: 'e.g. Max' }),
      F('newFrom', 'From month', 'month', { def: addMonths(v.month || ym(today()), 1), show: x => x.newPlan === 'yes' }),
    ];
  },
  onchange: (k, v) => {
    if (k === 'sub' || k === 'month') {
      const s = S().subs.find(x => x.id === v.sub);
      if (s && (k === 'sub' || v.amt === undefined || v.amt === '')) v.amt = expectedFor(s, v.month || ym(today()));
      if (s && k === 'sub') { v.via = s.via || '1000'; v.result = s.billing === 'invoice' ? 'invoice' : 'paid'; }
      gstSync('amt', v);
      return;
    }
    if (k === 'tds') { const t = TDS_SECTIONS.find(x => x[0] === v.tds); if (t) v.tdsrate = t[2]; }
    gstSync(k, v);
  },
  check: v => {
    const s = S().subs.find(x => x.id === v.sub);
    const month = v.month || '';
    const already = s?.charges?.[month];
    const out = [
      ...(s ? [] : [err('sub', 'Pick the service')]),
      ...(month ? [] : [err('month', 'Pick the month')]),
      ...(s && month && month < s.start ? [err('month', `${s.name} only started in ${mlabel(s.start)}`)] : []),
      ...(already && !already.skipped && !already.reversed ? [err('month', `${mlabel(month)} is already recorded for this service (${fmt(already.actual)}). Reverse that entry first if it was wrong.`)] : []),
      ...(v.result === 'skipped' ? [] : [...dateChecks(v), ...posAmt(v, 'amt', 'Enter what was actually billed'), ...(v.rcm === 'yes' ? [] : gstChecks(v)), ...rcmChecks(v)]),
      ...(v.result === 'paid' && v.via === '1010' ? pettyCheck('via', v, num(v.amt) + gstOf(v)) : []),
      ...(v.result === 'invoice' && !s?.vendorId && !pidOf(v.vendor) ? [err('vendor', 'Name who you pay — the amount has to be owed to someone')] : []),
      ...(tdsOn() && v.tds && v.tds !== 'none' && !s?.vendorId && !pidOf(v.vendor) ? [err('vendor', 'TDS is deducted from someone — name them')] : []),
    ];
    if (v.newPlan === 'yes') {
      if (!(num(v.newAmount) > 0)) out.push(err('newAmount', 'Enter the new monthly amount'));
      if (!v.newFrom) out.push(err('newFrom', 'Pick the month it starts'));
      else if (month && v.newFrom < month) out.push(err('newFrom', 'A new plan cannot start before the month you are recording'));
    }
    return out;
  },
  build: v => {
    const s = S().subs.find(x => x.id === v.sub);
    if (!s) return need('Pick a service.');
    const month = v.month || ym(today());
    const expected = expectedFor(s, month);
    const label = `${s.name}${s.plan ? ' (' + s.plan + ')' : ''}`;

    // A plan change is described once and applied by the same save, whatever the result was.
    const updates = [];
    const eff = [];
    let history = s.history || [{ from: s.start, amount: num(s.monthly), plan: s.plan || '' }];
    if (v.newPlan === 'yes' && num(v.newAmount) > 0 && v.newFrom) {
      history = [...history.filter(h => h.from !== v.newFrom), { from: v.newFrom, amount: num(v.newAmount), plan: v.newPlanName || s.plan || '' }]
        .sort((a, b) => a.from.localeCompare(b.from));
      eff.push(`From ${mlabel(v.newFrom)} the expected charge becomes <b>${fmt(num(v.newAmount))}</b>/month${v.newPlanName ? ' (' + esc(v.newPlanName) + ')' : ''}. Months before that keep their old expectation.`);
    }
    const planPatch = v.newPlan === 'yes' && num(v.newAmount) > 0 && v.newFrom
      ? { history, monthly: num(v.newAmount), plan: v.newPlanName || s.plan || '' } : {};
    // planPatch is also where a late-named vendor is stored back onto the commitment.

    if (v.result === 'skipped') {
      updates.push({ coll: 'subscriptions', id: s.id, data: { [`charges.${month}`]: { actual: 0, expected, skipped: true, reason: v.reason || null, note: v.note || '' }, ...planPatch } });
      return {
        desc: '', lines: [],
        effects: [`${esc(label)} marked not charged for ${mlabel(month)}. Nothing is posted; the run-rate is unchanged.`, ...eff],
        updates,
      };
    }

    const amt = num(v.amt);
    if (!amt) return need('Enter the actual amount billed.');
    const acc = recurringAcc(s);
    const vendorId = s.vendorId || pidOf(v.vendor) || null;
    const vendorName = s.vendorId ? s.vendor : (v.vendor ? pnameOf(v.vendor) : s.vendor);
    const rcm = rcmLines(amt, v);
    const gi = v.rcm === 'yes' ? 0 : gstOf(v);
    // No vendor invoice number means no tax invoice yet, so the credit is not available.
    const parkGst = v.result === 'invoice' && !v.vinv;
    const tax = inputTax(acc, gi, v, { parked: parkGst });
    const tds = tdsOn() && v.tds && v.tds !== 'none' ? Math.round(amt * num(v.tdsrate) / 100) : 0;
    const total = amt + gi;
    const diff = r2(amt - expected);
    const reason = VARIANCE_REASONS.find(r => r[0] === v.reason)?.[1] || '';

    const lines = [{ acc, dr: amt + tax.onCost }, ...tax.lines, ...rcm.lines];
    if (tds) lines.push({ acc: '2250', cr: tds });
    const docs = [];
    if (v.result === 'paid') {
      lines.push(cashLine(v, { acc: v.via || s.via || '1000', cr: r2(total - tds) }));
      docs.push(billDoc(v, {
        partyId: vendorId, vendorName, desc: `${label} — ${mlabel(month)}`, acc,
        taxable: amt, gst: gi, rcm: rcm.tax, tds, total, net: r2(total - tds), paid: r2(total - tds), status: 'paid', serviceId: s.id, month, dueDate: v.date || today(),
        period: month,
      }));
    } else {
      if (!vendorId) return need('Name who you pay — the amount has to be owed to someone.');
      lines.push({ acc: '2000', cr: r2(total - tds), party: vendorId });
      docs.push(billDoc(v, {
        partyId: vendorId, vendorName, desc: `${label} — ${mlabel(month)}`, acc,
        taxable: amt, gst: gi, rcm: rcm.tax, tds, total, net: r2(total - tds), paid: 0, status: 'open', serviceId: s.id, month, dueDate: v.dueDate || null,
        accrued: !v.vinv, period: month, gstParked: tax.parked,
      }));
    }
    // Store the vendor back on the commitment the first time it is named.
    if (!s.vendorId && vendorId) planPatch.vendorId = vendorId, planPatch.vendor = vendorName;

    updates.push({
      coll: 'subscriptions', id: s.id,
      data: {
        [`charges.${month}`]: {
          actual: amt, gst: gi, rcm: rcm.tax, expected, variance: diff,
          reason: Math.abs(diff) > 0.5 ? (v.reason || 'other') : null, note: v.note || '',
          paid: v.result === 'paid', billId: '$bill', date: v.date || today(),
        },
        hasTxns: true, ...planPatch,
      },
    });

    const varianceLine = Math.abs(diff) > 0.5
      ? `${diff > 0 ? '+' : ''}${fmt(diff)} against the ${fmt(expected)} expected${reason ? ' — ' + esc(reason.toLowerCase()) : ''}.`
      : 'Exactly as expected.';

    return {
      desc: `${label} — ${mlabel(month)}`,
      lines, selfInvoice: selfInvoiceOf(v, amt, rcm.tax, s.vendor),
      effects: [
        `Cost ${fmt(amt + tax.onCost)} for ${mlabel(month)} posted to ${A[acc]?.name || acc} — profit goes down by that. ${varianceLine}`,
        tds ? `${fmt(tds)} TDS withheld — deposit it by the 7th of next month.` : '',
        tax.credit ? `${fmt(gi)} GST becomes input credit.` : '',
        tax.parked ? `${fmt(tax.parked)} GST is held back — it cannot be claimed until the vendor's tax invoice is on record. Record it with "Bill arrived" and the credit is taken in that month.` : '',
        rcm.tax ? `${fmt(rcm.tax)} IGST under reverse charge — paid with the month's return, then claimed back. Not owed to the vendor.` : '',
        v.result === 'paid'
          ? `${fmt(r2(total - tds))} left ${A[v.via || s.via || '1000'].name}. The month's bill is on record as paid.`
          : `${fmt(r2(total - tds))} is now owed to ${esc(vendorName)}, due ${v.dueDate || 'in 30 days'}. It shows on Owed until you pay it — and the payment will be matched to this bill.`,
        ...eff,
      ].filter(Boolean),
      docs, updates,
    };
  },
};

EV.subchange = {
  title: 'Change the expected amount', group: 'Recurring', dir: 'setup',
  when: 'Use this when a plan changes and there is <b>no bill to record right now</b> — you know from next month the price is different. When there IS a bill (a prorated invoice, say), record it with "Service — record this month\'s bill" and set the new plan there instead. For an upfront plan the unused balance is refunded or written off.',
  fields: v => {
    const s = S().subs.find(x => x.id === v.sub);
    return [
      F('from', 'From which month', 'month', { def: addMonths(ym(today()), 1) }),
      F('sub', 'Service', 'select', { opts: S().subs.filter(x => x.status === 'active').map(x => [x.id, `${x.name}${x.plan ? ' (' + x.plan + ')' : ''}`]) }),
      F('plan', 'New plan name', 'text', { hint: 'e.g. Max' }),
      F('payMode', 'New payment', 'select', {
        opts: [['monthly', 'Charged every month'], ['upfront', 'Paid upfront']], def: s?.payMode || 'monthly',
      }),
      ...gstFields('New amount', {
        kind: 'input',
        hint: x => x.payMode === 'upfront' ? 'Total paid upfront now, before GST' : 'New expected amount per month, before GST',
        gstShow: x => x.payMode === 'upfront',
      }),
      F('months', 'Term (months)', 'number', { def: 12, show: x => x.payMode === 'upfront' }),
      F('date', 'Date money moves', 'date', { def: today(), show: x => x.payMode === 'upfront' || s?.payMode === 'upfront' }),
      F('refund', 'Refund of old unused prepaid', 'number', {
        def: 0, show: () => s?.payMode === 'upfront',
        hint: () => s?.payMode === 'upfront' ? 'Unused: ' + fmt(prepaidLeft(s)) : '',
      }),
    ];
  },
  onchange: gstSync,
  check: v => {
    const s = S().subs.find(x => x.id === v.sub);
    return [
      ...(s ? [] : [err('sub', 'Pick the service')]),
      ...(v.from ? [] : [err('from', 'Pick the month the change takes effect')]),
      ...(s && v.from && v.from < s.start ? [err('from', `${s.name} only started in ${mlabel(s.start)}`)] : []),
      ...posAmt(v, 'amt', 'Enter the new amount'),
      ...(v.payMode === 'upfront' ? gstChecks(v) : []),
      ...(v.payMode === 'upfront' || s?.payMode === 'upfront' ? dateChecks(v) : []),
      ...(s?.payMode === 'upfront' && num(v.refund) > prepaidLeft(s) + 0.005 ? [err('refund', `Only ${fmt(prepaidLeft(s))} is unused`)] : []),
    ];
  },
  build: v => {
    const s = S().subs.find(x => x.id === v.sub);
    if (!s) return need('Pick a service.');
    const amt = num(v.amt);
    if (!amt) return need('Enter the new amount.');
    const up = v.payMode === 'upfront';
    const from = v.from || addMonths(ym(today()), 1);
    const lines = [], eff = [];

    // A monthly plan simply gets a new dated expectation — nothing posts until a bill does.
    if (!up && s.payMode !== 'upfront') {
      const history = [...(s.history || [{ from: s.start, amount: num(s.monthly), plan: s.plan || '' }]).filter(h => h.from !== from), { from, amount: amt, plan: v.plan || s.plan || '' }]
        .sort((a, b) => a.from.localeCompare(b.from));
      return {
        desc: '', lines: [],
        effects: [`From ${mlabel(from)} ${esc(s.name)} is expected at <b>${fmt(amt)}</b>/month${v.plan ? ' (' + esc(v.plan) + ')' : ''}. Earlier months keep their old expectation. Nothing is posted until a month's bill is recorded.`],
        updates: [{ coll: 'subscriptions', id: s.id, data: { history, monthly: amt, plan: v.plan || s.plan || '' } }],
      };
    }

    // Anything involving an upfront plan closes the old line and opens a new one, because the
    // prepaid balance has to leave the books correctly.
    const m = up ? Math.max(1, num(v.months)) : 1;
    const monthly = up ? r2(amt / m) : amt;
    const gi = up ? gstOf(v) : 0;
    if (s.payMode === 'upfront') {
      const left = prepaidLeft(s);
      const ref = Math.min(num(v.refund), left);
      const loss = left - ref;
      if (ref) lines.push({ acc: '1000', dr: ref });
      if (loss > 0.5) lines.push({ acc: '5210', dr: loss });
      if (left > 0.5) {
        lines.push({ acc: '1200', cr: left });
        eff.push(`Old plan unused ${fmt(left)}: ${ref ? fmt(ref) + ' refunded' : ''}${ref && loss > 0.5 ? ', ' : ''}${loss > 0.5 ? fmt(loss) + ' lost this month' : ''}.`);
      }
    }
    if (up) {
      lines.push({ acc: '1200', dr: amt });
      if (gi) lines.push(...inputTaxLines(gi, (v.gstType || 'intra') !== 'inter'));
      lines.push({ acc: s.via || '1000', cr: amt + gi });
      eff.push(`New plan ${fmt(amt + gi)} paid upfront → ${fmt(monthly)}/month for ${m} months.`);
    } else {
      eff.push(`Expected ${fmt(amt)}/month from ${mlabel(from)}.`);
    }
    eff.push('The old line closes as "changed" — its history stays intact.');

    return {
      desc: lines.length ? `Plan change — ${s.name} → ${v.plan || 'new plan'}` : '',
      lines, effects: eff,
      updates: [{ coll: 'subscriptions', id: s.id, data: { status: 'changed', end: addMonths(from, -1), closedOut: true } }],
      docs: [{
        coll: 'subscriptions',
        data: {
          name: s.name, plan: v.plan || '', vendor: s.vendor, vendorId: s.vendorId || null, use: s.use,
          payMode: v.payMode || 'monthly', billing: up ? 'upfront' : (s.billing || 'auto'),
          amount: amt, monthly, via: s.via || '1000',
          start: from, end: up ? addMonths(from, m - 1) : null, months: m,
          history: [{ from, amount: monthly, plan: v.plan || '' }],
          amortized: [], charges: {}, status: 'active', parent: s.id, hasTxns: up,
        },
      }],
    };
  },
};

EV.subcancel = {
  title: 'Stop, pause or resume', group: 'Recurring', dir: 'setup',
  when: 'Monthly plans simply stop (or restart) from a month. For an upfront plan the unused balance must leave the books — either refunded, or booked as a loss.',
  fields: v => {
    const s = S().subs.find(x => x.id === v.sub);
    return [
      F('from', 'From which month', 'month', { def: ym(today()) }),
      F('sub', 'Service', 'select', {
        opts: S().subs.filter(x => ['active', 'paused'].includes(x.status)).map(x => [x.id, `${x.name} (${x.status})`]),
      }),
      F('action', 'What do you want to do', 'select', {
        opts: x => S().subs.find(y => y.id === x.sub)?.status === 'paused'
          ? [['resume', 'Resume'], ['cancel', 'Cancel']]
          : [['cancel', 'Cancel'], ['pause', 'Pause']],
      }),
      F('refund', 'Refund received', 'number', {
        def: 0, show: x => s?.payMode === 'upfront' && x.action === 'cancel',
        hint: () => s ? 'Unused: ' + fmt(prepaidLeft(s)) : '',
      }),
      F('date', 'Date', 'date', { def: today(), show: x => s?.payMode === 'upfront' && x.action === 'cancel' }),
    ];
  },
  check: v => {
    const s = S().subs.find(x => x.id === v.sub);
    return [
      ...(s ? [] : [err('sub', 'Pick the service')]),
      ...(v.from ? [] : [err('from', 'Pick the month')]),
      ...(s && v.from && v.from < s.start ? [err('from', `${s.name} only started in ${mlabel(s.start)}`)] : []),
      ...(s?.payMode === 'upfront' && v.action === 'cancel' ? dateChecks(v) : []),
      ...(s?.payMode === 'upfront' && num(v.refund) > prepaidLeft(s) + 0.005 ? [err('refund', `Only ${fmt(prepaidLeft(s))} is unused`)] : []),
    ];
  },
  build: v => {
    const s = S().subs.find(x => x.id === v.sub);
    if (!s) return need('Pick a service.');
    const eff = [], lines = [];
    const when = v.from || ym(today());

    if (v.action === 'resume') {
      // Resuming restores the expectation that was in force before the pause.
      const beforePause = [...(s.history || [])].filter(h => num(h.amount) > 0).sort((a, b) => a.from.localeCompare(b.from)).at(-1);
      const back = beforePause ? num(beforePause.amount) : num(s.monthly);
      const history = [...(s.history || []).filter(h => h.from !== when), { from: when, amount: back, plan: (beforePause?.plan || s.plan || '').replace(' (paused)', '') }]
        .sort((a, b) => a.from.localeCompare(b.from));
      return {
        desc: '', lines: [],
        effects: [`${esc(s.name)} resumes from ${mlabel(when)}. Run-rate goes back up by ${fmt(back)}.`],
        updates: [{ coll: 'subscriptions', id: s.id, data: { status: 'active', end: null, history } }],
      };
    }

    if (v.action === 'cancel' && s.payMode === 'upfront') {
      const left = prepaidLeft(s);
      const ref = Math.min(num(v.refund), left);
      const loss = left - ref;
      if (ref) lines.push({ acc: '1000', dr: ref });
      if (loss > 0.5) lines.push({ acc: '5210', dr: loss });
      if (left > 0.5) lines.push({ acc: '1200', cr: left });
      eff.push(left > 0.5
        ? `Unused ${fmt(left)}: ${ref ? fmt(ref) + ' refunded' : ''}${ref && loss > 0.5 ? ', ' : ''}${loss > 0.5 ? '<b>' + fmt(loss) + ' lost</b> — hits profit this month' : ''}.`
        : 'Nothing left to settle.');
    } else {
      eff.push(`${v.action === 'pause' ? 'Paused' : 'Stopped'} from ${mlabel(when)}. Run-rate drops by ${fmt(expectedFor(s, when))}.`);
    }

    const data = { status: v.action === 'pause' ? 'paused' : 'cancelled', end: addMonths(when, -1) };
    // A pause is a dated expectation of nothing, so the months it covers are not reported as
    // missing when the service later resumes.
    if (v.action === 'pause') {
      data.history = [...(s.history || [{ from: s.start, amount: num(s.monthly), plan: s.plan || '' }])
        .filter(h => h.from !== when), { from: when, amount: 0, plan: (s.plan || '') + ' (paused)' }]
        .sort((a, b) => a.from.localeCompare(b.from));
    }
    if (v.action === 'cancel' && s.payMode === 'upfront') data.closedOut = true;
    return {
      desc: lines.length ? `Cancelled — ${s.name}` : '',
      lines, effects: eff,
      updates: [{ coll: 'subscriptions', id: s.id, data }],
    };
  },
};

// ═══════ MONEY OUT ═══════

EV.expense = {
  title: 'Expense paid now', group: 'Money out', dir: 'out',
  when: 'Rent, EB, fuel, a print job — used and paid in the same moment. <b>If it is a subscription, record it on the Services tab instead</b>, so the month shows against what you expected. Profit goes down by the amount. If it belongs to one particular deal, use "Cost for a deal" instead so it counts against that deal. If you will pay later, use "Bill received".',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('desc', 'What', 'text', { required: true }),
    ...gstFields('Amount (before GST)', { kind: 'input', gstShow: x => x.rcm !== 'yes', refAlways: true }),
    F('acc', 'Category', 'select', { opts: expOpts(), hint: 'The account this cost is posted to.' }),
    F('via', 'Paid from', 'select', { opts: PAY_VIA, def: '1000' }),
    methodField(),
    F('vendor', 'Vendor (optional)', 'party', { partyType: 'vendor', hint: 'Naming them puts this purchase in the GST register against their invoice.' }),
    ...rcmFields(() => true),
    F('tds', 'TDS section', 'select', { opts: TDS_SECTIONS.map(t => [t[0], t[1]]), show: () => tdsOn() }),
    F('tdsrate', 'TDS %', 'number', { def: 0, show: x => tdsOn() && x.tds && x.tds !== 'none' }),
    F('note', 'Note', 'text', { hint: 'Anything you will want to remember — a reference, who asked for it.' }),
  ],
  onchange: (k, v) => {
    gstSync(k, v);
    if (k === 'tds') { const t = TDS_SECTIONS.find(x => x[0] === v.tds); if (t) v.tdsrate = t[2]; }
  },
  check: v => [
    ...dateChecks(v),
    ...(String(v.desc || '').trim() ? [] : [err('desc', 'Say what it was for')]),
    ...(v.acc ? [] : [err('acc', 'Pick a category')]),
    ...posAmt(v), ...(v.rcm === 'yes' ? [] : gstChecks(v)), ...rcmChecks(v),
    ...(tdsOn() && v.tds && v.tds !== 'none' && !pidOf(v.vendor) ? [err('vendor', 'TDS is deducted from someone — name the vendor')] : []),
    ...(v.via === '1010' ? pettyCheck('via', v, num(v.amt) + gstOf(v)) : []),
    ...(v.gst === 'yes' && !pidOf(v.vendor) && !BLOCKED_ITC.has(v.acc) ? [warn('vendor', 'Add the vendor and their GSTIN, or you cannot claim this GST back')] : []),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    if (!v.acc) return need('Pick a category.');
    const rcm = rcmLines(amt, v);
    const gi = v.rcm === 'yes' ? 0 : gstOf(v);
    const tax = inputTax(v.acc, gi, v);
    const vid = pidOf(v.vendor);
    // TDS is withheld from what the vendor receives and deposited for them.
    const tds = tdsOn() && v.tds && v.tds !== 'none' ? Math.round(amt * num(v.tdsrate) / 100) : 0;
    const lines = [{ acc: v.acc, dr: amt + tax.onCost }, ...tax.lines, ...rcm.lines];
    if (tds) lines.push({ acc: '2250', cr: tds });
    lines.push(cashLine(v, { acc: v.via || '1000', cr: r2(amt + gi - tds) }));
    return {
      desc: `${v.desc || A[v.acc].name}${vid ? ' — ' + pnameOf(v.vendor) : ''}`,
      lines,
      selfInvoice: selfInvoiceOf(v, amt, rcm.tax, pnameOf(v.vendor)),
      effects: [
        `Cost ${fmt(amt + tax.onCost)} this month — profit goes down by that.`,
        tds ? `${fmt(tds)} TDS withheld under ${esc(v.tds)} — deposit it by the 7th of next month.` : '',
        rcm.tax ? `${fmt(rcm.tax)} GST is yours to pay under reverse charge — it goes out with the month's return and comes straight back as credit. A self-invoice is numbered for it.` : '',
        tax.credit ? `${fmt(gi)} GST paid on it is claimed as input credit. It reduces your next GST bill, so it is not a cost.` : '',
        tax.onCost ? `${fmt(gi)} GST cannot be claimed on ${A[v.acc].name.toLowerCase()} (blocked credit), so it is part of the cost.` : '',
        `${fmt(r2(amt + gi - tds))} leaves ${A[v.via || '1000'].name}${v.via === '1000' && v.method ? ' by ' + PAY_METHODS.find(m => m[0] === v.method)?.[1] : ''}.`,
        v.via === '2300' ? 'On the card, so the card balance grows. Paying the card bill later is a transfer, not another expense.' : '',
      ].filter(Boolean),
    };
  },
};

EV.bill = {
  title: 'Bill received — pay later', group: 'Money out', dir: 'out',
  when: 'A vendor has billed you and you will pay later. The cost belongs to now and profit goes down now. The bill goes on record with a due date, shows on Owed, and the payment — whenever it comes — is matched to it with "Pay a bill".',
  fields: v => [
    F('date', 'Bill date', 'date', { def: today() }),
    F('vendor', 'Vendor', 'party', { partyType: 'vendor' }),
    F('desc', 'What for', 'text', { required: true }),
    F('acc', 'Category', 'select', { opts: expOpts(), hint: 'The account this cost is posted to.' }),
    F('note', 'Note', 'text', { hint: 'Optional — anything you will want to remember.' }),
    F('dueDate', 'Due on', 'date', { hint: 'Leave blank for 30 days from the bill date' }),
    F('period', 'Which month is this cost for?', 'month', {
      def: ym(v.date || today()),
      hint: 'Last month\'s rent, billed this month, is last month\'s cost. The bill keeps its own date and due date; only the cost moves.',
    }),
    ...rcmFields(() => true),
    ...gstFields('Bill amount (before GST)', { kind: 'input', gstShow: x => x.rcm !== 'yes', refAlways: true }),
    F('tds', 'TDS section', 'select', { opts: TDS_SECTIONS.map(t => [t[0], t[1]]), show: () => tdsOn() }),
    F('tdsrate', 'TDS %', 'number', {
      def: 0, show: () => tdsOn(),
      hint: x => {
        const pid = typeof x.vendor === 'string' ? x.vendor : null;
        const st = S().settings;
        const th = st.tdsThresholds?.[x.tds];
        if (!pid || !th) return 'Auto-filled from the section — verify rates with your CA';
        const fy = fyOf(x.date || today(), st.fyStartMonth);
        return `Billed ${fmt(tdsFyTotal(pid, fy))} by this vendor in FY ${fy}. ${x.tds} applies once ${fmt(th)} is crossed in the year.`;
      },
    }),
  ],
  onchange: (k, v) => {
    gstSync(k, v);
    if (k === 'tds') { const t = TDS_SECTIONS.find(x => x[0] === v.tds); if (t) v.tdsrate = t[2]; }
  },
  check: v => [
    ...dateChecks(v),
    ...partyReq(v, 'vendor', 'Name the vendor'),
    ...(String(v.desc || '').trim() ? [] : [err('desc', 'Say what the bill is for')]),
    ...(v.acc ? [] : [err('acc', 'Pick a category')]),
    ...posAmt(v, 'amt', 'Enter the bill amount'),
    ...(v.rcm === 'yes' ? [] : gstChecks(v)), ...rcmChecks(v),
    ...(v.dueDate && v.dueDate < v.date ? [err('dueDate', 'Due date is before the bill date')] : []),
    ...periodChecks(v),
    ...(tdsOn() && num(v.tdsrate) > 30 ? [err('tdsrate', 'TDS is usually 1, 2 or 10% — check the rate')] : []),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the bill amount.');
    if (!v.acc) return need('Pick a category.');
    const pid = pidOf(v.vendor);
    if (!pid) return need('Name the vendor.');
    const rcm = rcmLines(amt, v);
    const gi = v.rcm === 'yes' ? 0 : gstOf(v);
    const tax = inputTax(v.acc, gi, v);
    const tds = tdsOn() ? Math.round(amt * num(v.tdsrate) / 100) : 0;
    const total = amt + gi;
    const owed = total - tds;

    const lines = [{ acc: v.acc, dr: amt + tax.onCost }, ...tax.lines, ...rcm.lines];
    if (tds) lines.push({ acc: '2250', cr: tds });
    lines.push({ acc: '2000', cr: owed, party: pid });
    const period = v.period || ym(v.date || today());
    const postDate = postDateFor(period, v.date);

    return {
      desc: `${v.desc || A[v.acc].name} — ${pnameOf(v.vendor)}`,
      lines,
      effects: [
        `Cost ${fmt(amt + tax.onCost)} this month — profit goes down by that. No cash has moved yet.`,
        tax.credit ? `${fmt(gi)} GST on the bill becomes input credit${v.gstType === 'inter' ? ' (IGST)' : ' (CGST + SGST)'}.` : '',
        tax.onCost ? `${fmt(gi)} GST cannot be claimed on ${A[v.acc].name.toLowerCase()} (blocked credit), so it is part of the cost.` : '',
        rcm.tax ? `${fmt(rcm.tax)} GST under reverse charge — you pay it in cash with the month's return, and it is your input credit. It is not owed to the vendor and not a cost.` : '',
        `You owe ${esc(pnameOf(v.vendor))} ${fmt(owed)}, due ${v.dueDate || 'in 30 days'}. It shows on the Owed tab until you pay it.`,
        period !== ym(v.date || today())
          ? (postDate === v.date
            ? `This is ${mlabel(period)}'s cost, but ${mlabel(period)} is already closed — so it lands in ${mlabel(ym(v.date || today()))} instead, which is what an accountant would do with a late bill.`
            : `Counted as ${mlabel(period)}'s cost, dated ${postDate} — the month you used it, not the month the bill came.`)
          : '',
        tds ? `${fmt(tds)} TDS withheld, to deposit by the 7th of next month.` : '',
      ].filter(Boolean),
      docs: [billDoc(v, {
        partyId: pid, vendorName: pnameOf(v.vendor), desc: v.desc || A[v.acc].name, acc: v.acc,
        taxable: amt, gst: gi, rcm: rcm.tax, tds, total, net: owed, dueDate: v.dueDate || null,
        period,
      })],
      postDate,
      selfInvoice: selfInvoiceOf(v, amt, rcm.tax, pnameOf(v.vendor)),
    };
  },
};

EV.billarrived = {
  title: 'Bill arrived for a month already recorded', group: 'Money out', dir: 'out',
  when: 'You closed a month on your own figure — last month\'s rent, a service you used — and the vendor\'s bill has now come, usually in the first week with a due date later in the month. Put its number, date and due date against what you already recorded, and correct the amount if the bill differs. <b>The cost stays in the month you used it.</b> Only the paperwork, the due date and any difference are added here.',
  fields: v => {
    const b = S().bills.find(x => x.id === v.billId);
    const blocked = b && BLOCKED_ITC.has(b.acc);
    return [
      F('billId', 'Which one is the bill for', 'select', {
        opts: awaitingBill().map(x => [x.id, `${x.vendorName || pname(x.partyId) || 'Vendor'} — ${x.desc} · ${fmt(billOutstanding(x))}`]),
        hint: 'Only what you recorded without a vendor bill number is listed.',
      }),
      F('vinv', 'Vendor bill number', 'text', { required: true, hint: 'What is printed on their invoice.' }),
      F('date', 'Bill date', 'date', { def: today(), hint: 'The date on the vendor\'s invoice.' }),
      F('dueDate', 'Pay by', 'date', { hint: 'Leave blank for 30 days from the bill date' }),
      F('amt', 'Amount on the bill (before GST)', 'number', {
        hint: () => b ? `You recorded ${fmt(num(b.taxable))}. Change it only if the bill says something else.` : '',
      }),
      F('gstAmt', 'GST on the bill', 'number', {
        def: 0, hint: () => b ? `Recorded with ${fmt(num(b.gst))} GST.${blocked ? ' Credit is blocked on this category, so it stays part of the cost.' : ''}` : '',
      }),
      F('gstType', 'GST type', 'select', {
        opts: [['intra', 'CGST + SGST — vendor in your state'], ['inter', 'IGST — vendor outside your state']], def: 'intra',
        show: x => num(x.gstAmt) !== num(b?.gst || 0),
      }),
      F('note', 'Note', 'text', { hint: 'Anything about the difference you will want to remember.' }),
    ];
  },
  onchange: (k, v) => {
    if (k === 'billId') {
      const b = S().bills.find(x => x.id === v.billId);
      if (b) { v.amt = num(b.taxable); v.gstAmt = num(b.gst); }
    }
  },
  check: v => {
    const b = S().bills.find(x => x.id === v.billId);
    const oldTds = b ? num(b.tds) : 0;
    const oldT = b ? num(b.taxable) : 0;
    const newTds = b && oldT > 0.005 ? r2(num(v.amt) * oldTds / oldT) : oldTds;
    const net = r2(num(v.amt) + num(v.gstAmt) - newTds);
    return [
      ...dateChecks(v),
      ...(b ? [] : [err('billId', 'Pick what the bill is for')]),
      ...(String(v.vinv || '').trim() ? [] : [err('vinv', 'Enter the number printed on their bill')]),
      ...posAmt(v, 'amt', 'Enter what the bill says'),
      ...(v.dueDate && v.dueDate < v.date ? [err('dueDate', 'The due date is before the bill date')] : []),
      ...(b && net + 0.005 < num(b.paid) ? [err('amt', `You have already paid ${fmt(num(b.paid))} against this — the bill cannot be less than that`)] : []),
      ...(b && Math.abs(num(v.amt) - oldT) > Math.max(oldT * 0.5, 5000)
        ? [warn('amt', `That is a long way from the ${fmt(oldT)} you recorded — check you picked the right one`)] : []),
      ...tdsThresholdWarn(b, v),
      ...(b && newTds < oldTds - 0.005 && depositedFor(b)
        ? [warn('amt', `TDS on this bill drops by ${fmt(oldTds - newTds)}, but a deposit for that month is already on record. Adjust it in the next challan rather than the last one.`)] : []),
    ];
  },
  build: v => {
    const b = S().bills.find(x => x.id === v.billId);
    if (!b) return need('Pick what the bill is for.');
    if (!String(v.vinv || '').trim()) return need('Enter the vendor bill number.');
    const oldT = num(b.taxable), oldG = num(b.gst), oldTds = num(b.tds);
    const parked = num(b.gstParked);
    const newT = num(v.amt), newG = num(v.gstAmt);
    const newTds = oldT > 0.005 ? Math.round(newT * oldTds / oldT) : oldTds;
    const dT = r2(newT - oldT), dG = r2(newG - oldG), dTds = r2(newTds - oldTds);
    const blocked = BLOCKED_ITC.has(b.acc);
    const period = b.period || b.month || ym(b.date);
    // Releasing input credit is a statutory date, not a preference: it belongs to the month
    // the tax invoice is dated (s.16(2)). When credit is being released the whole entry takes
    // that date; otherwise the cost goes back to the month it belongs to.
    const releasing = parked > 0.005 && !blocked;
    const postDate = releasing ? (v.date || today()) : postDateFor(period, v.date);
    // A cost that can no longer reach its own month is a prior-period item, and AS 5 wants it
    // disclosed as one rather than buried in this month's rent.
    const inPeriod = ym(postDate) === period;
    const costAcc = inPeriod ? b.acc : '5230';

    const lines = [];
    const put = (acc, amt, party) => {
      if (Math.abs(amt) < 0.005) return;
      lines.push(amt > 0 ? { acc, dr: r2(amt), ...(party ? { party } : {}) } : { acc, cr: r2(-amt), ...(party ? { party } : {}) });
    };
    put(costAcc, r2(dT + (blocked ? dG : 0)));
    if (!blocked) {
      if (releasing) {
        // The held tax comes out of 1405 and the real credit is taken at the invoice amount.
        put('1405', -parked);
        if ((v.gstType || 'intra') === 'inter') put('1402', newG);
        else { put('1400', r2(newG / 2)); put('1401', r2(newG - r2(newG / 2))); }
      } else if (Math.abs(dG) > 0.005) {
        if ((v.gstType || 'intra') === 'inter') put('1402', dG);
        else { put('1400', r2(dG / 2)); put('1401', r2(dG - r2(dG / 2))); }
      }
    }
    put('2250', -dTds);
    put('2000', -r2(dT + dG - dTds), b.partyId);

    const net = r2(newT + newG - newTds);
    const dueDate = v.dueDate || addDays(v.date || today(), 30);
    const changed = Math.abs(dT) > 0.005 || Math.abs(dG) > 0.005;
    return {
      desc: changed
        ? `Bill ${v.vinv} — ${b.desc} (${dT > 0 ? 'more' : 'less'} than recorded)`
        : `Bill ${v.vinv} received — ${b.desc}`,
      lines, postDate,
      updates: [{
        coll: 'bills', id: b.id,
        data: {
          billNo: String(v.vinv).trim(), date: v.date || today(), dueDate,
          taxable: r2(newT), gst: r2(newG), tds: r2(newTds),
          total: r2(newT + newG), net,
          status: docStatus(r2(net - num(b.paid)), net),
          accrued: false, period, gstParked: 0,
        },
      }],
      effects: [
        `Bill ${esc(String(v.vinv).trim())} is now on record against ${esc(b.desc)}, dated ${v.date || today()} and payable by ${dueDate}.`,
        changed
          ? (inPeriod
            ? `The bill is ${fmt(Math.abs(r2(dT + dG)))} ${dT + dG > 0 ? 'more' : 'less'} than you recorded. The difference goes to ${A[b.acc]?.name || b.acc} in ${mlabel(period)} — the month you used it — so ${mlabel(period)}'s profit is now right.`
            : `The bill is ${fmt(Math.abs(r2(dT + dG)))} ${dT + dG > 0 ? 'more' : 'less'} than you recorded, but ${mlabel(period)} can no longer take it${releasing ? ' (the credit has to sit in the month of the invoice)' : ' (that month is closed)'}. The difference is shown separately as a prior-period adjustment in ${mlabel(ym(postDate))}, which is what an accountant would do rather than quietly reopening a closed month.`)
          : 'The amount matches what you recorded, so nothing changes in the books — this only completes the paperwork.',
        releasing ? `${fmt(parked)} of GST was held back until this invoice arrived; ${fmt(newG)} is claimed as input credit in ${mlabel(ym(postDate))}. That is the month it belongs to under s.16(2).` : '',
        !releasing && Math.abs(dG) > 0.005 && !blocked ? `${fmt(Math.abs(dG))} ${dG > 0 ? 'more' : 'less'} GST to claim as input credit.` : '',
        Math.abs(dTds) > 0.005 ? `TDS adjusts by ${fmt(Math.abs(dTds))}.` : '',
        `${fmt(r2(net - num(b.paid)))} is owed and now appears in what is due in ${mlabel(ym(dueDate))}.`,
      ].filter(Boolean),
    };
  },
};

EV.paybill = {
  title: 'Pay a bill', group: 'Money out', dir: 'out',
  when: 'Pays what you owe a vendor. The payment is <b>matched to their open bills</b>, oldest first — you can change the split. Pay less and the bill stays part-paid; pay more and the extra is held as an advance to them. The cost was counted when the bill came in, so <b>profit does not change now</b>.',
  fields: v => {
    const pid = v.party || null;
    const adv = pid ? vendorAdvance(pid) : 0;
    return [
      F('date', 'Date', 'date', { def: today() }),
      F('party', 'Vendor', 'select', {
        opts: vendorsOwed().map(([id, b]) => [id, `${pname(id)} — you owe ${fmt(b)}`]),
        hint: 'Only vendors you owe are listed. A bill has to be recorded first — with "Bill received", a deal cost, or a service month.',
      }),
      F('useAdvance', `Use the ${fmt(adv)} you already paid ahead?`, 'select', {
        opts: [['yes', 'Yes'], ['no', 'No']], def: 'yes', show: () => adv > 0.5,
      }),
      F('amt', 'Amount paid now', 'number', { required: true, hint: pid ? `Total owed ${fmt(bal('2000', { party: pid }))}` : '' }),
      F('short', 'Discount they gave you', 'number', {
        def: 0, hint: 'A discount for paying, a rounding-off, a part they agreed to drop. The bill still closes in full; this part is booked as a discount received and never leaves the bank.',
        show: x => !!x.party,
      }),
      F('via', 'Paid from', 'select', { opts: PAY_VIA, def: '1000' }),
      methodField(),
      F('ref', 'Reference', 'text', { hint: 'UPI reference or cheque number, so this matches the bank statement.' }),
      F('alloc', 'Applied to these bills', 'alloc', { source: 'bills', partyKey: 'party', show: x => !!x.party }),
      F('over', 'If you are paying extra', 'select', {
        opts: [['advance', 'Keep the extra with the vendor for next time'], ['stop', 'Stop me — I will fix the amount']],
        def: 'advance', show: x => x.party && num(x.amt) + (x.useAdvance !== 'no' ? vendorAdvance(x.party) : 0) > bal('2000', { party: x.party }) + 0.005,
      }),
    ];
  },
  onchange: (k, v) => {
    if (k === 'party') { v.amt = r2(Math.max(0, bal('2000', { party: v.party }) - vendorAdvance(v.party))); v.alloc = null; }
    if (k === 'amt' || k === 'party' || k === 'useAdvance' || k === 'short') v.alloc = autoAllocBills(v);
  },
  check: v => {
    const owed = v.party ? bal('2000', { party: v.party }) : 0;
    const advUsed = v.party && v.useAdvance !== 'no' ? Math.min(vendorAdvance(v.party), owed) : 0;
    const short = num(v.short);
    const paying = num(v.amt) + advUsed + short;
    const allocSum = (v.alloc || []).reduce((a, r) => a + num(r.amt), 0);
    return [
      ...dateChecks(v),
      ...(v.party ? [] : [err('party', 'Pick the vendor')]),
      ...(num(v.amt) > 0 || advUsed > 0 || short > 0 ? [] : [err('amt', 'Enter what you paid')]),
      ...(short < 0 ? [err('short', 'Enter zero or more')] : []),
      ...(short > 0 && short > owed - num(v.amt) - advUsed + 0.005 ? [err('short', `They can only let you off what is left — ${fmt(Math.max(0, owed - num(v.amt) - advUsed))}`)] : []),
      ...(num(v.amt) + advUsed > owed + 0.005 && v.over === 'stop' ? [err('amt', `You only owe ${fmt(owed)} — reduce the amount, or hold the extra as an advance`)] : []),
      ...(allocSum > paying + 0.005 ? [err('alloc', 'You have split more than you are paying — lower one of the amounts')] : []),
      ...(openBills(v.party).length
        && allocSum + 0.005 < Math.min(paying, owed, openBills(v.party).reduce((a, b) => a + billOutstanding(b), 0))
        && v.over !== 'advance'
        ? [err('alloc', 'Apply the whole payment to their bills, or choose to hold the rest as an advance')] : []),
      ...(v.via === '1010' ? pettyCheck('via', v, num(v.amt)) : []),
    ];
  },
  build: v => {
    const pid = v.party;
    if (!pid) return need('Pick who you are paying.');
    const owed = bal('2000', { party: pid });
    const advAvail = v.useAdvance !== 'no' ? vendorAdvance(pid) : 0;
    const cash = num(v.amt);
    const advUsed = r2(Math.min(advAvail, owed));
    // What the vendor let you off closes the bill too; it is income, not a cost reduction —
    // the GST already claimed on the bill stands, so the cost is left where it was.
    const short = r2(Math.min(Math.max(0, num(v.short)), Math.max(0, owed - cash - advUsed)));
    if (cash <= 0 && advUsed <= 0 && short <= 0) return need('Enter the amount.');
    const settle = r2(Math.min(cash + advUsed + short, owed));
    const extra = r2(cash + advUsed - Math.max(0, settle - short));
    const rows = (v.alloc || []).filter(r => num(r.amt) > 0);

    const lines = [];
    if (settle > 0.005) lines.push({ acc: '2000', dr: settle, party: pid });
    if (advUsed > 0.005) lines.push({ acc: '1550', cr: advUsed, party: pid });
    if (short > 0.005) lines.push({ acc: '4060', cr: short, party: pid });
    if (extra > 0.005) lines.push({ acc: '1550', dr: extra, party: pid });
    if (cash > 0.005) lines.push(cashLine(v, { acc: v.via || '1000', cr: cash }));

    const eff = [];
    if (cash) eff.push(`${fmt(cash)} leaves ${A[v.via || '1000'].name}.`);
    if (short) eff.push(`${fmt(short)} the vendor let you off — the bill still closes in full, and that part is booked as a discount received.`);
    if (advUsed) eff.push(`${fmt(advUsed)} of the advance already with ${esc(pname(pid))} is used up first.`);
    eff.push(`What you owe ${esc(pname(pid))} drops by ${fmt(settle)}. Profit unchanged — the cost was counted when the bill came in.`);
    rows.forEach(r => { const b = S().bills.find(x => x.id === r.id); if (b) eff.push(`${fmt(r.amt)} applied to ${esc(b.desc)}${num(r.amt) + 0.005 < billOutstanding(b) ? ' (part-paid)' : ' — now paid'}.`); });
    if (extra > 0.005) eff.push(`${fmt(extra)} more than the bills — held as an advance to this vendor, to use against their next bill.`);

    return {
      desc: cash > 0.005 && short > 0.005 ? `Paid ${pname(pid)} (${fmt(short)} discount)`
        : short > 0.005 ? `Discount from ${pname(pid)}` : `Paid ${pname(pid)}`,
      lines, effects: eff,
      allocations: rows.map(r => ({ coll: 'bills', id: r.id, amt: num(r.amt) })),
    };
  },
};

// The vendor let you off what was left on a bill — after a part-payment, or instead of one.
// The rent was 18,000; you paid 17,500; a week later the 500 is still showing as owed. No
// money moves: the bill closes and the 500 is income (4060 Discounts received), because the
// GST already claimed on the bill stands and the cost stays where it was counted. When the
// discount is given at the moment of paying, "Pay a vendor bill" carries the same box; this
// is for the remainder that outlived the payment.
EV.billdiscount = {
  title: 'Discount on a bill', group: 'Bills', dir: 'fix',
  when: 'The vendor agreed to drop what was left on a bill — a discount for paying, a rounding-off, a part they waived. <b>No money moves.</b> The bill closes and the amount is booked as a discount received, so it never appears as money out; the GST already claimed on the bill stands. If the discount came while you were paying, use "Pay a vendor bill" and its "Discount they gave you" box instead — one entry.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('party', 'Vendor', 'select', {
      opts: vendorsOwed().map(([id, b]) => [id, `${pname(id)} — you owe ${fmt(b)}`]),
      hint: 'Only vendors with something still open are listed.',
    }),
    F('bill', 'Bill', 'select', {
      opts: x => openBills(x.party).map(b => [b.id, `${b.desc} — ${fmt(billOutstanding(b))} left`]),
      show: x => !!x.party,
    }),
    F('amt', 'Discount', 'number', {
      required: true,
      hint: x => { const b = S().bills.find(y => y.id === x.bill); return b ? `${fmt(billOutstanding(b))} is still open on this bill` : ''; },
    }),
    F('note', 'Why', 'text', { hint: 'Optional — "agreed on the phone", "rounded off".' }),
  ],
  onchange: (k, v) => {
    if (k === 'party') { const first = openBills(v.party)[0]; v.bill = first ? first.id : null; v.amt = first ? billOutstanding(first) : 0; }
    if (k === 'bill') { const b = S().bills.find(y => y.id === v.bill); v.amt = b ? billOutstanding(b) : 0; }
  },
  check: v => {
    const b = S().bills.find(y => y.id === v.bill);
    return [
      ...dateChecks(v),
      ...(v.party ? [] : [err('party', 'Pick the vendor')]),
      ...(b ? [] : [err('bill', 'Pick the bill')]),
      ...posAmt(v, 'amt', 'Enter the discount'),
      ...(b && num(v.amt) > billOutstanding(b) + 0.005 ? [err('amt', `Only ${fmt(billOutstanding(b))} is left on this bill`)] : []),
    ];
  },
  build: v => {
    if (!v.party) return need('Pick the vendor.');
    const b = S().bills.find(y => y.id === v.bill);
    if (!b) return need('Pick the bill.');
    const amt = r2(Math.min(num(v.amt), billOutstanding(b)));
    if (amt <= 0) return need('Enter the discount.');
    const left = r2(billOutstanding(b) - amt);
    return {
      desc: `Discount from ${pname(v.party)} — ${b.desc}`,
      lines: [{ acc: '2000', dr: amt, party: v.party }, { acc: '4060', cr: amt, party: v.party }],
      effects: [
        `What you owe ${esc(pname(v.party))} drops by ${fmt(amt)}. <b>No money moves.</b>`,
        `${fmt(amt)} is booked as a discount received — a small income this month. The cost and the GST on the bill stay as they were.`,
        left > 0.005 ? `${esc(b.desc)} still has ${fmt(left)} open.` : `${esc(b.desc)} is now closed.`,
      ],
      allocations: [{ coll: 'bills', id: b.id, amt }],
    };
  },
};

function vendorsOwed() {
  return Object.entries(partyBalances('2000')).filter(([, b]) => b > 0.5);
}
function autoAllocBills(v) {
  if (!v.party) return [];
  const advUsed = v.useAdvance !== 'no' ? Math.min(vendorAdvance(v.party), bal('2000', { party: v.party })) : 0;
  return allocate(num(v.amt) + advUsed + Math.max(0, num(v.short)), openBills(v.party), billOutstanding).rows;
}

EV.salary = {
  title: 'Salary / bonus', group: 'Money out', dir: 'out',
  when: 'The cost is the gross. Deductions are held for the government until you deposit them.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('emp', 'Employee', 'party', { partyType: 'employee' }),
    F('kind', 'Salary or bonus', 'select', { opts: [accOpt('5010', 'Salary'), accOpt('5020', 'Bonus / incentive')], def: '5010' }),
    F('month', 'For which month', 'month', { def: ym(today()) }),
    F('gross', 'Salary before deductions', 'number', { required: true }),
    F('tds', 'TDS', 'number', { def: 0, show: () => tdsOn() }),
    F('pf', 'PF / ESI', 'number', { def: 0 }),
    F('via', 'Paid from', 'select', { opts: [['1000', 'Bank (1000)'], ['1010', 'Petty cash (1010)']], def: '1000' }),
    methodField(),
  ],
  check: v => [
    ...dateChecks(v), ...partyReq(v, 'emp', 'Name the employee'),
    ...posAmt(v, 'gross', 'Enter the gross amount'),
    ...(num(v.tds) + num(v.pf) > num(v.gross) ? [err('pf', 'TDS and PF together are more than the salary — check them')] : []),
    ...(v.via === '1010' ? pettyCheck('via', v, num(v.gross) - num(v.tds) - num(v.pf)) : []),
  ],
  build: v => {
    const g = num(v.gross);
    if (!g) return need('Enter the gross amount.');
    const t = tdsOn() ? num(v.tds) : 0;
    const p = num(v.pf);
    const net = g - t - p;
    const pid = pidOf(v.emp);
    const lines = [{ acc: v.kind || '5010', dr: g, party: pid || undefined }, cashLine(v, { acc: v.via || '1000', cr: net })];
    if (t) lines.push({ acc: '2250', cr: t });
    if (p) lines.push({ acc: '2550', cr: p });
    // Opened from a recurring salary line: the month is marked recorded on that line too,
    // so Recurring and Budget know it happened.
    const sub = v.sub ? S().subs.find(x => x.id === v.sub) : null;
    const updates = sub && v.month ? [{
      coll: 'subscriptions', id: sub.id,
      data: { [`charges.${v.month}`]: { actual: g, expected: expectedFor(sub, v.month), variance: r2(g - expectedFor(sub, v.month)), paid: true, date: v.date || today(), viaSalary: true }, hasTxns: true },
    }] : [];
    return {
      desc: `${A[v.kind || '5010'].name} — ${pnameOf(v.emp)}${v.month ? ' (' + mlabel(v.month) + ')' : ''}`,
      lines,
      effects: [
        `Cost ${fmt(g)} this month; net paid ${fmt(net)}.`,
        (t || p) ? `${fmt(t + p)} statutory dues held until you deposit them.` : '',
        sub ? `${esc(sub.name)} is marked recorded for ${mlabel(v.month)}.` : '',
      ].filter(Boolean),
      updates,
    };
  },
};

EV.asset = {
  title: 'Buy an asset', group: 'Money out', dir: 'out',
  when: 'Something that lasts over a year is not an expense. Its cost spreads over its useful life as monthly depreciation — so cash goes out now but profit is untouched today. Bought on credit? Record the bill and pay it later like any other.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('name', 'Item', 'text', { required: true }),
    F('vendor', 'Bought from', 'party', { partyType: 'vendor' }),
    ...rcmFields(() => true),
    ...gstFields('Cost (before GST)', {
      kind: 'input', gstShow: x => x.rcm !== 'yes',
      hint: () => `Anything under ${fmt(S().settings.capitalisationThreshold)} is normally a straight expense, not an asset`,
    }),
    F('life', 'How many months will you use it', 'number', { def: 36 }),
    F('how', 'Paid from', 'select', { opts: [['1000', 'Now — from Bank (1000)'], ['2300', 'Now — on the Credit card (2300)'], ['1010', 'Now — from Petty cash (1010)'], ['bill', 'Bill received — pay later']], def: '1000' }),
    F('dueDate', 'Due on', 'date', { show: x => x.how === 'bill', hint: 'Leave blank for 30 days' }),
  ],
  onchange: gstSync,
  check: v => [
    ...dateChecks(v),
    ...(String(v.name || '').trim() ? [] : [err('name', 'Name the item')]),
    ...posAmt(v, 'amt', 'Enter the cost'), ...(v.rcm === 'yes' ? [] : gstChecks(v)), ...rcmChecks(v),
    ...(num(v.life) >= 1 ? [] : [err('life', 'Useful life must be at least one month')]),
    ...(num(v.amt) > 0 && num(v.amt) < num(S().settings.capitalisationThreshold) ? [warn('amt', `Below your ${fmt(S().settings.capitalisationThreshold)} threshold — record this as an expense instead, unless it is part of something bigger`)] : []),
    ...(v.how === 'bill' ? partyReq(v, 'vendor', 'Name the vendor you owe') : []),
    ...(v.how === '1010' ? pettyCheck('how', v, num(v.amt) + gstOf(v)) : []),
  ],
  build: v => {
    const c = num(v.amt);
    if (!c) return need('Enter the cost.');
    if (!String(v.name || '').trim()) return need('Name the item.');
    const rcm = rcmLines(c, v);
    const gi = v.rcm === 'yes' ? 0 : gstOf(v);
    const life = Math.max(1, num(v.life));
    const lines = [{ acc: '1300', dr: c }];
    if (gi) lines.push(...inputTaxLines(gi, (v.gstType || 'intra') !== 'inter'));
    lines.push(...rcm.lines);
    const docs = [];
    const vid = pidOf(v.vendor);
    if (v.how === 'bill') {
      if (!vid) return need('Name the vendor you owe.');
      lines.push({ acc: '2000', cr: c + gi, party: vid });
      docs.push(billDoc(v, { partyId: vid, vendorName: pnameOf(v.vendor), desc: `Asset — ${v.name}`, acc: '1300', taxable: c, gst: gi, total: c + gi, dueDate: v.dueDate || null }));
    } else {
      lines.push({ acc: v.how || '1000', cr: c + gi });
    }
    docs.push({
      coll: 'assets',
      data: {
        name: v.name, cost: c, date: v.date || today(), start: ym(v.date || today()),
        life, monthly: r2(c / life), depreciated: [], status: 'in use', hasTxns: true, vendorId: vid || null,
      },
    });
    return {
      desc: `Asset — ${v.name}`,
      lines,
      effects: [
        v.how === 'bill' ? `You owe ${esc(pnameOf(v.vendor))} ${fmt(c + gi)}; profit is <b>unchanged</b>.` : `Cash out ${fmt(c + gi)}, but profit is <b>unchanged</b> right now.`,
        `Depreciation ${fmt(c / life)}/month for ${life} months, posted automatically at each month-end.`,
        gi ? `${fmt(gi)} GST becomes input credit.` : '',
        rcm.tax ? `${fmt(rcm.tax)} GST under reverse charge — paid with the return, claimed straight back.` : '',
      ].filter(Boolean),
      docs, selfInvoice: selfInvoiceOf(v, c, rcm.tax, pnameOf(v.vendor)),
    };
  },
};

EV.assetdispose = {
  title: 'Sell or scrap an asset', group: 'Corrections', dir: 'fix',
  when: 'Removes the asset and the depreciation built up against it. Sell it for more than the value left in the books and that is a gain; less, a loss.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('assetId', 'Asset', 'select', {
      opts: S().assets.filter(a => a.status === 'in use').map(a => {
        const wdv = num(a.cost) - (a.depreciated || []).length * num(a.monthly);
        return [a.id, `${a.name} — value left ${fmt(wdv)}`];
      }),
    }),
    F('proceeds', 'Amount received', 'number', { def: 0, hint: 'Zero if scrapped' }),
    F('via', 'Received into', 'select', { opts: [['1000', 'Bank / UPI'], ['1010', 'Petty cash']], def: '1000', show: x => num(x.proceeds) > 0 }),
  ],
  check: v => [...dateChecks(v), ...(S().assets.find(a => a.id === v.assetId) ? [] : [err('assetId', 'Pick the asset')]), ...(num(v.proceeds) < 0 ? [err('proceeds', 'Enter zero or more')] : [])],
  build: v => {
    const a = S().assets.find(x => x.id === v.assetId);
    if (!a) return need('Pick an asset.');
    const accumulated = (a.depreciated || []).length * num(a.monthly);
    const wdv = num(a.cost) - accumulated;
    const proceeds = num(v.proceeds);
    const gain = proceeds - wdv;

    const lines = [];
    if (proceeds) lines.push({ acc: v.via || '1000', dr: proceeds });
    if (accumulated > 0.5) lines.push({ acc: '1350', dr: accumulated });
    lines.push({ acc: '1300', cr: num(a.cost) });
    if (gain > 0.5) lines.push({ acc: '4040', cr: gain });
    else if (gain < -0.5) lines.push({ acc: '5220', dr: -gain });

    return {
      desc: `Disposed — ${a.name}`,
      lines,
      effects: [
        `Asset removed at cost ${fmt(a.cost)}; ${fmt(accumulated)} of depreciation cleared with it.`,
        `Value left on the books was ${fmt(wdv)}; you received ${fmt(proceeds)}.`,
        gain > 0.5 ? `<b>Gain ${fmt(gain)}</b> booked to Other income this month.`
          : gain < -0.5 ? `<b>Loss ${fmt(-gain)}</b> booked this month.`
            : 'No gain or loss — it sold for exactly its written-down value.',
        'No more depreciation will be posted for it at month-end.',
      ],
      updates: [{ coll: 'assets', id: a.id, data: { status: 'disposed', disposedOn: v.date || today() } }],
    };
  },
};

EV.petty = {
  title: 'Petty cash — enter vouchers', group: 'Money out', dir: 'out',
  when: 'Small cash spends from the box — tea, auto, courier. Enter up to three at once. The box has to hold enough; top it up with "Move money". Anything with a GST invoice is better recorded as an expense so the credit is claimed.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('d1', 'What', 'text', { hint: 'Tea, auto, courier…' }),
    F('a1', 'Amount', 'number', { required: true }),
    F('c1', 'Category', 'select', { opts: expOpts() }),
    F('d2', 'Second voucher — what', 'text', { hint: 'Leave blank if there is only one.' }),
    F('a2', 'Amount', 'number', { def: 0, show: x => !!String(x.d2 || '').trim() || num(x.a2) > 0 }),
    F('c2', 'Category', 'select', { opts: expOpts(), show: x => num(x.a2) > 0 }),
    F('d3', 'Third voucher — what', 'text', { show: x => num(x.a2) > 0 }),
    F('a3', 'Amount', 'number', { def: 0, show: x => !!String(x.d3 || '').trim() || num(x.a3) > 0 }),
    F('c3', 'Category', 'select', { opts: expOpts(), show: x => num(x.a3) > 0 }),
  ],
  check: v => {
    const tot = num(v.a1) + num(v.a2) + num(v.a3);
    return [
      ...dateChecks(v),
      ...(num(v.a1) > 0 ? [] : [err('a1', 'Enter the first voucher')]),
      ...(num(v.a1) > 0 && !v.c1 ? [err('c1', 'Pick a category')] : []),
      ...(num(v.a2) > 0 && !v.c2 ? [err('c2', 'Pick a category')] : []),
      ...(num(v.a3) > 0 && !v.c3 ? [err('c3', 'Pick a category')] : []),
      ...pettyCheck('a1', v, tot),
    ];
  },
  build: v => {
    const lines = [];
    const parts = [];
    let tot = 0;
    [[v.a1, v.c1, v.d1], [v.a2, v.c2, v.d2], [v.a3, v.c3, v.d3]].forEach(([a, c, d]) => {
      const amt = num(a);
      if (amt > 0 && c) { lines.push({ acc: c, dr: amt }); tot += amt; parts.push(d || A[c].name); }
    });
    if (!tot) return need('Enter at least one voucher.');
    lines.push({ acc: '1010', cr: tot });
    return {
      desc: 'Petty cash — ' + parts.join(', '),
      lines,
      effects: [`${fmt(tot)} out of the box. Box after this: ${fmt(bal('1010') - tot)}.`],
    };
  },
};

EV.director = {
  title: 'Director paid a company cost personally', group: 'Money out', dir: 'out',
  when: 'The cost is recorded now and the company owes you. Reimburse yourself later with "Move money".',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('desc', 'What', 'text', { required: true }),
    F('acc', 'Category', 'select', { opts: expOpts() }),
    ...gstFields('Amount (before GST)', { kind: 'input' }),
  ],
  onchange: gstSync,
  check: v => [...dateChecks(v), ...(String(v.desc || '').trim() ? [] : [err('desc', 'Say what it was for')]), ...(v.acc ? [] : [err('acc', 'Pick a category')]), ...posAmt(v), ...gstChecks(v)],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    if (!v.acc) return need('Pick a category.');
    const gi = gstOf(v);
    const tax = inputTax(v.acc, gi, v);
    return {
      desc: `${v.desc || A[v.acc].name} (paid by director)`,
      lines: [{ acc: v.acc, dr: amt + tax.onCost }, ...tax.lines, { acc: '2450', cr: amt + gi }],
      effects: [`Cost ${fmt(amt + tax.onCost)} this month.`, `The company now owes the director ${fmt(amt + gi)}.`, tax.credit ? `${fmt(gi)} GST becomes input credit.` : ''].filter(Boolean),
    };
  },
};

// ═══════ MONEY IN & FUNDING ═══════

EV.otherinc = {
  title: 'Other income', group: 'Money in', dir: 'in',
  when: 'Consultancy, a referral fee, interest — anything earned that is not a deal. Profit goes up by the amount. With GST on and a client named, a tax invoice is numbered and generated exactly as for a deal.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('party', 'Client', 'party', { partyType: 'client', hint: 'Needed for an invoice, or if they are paying later.' }),
    F('desc', 'What', 'text', { required: true }),
    F('acc', 'Type', 'select', {
      opts: [accOpt('4020'), accOpt('4040'), accOpt('4050')],
      def: '4020',
    }),
    ...gstFields('Amount (before GST)', { kind: 'output' }),
    F('sac', 'Service code for the invoice (SAC)', 'text', {
      def: S().settings.sacCodes?.consultancy || '998311', show: x => x.gst === 'yes',
      hint: '998311 is consulting; 997221 is brokerage. Your CA can confirm which fits.',
    }),
    F('via', 'Received', 'select', {
      opts: [['1000', 'Now — into Bank (1000)'], ['1010', 'Now — into Petty cash (1010)'], ['later', 'Not yet — the client will pay later']],
      def: '1000',
    }),
    methodField(),
    F('tds', 'TDS % the client deducted', 'number', { def: 0, show: x => tdsOn() && x.via !== 'later' }),
    F('dueDate', 'Payment due by', 'date', { show: x => x.via === 'later', hint: 'Leave blank for 30 days' }),
  ],
  onchange: gstSync,
  check: v => [
    ...dateChecks(v),
    ...(String(v.desc || '').trim() ? [] : [err('desc', 'Say what it was for')]),
    ...posAmt(v), ...gstChecks(v),
    ...(v.via === 'later' && !pidOf(v.party) ? [err('party', 'Name the client — the amount has to be owed by someone')] : []),
    ...(v.gst === 'yes' && !pidOf(v.party) ? [err('party', 'Name the client — a GST invoice needs a recipient')] : []),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    const gi = gstOf(v);
    const total = amt + gi;
    const pid = pidOf(v.party);
    if (v.via === 'later' && !pid) return need('Name the client if they are paying later — the amount has to be owed by someone.');
    if (gi && !pid) return need('Name the client — a GST invoice needs a recipient.');

    // For a service the place of supply is the recipient's location (IGST Act s.12(2)) —
    // unlike brokerage, which follows the property.
    const st = S().settings;
    const pos = partyState(v.party) || st.state;
    const intra = isIntra(pos);

    const tds = tdsOn() && v.via !== 'later' ? Math.round(amt * num(v.tds) / 100) : 0;
    const lines = [];
    if (v.via === 'later') lines.push({ acc: '1100', dr: total, party: pid });
    else {
      lines.push(cashLine(v, { acc: v.via || '1000', dr: r2(total - tds) }));
      if (tds) lines.push({ acc: '1150', dr: tds, ...(pid ? { party: pid } : {}) });
    }
    lines.push({ acc: v.acc || '4020', cr: amt, ...(pid ? { party: pid } : {}) });
    if (gi) lines.push(...outputTaxLines(gi, intra));
    const split = gstHeads(gi, intra);

    return {
      desc: v.desc || A[v.acc || '4020'].name,
      lines,
      effects: [
        `Income ${fmt(amt)} this month — profit goes up by that.`,
        gi ? `${fmt(gi)} GST charged (${intra ? 'CGST + SGST' : 'IGST'}) — owed to the government, not yours.` : '',
        v.via === 'later' ? `${fmt(total)} is now owed by ${esc(pnameOf(v.party))}, due ${v.dueDate || 'in 30 days'}.` : `${fmt(total)} arrives in ${A[v.via || '1000'].name}.`,
        gi ? 'A tax invoice will be numbered and generated.' : '',
      ].filter(Boolean),
      invoice: gi ? {
        kind: 'other', partyId: pid, dealId: null, base: amt, gstRate: num(v.gstRate),
        cgst: split.cgst, sgst: split.sgst, igst: split.igst, total,
        paid: v.via === 'later' ? 0 : total, dueDate: v.via === 'later' ? (v.dueDate || addDays(v.date || today(), 30)) : null,
        placeOfSupply: pos, sac: v.sac || st.sacCodes?.consultancy || '998311',
        desc: v.desc || A[v.acc || '4020'].name, date: v.date || today(),
      } : null,
    };
  },
};

EV.funding = {
  title: 'Capital / director loan received', group: 'Money in', dir: 'in',
  when: '<b>Never income.</b> Share capital is ownership; a director loan is repayable. Either way your profit does not change.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('kind', 'What kind of money', 'select', { opts: [accOpt('3000', 'Share capital'), accOpt('2450', "Director's loan")], def: '3000' }),
    F('who', 'From', 'party', { partyType: 'director', hint: 'The director or shareholder — a record, so it shows on statements.' }),
    F('amt', 'Amount', 'number', { required: true }),
    F('via', 'Received into', 'select', { opts: [['1000', 'Bank (1000)'], ['1010', 'Petty cash (1010)']], def: '1000' }),
    methodField(),
  ],
  check: v => [...dateChecks(v), ...partyReq(v, 'who', 'Who put the money in?'), ...posAmt(v)],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    const kind = v.kind || '3000';
    const pid = pidOf(v.who);
    return {
      desc: `${A[kind].name} — ${pnameOf(v.who)}`.trim(),
      lines: [cashLine(v, { acc: v.via || '1000', dr: amt }), { acc: kind, cr: amt, ...(pid ? { party: pid } : {}) }],
      effects: [
        `${A[v.via || '1000'].name} up ${fmt(amt)}. Profit unchanged — this is <b>not</b> income.`,
        kind === '3000' ? 'Share capital needs a board resolution and an ROC filing — tell your CA.' : 'Repayable to the director.',
      ],
    };
  },
};

EV.bankloan = {
  title: 'Bank / NBFC loan (EMI)', group: 'Money in', dir: 'in',
  when: 'Creates the loan with its month-by-month principal and interest schedule.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('lender', 'Lender', 'party', { partyType: 'lender' }),
    F('purpose', 'Purpose', 'text'),
    F('amt', 'Amount', 'number', { required: true }),
    F('rate', 'Interest % p.a.', 'number', { def: 12 }),
    F('n', 'Tenure (months)', 'number', { def: 24 }),
    F('fee', 'Processing fee (before GST)', 'number', { def: 0 }),
    F('feeGst', 'GST on the fee', 'number', { def: 0, show: x => num(x.fee) > 0, hint: 'Usually 18%. It is input credit, so it is not lost.' }),
    F('kind', 'Lender is', 'select', { opts: [['bank', 'A bank'], ['nbfc', 'An NBFC or private lender — 194A TDS on interest']], def: 'bank' }),
  ],
  check: v => [
    ...dateChecks(v), ...partyReq(v, 'lender', 'Name the lender'), ...posAmt(v, 'amt', 'Enter the loan amount'),
    ...(num(v.rate) < 0 || num(v.rate) > 60 ? [err('rate', 'Interest is normally 8–24% a year — check the rate')] : []),
    ...(num(v.n) >= 1 && num(v.n) <= 360 ? [] : [err('n', 'Tenure must be 1–360 months')]),
    ...(num(v.fee) >= num(v.amt) ? [err('fee', 'The fee cannot exceed the loan')] : []),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the loan amount.');
    const pid = pidOf(v.lender);
    if (!pid) return need('Name the lender.');
    const fee = num(v.fee), feeGst = num(v.feeGst);
    const n = Math.max(1, num(v.n));
    const lines = [{ acc: '1000', dr: r2(amt - fee - feeGst) }, { acc: '2400', cr: amt, party: pid }];
    if (fee) lines.push({ acc: '5150', dr: fee });
    if (feeGst) lines.push(...inputTaxLines(feeGst, true));
    const sch = schedule(amt, num(v.rate), n, addMonths(ym(v.date || today()), 1));
    const totalInterest = sch.reduce((s, x) => s + x.int, 0);
    return {
      desc: `Loan — ${pnameOf(v.lender)}${v.purpose ? ' (' + v.purpose + ')' : ''}`,
      lines,
      effects: [
        `Bank up ${fmt(r2(amt - fee - feeGst))}. Loan owed ${fmt(amt)}. <b>Not income.</b>`,
        `EMI ≈ ${fmt(sch[0].emi)} × ${n} months. Total interest over the life: <b>${fmt(totalInterest)}</b>.`,
        fee ? `${fmt(fee)} processing fee is a cost this month.` : '',
      ].filter(Boolean),
      docs: [{
        coll: 'loans',
        data: {
          lender: pnameOf(v.lender), purpose: v.purpose || '', principal: amt,
          rate: num(v.rate), n, start: addMonths(ym(v.date || today()), 1),
          schedule: sch, paid: [], status: 'active', partyId: pid, hasTxns: true, lenderKind: v.kind || 'bank',
        },
      }],
    };
  },
};

// ═══════ MOVE MONEY ═══════

EV.emi = {
  title: 'Pay an EMI', group: 'Move money', dir: 'move',
  when: 'One payment, several parts. Principal returns money you borrowed — not a cost. Interest and the lender\'s charges are costs. A penalty is a cost too, kept apart because the tax return disallows it. Paying extra principal rebuilds the schedule on the new balance.',
  fields: v => {
    const l = S().loans.find(x => x.id === v.loan);
    const nxt = l ? (l.schedule || []).find(x => !(l.paid || []).includes(x.n)) : null;
    return [
      F('date', 'Date', 'date', { def: today() }),
      F('loan', 'Loan', 'select', {
        opts: S().loans.filter(x => x.status === 'active').map(x => [x.id, `${x.lender} — ${x.purpose || 'loan'}`]),
      }),
      F('prin', 'Principal', 'number', { hint: nxt ? `Instalment ${nxt.n} of ${l.n} per the schedule: ${fmt(nxt.prin)} principal, ${fmt(nxt.int)} interest. Change either to what the lender\'s statement says.` : '' }),
      F('int', 'Interest', 'number'),
      F('charges', 'Lender\'s charges', 'number', { def: 0, hint: 'Processing, bounce or service charges added to this instalment.' }),
      F('extra', 'Penalty', 'number', { def: 0, hint: 'A penal charge for paying late. Kept apart — the tax return disallows it.' }),
      F('prepay', 'Extra principal paid', 'number', { def: 0, hint: 'Paying ahead of the schedule. The remaining schedule is rebuilt on the lower balance, same rate, same end date, lower EMI.' }),
      F('tds', 'TDS deducted on the interest', 'number', { def: 0, show: () => tdsOn(), hint: 'Interest to an NBFC or a private lender carries 194A TDS at 10%. Banks are exempt — leave 0.' }),
      F('via', 'Paid from', 'select', { opts: [['1000', 'Bank (1000)'], ['2300', 'Credit card (2300)']], def: '1000' }),
      methodField(),
    ];
  },
  onchange: (k, v) => {
    if (k !== 'loan') return;
    const l = S().loans.find(x => x.id === v.loan);
    const nxt = l ? (l.schedule || []).find(x => !(l.paid || []).includes(x.n)) : null;
    v.prin = nxt ? nxt.prin : 0;
    v.int = nxt ? nxt.int : 0;
  },
  check: v => {
    const l = S().loans.find(x => x.id === v.loan && x.status === 'active');
    const owed = l ? bal('2400', { party: l.partyId }) : 0;
    return [
      ...dateChecks(v),
      ...(l ? [] : [err('loan', 'Pick an active loan')]),
      ...(num(v.prin) + num(v.int) + num(v.charges) + num(v.extra) + num(v.prepay) > 0 ? [] : [err('prin', 'Enter what was paid')]),
      ...['prin', 'int', 'charges', 'extra', 'prepay', 'tds'].filter(k => num(v[k]) < 0).map(k => err(k, 'Enter zero or more')),
      ...(l && num(v.prin) + num(v.prepay) > owed + 0.005 ? [err('prepay', `Only ${fmt(owed)} is still owed on this loan`)] : []),
      ...(num(v.tds) > num(v.int) ? [err('tds', 'TDS cannot exceed the interest')] : []),
    ];
  },
  build: v => {
    const l = S().loans.find(x => x.id === v.loan);
    if (!l) return need('No active loan.');
    const i = (l.schedule || []).find(x => !(l.paid || []).includes(x.n));
    if (!i) return need('This loan is fully paid.');
    const prin = num(v.prin), int = num(v.int), charges = num(v.charges), extra = num(v.extra), prepay = num(v.prepay);
    const tds = tdsOn() ? num(v.tds) : 0;
    const cash = r2(prin + int + charges + extra + prepay - tds);
    if (cash <= 0 && tds <= 0) return need('Enter what was paid.');

    const lines = [];
    if (prin + prepay > 0) lines.push({ acc: '2400', dr: r2(prin + prepay), party: l.partyId });
    if (int > 0) lines.push({ acc: '5150', dr: int });
    if (charges > 0) lines.push({ acc: '5140', dr: charges });
    if (extra > 0) lines.push({ acc: '5165', dr: extra });
    if (tds > 0) lines.push({ acc: '2250', cr: tds });
    lines.push(cashLine(v, { acc: v.via || '1000', cr: cash }));

    const after = r2(bal('2400', { party: l.partyId }) - prin - prepay);
    const paidNow = [...(l.paid || []), i.n];
    const data = { paid: paidNow, prepaid: r2(num(l.prepaid) + prepay), status: paidNow.length >= l.n || after <= 0.5 ? 'closed' : 'active' };
    // Extra principal changes every later month's interest, so the rest of the schedule is
    // rebuilt on the new balance — same rate, same end date, lower instalment.
    if (prepay > 0 && after > 0.5) data.schedule = regenerateSchedule(l, after, paidNow);

    return {
      desc: `EMI ${i.n}/${l.n} — ${l.lender}`,
      lines,
      effects: [
        `Cash out ${fmt(cash)}.`,
        `Cost this month is <b>${fmt(r2(int + charges + extra))}</b> — ${fmt(int)} interest${charges ? ', ' + fmt(charges) + ' lender\'s charges' : ''}${extra ? ', ' + fmt(extra) + ' penalty (disallowed for tax)' : ''}. The ${fmt(r2(prin + prepay))} principal is not a cost.`,
        tds ? `${fmt(tds)} TDS withheld on the interest (194A) — deposit it by the 7th of next month.` : '',
        prepay ? `${fmt(prepay)} paid ahead — the remaining ${l.n - paidNow.length} instalments are rebuilt on ${fmt(after)} at ${num(l.rate)}%.` : '',
        `Loan balance after this: ${fmt(after)}.`,
      ].filter(Boolean),
      updates: [{ coll: 'loans', id: l.id, data }],
    };
  },
};

EV.card2emi = {
  title: 'Convert a card purchase to EMI', group: 'Move money', dir: 'move',
  when: 'The purchase is already recorded. This only restructures the debt and adds a financing cost.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('what', 'What', 'text', { required: true }),
    F('amt', 'Amount converted', 'number', { required: true, hint: () => 'Card outstanding: ' + fmt(bal('2300')) }),
    F('rate', 'Interest % p.a.', 'number', { def: 14 }),
    F('n', 'Tenure (months)', 'number', { def: 12 }),
    F('fee', 'Conversion fee', 'number', { def: 0 }),
  ],
  check: v => [
    ...dateChecks(v), ...(String(v.what || '').trim() ? [] : [err('what', 'Say what the purchase was')]), ...posAmt(v),
    ...(num(v.amt) > bal('2300') + 0.005 ? [err('amt', `The card only has ${fmt(bal('2300'))} outstanding`)] : []),
    ...(num(v.n) >= 1 && num(v.n) <= 60 ? [] : [err('n', 'Tenure must be 1–60 months')]),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount to convert.');
    const fee = num(v.fee);
    const n = Math.max(1, num(v.n));
    const pid = pidOf(v.__lender || { __new: true, name: 'Card EMI', type: 'lender' });
    const lines = [{ acc: '2300', dr: amt }, { acc: '2400', cr: amt, party: pid }];
    if (fee) lines.push({ acc: '5150', dr: fee }, { acc: '2300', cr: fee });
    const sch = schedule(amt, num(v.rate), n, addMonths(ym(v.date || today()), 1));
    const totalInterest = sch.reduce((s, x) => s + x.int, 0);
    return {
      desc: `Card → EMI: ${v.what || 'purchase'}`,
      lines,
      effects: [
        `Card balance down ${fmt(amt)}, loan up ${fmt(amt)}. Your total debt is unchanged.`,
        `This will cost <b>${fmt(totalInterest)}</b> in interest over ${n} months${fee ? ' plus a ' + fmt(fee) + ' fee' : ''}.`,
      ],
      docs: [{
        coll: 'loans',
        data: {
          lender: 'Card EMI', purpose: v.what || '', principal: amt, rate: num(v.rate), n,
          start: addMonths(ym(v.date || today()), 1),
          schedule: sch, paid: [], status: 'active', partyId: pid, hasTxns: true,
        },
      }],
    };
  },
};

EV.transfer = {
  title: 'Move money between your own pockets', group: 'Move money', dir: 'move',
  when: 'Bank to petty cash, paying the card bill, reimbursing the director, UPI wallet top-ups. <b>Never an expense</b> — the money is still yours (or still owed).',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('kind', 'What are you moving', 'select', {
      opts: [
        ['1000>1010', 'Bank / UPI → petty cash box'],
        ['1010>1000', 'Petty cash box → bank'],
        ['1000>2300', 'Pay the credit-card bill'],
        ['1000>2450', 'Reimburse the director'],
        ['2450>1000', 'Director puts money in'],
      ], def: '1000>1010',
    }),
    F('amt', 'Amount', 'number', { required: true, hint: x => { const [f] = (x.kind || '1000>1010').split('>'); return f === '2450' ? '' : `${A[f].name} holds ${fmt(bal(f))}`; } }),
    F('method', 'How it moved', 'select', { opts: PAY_METHODS, def: 'cash', show: x => /1000/.test(x.kind || '1000>1010'), hint: 'Cash withdrawn at the counter, or a transfer.' }),
  ],
  check: v => {
    const [f, t] = (v.kind || '1000>1010').split('>');
    const out = [...dateChecks(v), ...posAmt(v)];
    if (f === '1010') out.push(...pettyCheck('amt', v, num(v.amt)));
    if (t === '2300' && num(v.amt) > bal('2300') + 0.005) out.push(err('amt', `The card only has ${fmt(bal('2300'))} outstanding — paying more would put it in credit`));
    return out;
  },
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    const [f, t] = (v.kind || '1000>1010').split('>');
    return {
      desc: `Transfer: ${A[f].name} → ${A[t].name}`,
      lines: [cashLine(v, { acc: t, dr: amt }), cashLine(v, { acc: f, cr: amt })],
      effects: [`${fmt(amt)} moved. Profit unchanged — this is not a cost.`],
    };
  },
};

EV.statutory = {
  title: 'Pay GST / TDS / PF to government', group: 'Move money', dir: 'move',
  when: 'Remitting what you collected or withheld on someone else\'s behalf. Not an expense — you were only holding it. For GST the set-off is worked out the way GSTR-3B does it: IGST credit first, then CGST credit against CGST and SGST against SGST. What is left is paid in cash, per head.',
  fields: v => {
    const isGst = (v.kind || 'gst') === 'gst';
    return [
      F('date', 'Paid on', 'date', { def: today() }),
      F('kind', 'What are you paying', 'select', { opts: [['gst', 'GST — monthly return'], ['tds', 'TDS'], ['pf', 'PF / ESI']], def: 'gst' }),
      F('month', 'For the month', 'month', { def: addMonths(ym(today()), -1), show: () => isGst }),
      F('cgst', 'CGST paid in cash', 'number', { def: 0, show: () => isGst, hint: x => gstPayHint(x) }),
      F('sgst', 'SGST paid in cash', 'number', { def: 0, show: () => isGst }),
      F('igst', 'IGST paid in cash', 'number', { def: 0, show: () => isGst }),
      F('rcm', 'Reverse-charge GST paid in cash', 'number', { def: 0, show: () => isGst, hint: 'Credit cannot be used against this.' }),
      F('tdsMonth', 'For the month', 'month', { def: addMonths(ym(today()), -1), show: x => x.kind === 'tds' }),
      F('tdsSection', 'Section', 'select', { opts: TDS_SECTIONS.filter(t => t[0] !== 'none').map(t => [t[0], t[1]]), show: x => x.kind === 'tds', hint: 'One challan per section — record each separately.' }),
      F('amt', 'Paid from bank', 'number', {
        show: () => !isGst,
        hint: x => ({ tds: 'TDS payable ' + fmt(bal('2250')), pf: 'Dues ' + fmt(bal('2550')) })[x.kind] || '',
      }),
      F('interest', 'Interest paid', 'number', { def: 0, hint: x => x.kind === 'gst' ? 'Interest under s.50 for paying late — allowed as a cost.' : 'Interest under s.201(1A) — the tax return disallows it.' }),
      F('late', 'Late fee', 'number', { def: 0, hint: 'The fixed fee for filing after the due date — disallowed for tax.' }),
      F('challan', 'Challan number', 'text', { show: x => x.kind !== 'gst', hint: 'From the bank receipt — it is how the return is reconciled.' }),
      F('bsr', 'BSR code', 'text', { show: x => x.kind === 'tds' }),
    ];
  },
  onchange: (k, v) => {
    if ((v.kind || 'gst') !== 'gst') return;
    if (k === 'month' || k === 'kind') {
      const g = gstComputation(v.month || addMonths(ym(today()), -1));
      v.cgst = g.setoff.payable.cgst;
      v.sgst = g.setoff.payable.sgst;
      v.igst = g.setoff.payable.igst;
      v.rcm = g.rcmDue;
    }
  },
  check: v => {
    const out = dateChecks(v);
    if ((v.kind || 'gst') === 'gst') {
      if (!v.month) out.push(err('month', 'Pick the month'));
      const g = safeGst(v.month);
      for (const h of ['cgst', 'sgst', 'igst', 'rcm']) {
        if (num(v[h]) < 0) out.push(err(h, 'Enter zero or more'));
        const due = h === 'rcm' ? num(g?.rcmDue) : num(g?.setoff?.payable?.[h]);
        if (g && num(v[h]) > due + 0.005) out.push(warn(h, `Only ${fmt(due)} is due under this head — paying more leaves the government owing you`));
      }
    } else if (!(num(v.amt) > 0)) out.push(err('amt', 'Enter what you paid'));
    else {
      const due = bal({ tds: '2250', pf: '2550' }[v.kind]);
      if (num(v.amt) > due + 0.005) out.push(err('amt', `Only ${fmt(due)} is owed — check the amount`));
    }
    return out;
  },
  build: v => {
    const late = num(v.late);
    const interest = num(v.interest);
    const extra = r2(late + interest);
    // GST interest under s.50 is compensatory and allowed; every other statutory interest,
    // fee or penalty is disallowed and has to be visible as such.
    const extraLines = () => {
      const out = [];
      if (interest) out.push({ acc: (v.kind || 'gst') === 'gst' ? '5150' : '5165', dr: interest });
      if (late) out.push({ acc: '5165', dr: late });
      return out;
    };
    if ((v.kind || 'gst') === 'gst') {
      const month = v.month || addMonths(ym(today()), -1);
      const g = gstComputation(month);
      const lines = [], eff = [];
      // Credit utilisation per Rule 88A: each pair is a debit to the liability head and a
      // credit to the input head it was drawn from.
      for (const u of g.setoff.util) {
        lines.push({ acc: GST_OUTPUT[u.to], dr: u.amt });
        lines.push({ acc: GST_INPUT[u.from], cr: u.amt });
      }
      const cash = { cgst: num(v.cgst), sgst: num(v.sgst), igst: num(v.igst) };
      for (const h of ['cgst', 'sgst', 'igst']) if (cash[h]) lines.push({ acc: GST_OUTPUT[h], dr: cash[h] });
      const rcm = num(v.rcm);
      if (rcm) lines.push({ acc: GST_RCM, dr: rcm });
      const totalCash = cash.cgst + cash.sgst + cash.igst + rcm;
      lines.push(...extraLines());
      if (totalCash + extra > 0) lines.push({ acc: '1000', cr: r2(totalCash + extra) });
      if (!lines.length) return need(`Nothing to pay for ${mlabel(month)} — no liability outstanding and no credit to set off.`);

      const liab = g.liability.cgst + g.liability.sgst + g.liability.igst;
      const used = g.setoff.util.reduce((a, u) => a + u.amt, 0);
      eff.push(`GSTR-3B for ${mlabel(month)}: liability ${fmt(liab)}, credit set off ${fmt(used)}, cash ${fmt(totalCash)}.`);
      g.setoff.util.forEach(u => eff.push(`${fmt(u.amt)} ${u.from.toUpperCase()} credit used against ${u.to.toUpperCase()}.`));
      if (rcm) eff.push(`${fmt(rcm)} reverse-charge GST paid in cash — credit cannot be used for it.`);
      const carry = g.setoff.carry.cgst + g.setoff.carry.sgst + g.setoff.carry.igst;
      if (carry > 0.5) eff.push(`${fmt(carry)} input credit carries forward to next month.`);
      if (extra) eff.push(`${fmt(extra)} of interest and late fee is a real cost this month.`);
      return { desc: `GST for ${mlabel(month)} remitted`, lines, effects: eff };
    }
    const amt = num(v.amt);
    if (!amt) return need('Enter what you paid.');
    const acc = { tds: '2250', pf: '2550' }[v.kind];
    const lines = [{ acc, dr: amt }, ...extraLines()];
    lines.push({ acc: '1000', cr: r2(amt + extra) });
    return {
      desc: `${v.kind.toUpperCase()} remitted${v.kind === 'tds' && v.tdsSection ? ' — ' + v.tdsSection : ''}${v.kind === 'tds' && v.tdsMonth ? ' for ' + mlabel(v.tdsMonth) : ''}`,
      lines,
      effects: [`Liability cleared by ${fmt(amt)}.`, extra ? `${fmt(extra)} of interest and late fee is a real cost this month.` : ''].filter(Boolean),
    };
  },
};

const safeGst = month => { try { return gstComputation(month || addMonths(ym(today()), -1)); } catch { return null; } };

function gstPayHint(x) {
  const g = gstComputation(x.month || addMonths(ym(today()), -1));
  const L = g.liability, C = g.credit, P = g.setoff.payable;
  return `Liability C ${fmt(L.cgst)} · S ${fmt(L.sgst)} · I ${fmt(L.igst)}. Credit C ${fmt(C.cgst)} · S ${fmt(C.sgst)} · I ${fmt(C.igst)}. After set-off pay C ${fmt(P.cgst)} · S ${fmt(P.sgst)} · I ${fmt(P.igst)}.`;
}

// ═══════ CORRECTIONS ═══════

EV.vendorrefund = {
  title: 'Vendor refunded you / credit note', group: 'Corrections', dir: 'fix',
  when: 'A vendor gave money back or issued a credit note. It <b>reduces the original cost</b> rather than counting as income, and if GST was claimed on the original, that credit is reversed too. A credit note against an unpaid bill reduces what you owe instead of returning cash.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('vendor', 'Vendor', 'party', { partyType: 'vendor' }),
    F('desc', 'What', 'text', { required: true }),
    F('what', 'What is coming back', 'select', {
      opts: [['cost', 'Part of something I paid for — reduces that cost'], ['advance', 'Money I paid ahead — an advance they are returning']],
      def: 'cost',
      hint: x => typeof x.vendor === 'string' && vendorAdvance(x.vendor) > 0.5 ? `They hold ${fmt(vendorAdvance(x.vendor))} of your money as an advance.` : '',
    }),
    F('acc', 'Original category', 'select', { opts: expOpts(), show: x => x.what !== 'advance' }),
    ...rcmFields(x => x.what !== 'advance'),
    ...gstFields('Amount (before GST)', { kind: 'input', def: 'no', gstShow: x => x.what !== 'advance' && x.rcm !== 'yes' }),
    F('how', 'How it came back', 'select', {
      opts: [['1000', 'Money into bank / UPI'], ['2300', 'Reversed on the card'], ['1010', 'Cash into the box'], ['credit', 'Credit note — reduces what I owe them']],
      def: '1000',
    }),
    F('alloc', 'Applied to these bills', 'alloc', { source: 'bills', partyKey: 'vendor', show: x => x.how === 'credit' && typeof x.vendor === 'string' }),
  ],
  onchange: (k, v) => {
    gstSync(k, v);
    if (v.how === 'credit' && typeof v.vendor === 'string' && ['vendor', 'amt', 'gst', 'gstRate', 'gstAmt', 'total', 'how'].includes(k)) {
      v.alloc = allocate(num(v.amt) + gstOf(v), openBills(v.vendor), billOutstanding).rows;
    }
  },
  check: v => [
    ...dateChecks(v), ...(String(v.desc || '').trim() ? [] : [err('desc', 'Say what it was for')]),
    ...(v.what === 'advance' ? [
      ...partyReq(v, 'vendor', 'Name the vendor'),
      ...(typeof v.vendor === 'string' && num(v.amt) > vendorAdvance(v.vendor) + 0.005 ? [err('amt', `They only hold ${fmt(vendorAdvance(v.vendor))} of yours`)] : []),
      ...(v.how === 'credit' ? [err('how', 'An advance comes back as money, not as a credit note')] : []),
    ] : [...(v.acc ? [] : [err('acc', 'Pick the category it was originally booked to')])]),
    ...posAmt(v), ...(v.rcm === 'yes' ? [] : gstChecks(v)), ...rcmChecks(v),
    ...(v.how === 'credit' ? [...partyReq(v, 'vendor', 'Name the vendor'), ...(pidOf(v.vendor) && typeof v.vendor === 'string' && num(v.amt) + gstOf(v) > bal('2000', { party: v.vendor }) + 0.005 ? [err('amt', `You only owe this vendor ${fmt(bal('2000', { party: v.vendor }))}`)] : [])] : []),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    if (v.what === 'advance') {
      const vid = pidOf(v.vendor);
      if (!vid) return need('Name the vendor.');
      return {
        desc: `Advance returned — ${pnameOf(v.vendor)}${v.desc ? ': ' + v.desc : ''}`,
        lines: [cashLine(v, { acc: v.how || '1000', dr: amt }), { acc: '1550', cr: amt, party: vid }],
        effects: [`${fmt(amt)} of your own money comes back from ${esc(pnameOf(v.vendor))}. No cost changes — it was never spent.`],
      };
    }
    if (!v.acc) return need('Pick the category it was originally booked to.');
    const rcm = rcmLines(amt, v);
    const gi = v.rcm === 'yes' ? 0 : gstOf(v);
    const tax = inputTax(v.acc, gi, v);
    const total = amt + gi;
    const vid = pidOf(v.vendor);
    const lines = [];
    // Giving back part of a reverse-charge purchase gives back the liability and the credit
    // together, so both sides of it unwind.
    const rcmBack = rcm.lines.map(l => l.dr ? { acc: l.acc, cr: l.dr } : { acc: l.acc, dr: l.cr });
    if (v.how === 'credit') {
      if (!vid) return need('Name the vendor.');
      lines.push({ acc: '2000', dr: total, party: vid });
    } else {
      lines.push({ acc: v.how || '1000', dr: total });
    }
    lines.push({ acc: v.acc, cr: amt + tax.onCost });
    // Reverse the credit that was claimed on the original purchase.
    for (const l of tax.lines) lines.push({ acc: l.acc, cr: l.dr });
    lines.push(...rcmBack);
    return {
      desc: `Refund — ${v.desc || A[v.acc].name}${vid ? ' (' + pnameOf(v.vendor) + ')' : ''}`,
      lines,
      effects: [
        `${A[v.acc].name} for this month is reduced by ${fmt(amt + tax.onCost)} — not treated as income.`,
        tax.credit ? `${fmt(gi)} of input credit is given back.` : '',
        rcm.tax ? `${fmt(rcm.tax)} of reverse-charge GST unwinds — both the amount you owed the government and the credit for it.` : '',
        v.how === 'credit' ? `What you owe ${esc(pnameOf(v.vendor))} drops by ${fmt(total)}.` : `${fmt(total)} comes back into ${A[v.how || '1000'].name}.`,
        ...(v.how === 'credit' ? (v.alloc || []).filter(r => num(r.amt) > 0).map(r => { const b = S().bills.find(x => x.id === r.id); return b ? `${fmt(r.amt)} applied to ${esc(b.desc)}.` : ''; }) : []),
      ].filter(Boolean),
      allocations: v.how === 'credit' ? (v.alloc || []).filter(r => num(r.amt) > 0).map(r => ({ coll: 'bills', id: r.id, amt: num(r.amt) })) : [],
    };
  },
};

EV.creditnote = {
  title: 'Reduce an invoice — credit note', group: 'Corrections', dir: 'fix',
  when: 'The brokerage was renegotiated, or part of an invoice should never have been charged. A <b>credit note</b> is numbered against the invoice, income and the GST on it come down by that much, and what the client owes drops. If they had already paid, the difference is refunded or kept for them.',
  fields: v => {
    const inv = S().invoices.find(i => i.id === v.inv);
    return [
      F('date', 'Date', 'date', { def: today() }),
      F('inv', 'Invoice', 'select', {
        opts: S().invoices.filter(i => i.kind !== 'creditnote' && i.status !== 'void').map(i => [i.id, `${i.invoiceNo} — ${pname(i.partyId)} — ${fmt(i.total)}`]),
      }),
      F('why', 'Reason', 'text', { required: true, hint: 'Goes on the credit note.' }),
      F('amt', 'Reduce by (before GST)', 'number', { required: true, hint: inv ? `Invoice was ${fmt(inv.base)} + GST ${fmt(num(inv.cgst) + num(inv.sgst) + num(inv.igst))}` : '' }),
      F('refund', 'If they had already paid this part', 'select', {
        opts: [['hold', 'Keep it for them — an advance on the next deal'], ['1000', 'Refund it from the bank']],
        def: 'hold', show: x => inv && invoiceOutstanding(inv) + 0.005 < num(x.amt) * (1 + num(inv.gstRate) / 100),
      }),
    ];
  },
  check: v => {
    const inv = S().invoices.find(i => i.id === v.inv);
    return [
      ...dateChecks(v),
      ...(inv ? [] : [err('inv', 'Pick the invoice')]),
      ...(inv?.kind === 'creditnote' ? [err('inv', 'That is a credit note, not an invoice — pick the invoice it reduced')] : []),
      ...(inv && inv.kind !== 'creditnote' && inv.status === 'void' ? [err('inv', 'That invoice was reversed — there is nothing left to reduce')] : []),
      ...(String(v.why || '').trim() ? [] : [err('why', 'Give the reason — it is printed on the credit note')]),
      ...posAmt(v, 'amt', 'Enter how much to reduce it by'),
      ...(inv && num(v.amt) > num(inv.base) + 0.005 ? [err('amt', `The invoice was only ${fmt(inv.base)} before GST`)] : []),
    ];
  },
  build: v => {
    const inv = S().invoices.find(i => i.id === v.inv);
    if (!inv) return need('Pick the invoice.');
    const base = num(v.amt);
    if (!base) return need('Enter how much to reduce it by.');
    const rate = num(inv.gstRate);
    // After 30 November of the year following the supply's financial year the GST on an
    // invoice can no longer be reduced (s.34(2)); the note is then commercial — base only.
    const invFy = fyOf(inv.date, S().settings.fyStartMonth);
    const s34Window = `${Number(invFy.slice(0, 4)) + 1}-11-30`;
    const commercial = (v.date || today()) > s34Window;
    const tax = commercial ? 0 : r2(base * rate / 100);
    const total = r2(base + tax);
    const intra = num(inv.igst) <= 0.005;
    const split = gstHeads(tax, intra);
    const pid = inv.partyId;
    const d = inv.dealId ? deal(inv.dealId) : null;
    const acc = inv.kind === 'other' ? '4020' : (d && d.buyer?.partyId === pid ? '4010' : '4000');
    const open = invoiceOutstanding(inv);
    const offInvoice = r2(Math.min(total, open));
    const excess = r2(total - offInvoice);

    const lines = [{ acc, dr: base, party: pid, ...(inv.dealId ? { deal: inv.dealId } : {}) }];
    for (const l of outputTaxLines(tax, intra, inv.dealId ? { deal: inv.dealId } : {})) lines.push({ acc: l.acc, dr: l.cr });
    if (offInvoice > 0.005) lines.push({ acc: '1100', cr: offInvoice, party: pid, ...(inv.dealId ? { deal: inv.dealId } : {}) });
    if (excess > 0.005) {
      if (v.refund === '1000') lines.push({ acc: '1000', cr: excess });
      else lines.push({ acc: '2100', cr: excess, party: pid, ...(inv.dealId ? { deal: inv.dealId } : {}) });
    }
    return {
      desc: `Credit note — ${inv.invoiceNo}: ${v.why}`,
      lines,
      effects: [
        `Income comes down by ${fmt(base)}${tax ? ` and GST payable by ${fmt(tax)}` : ''}.`,
        commercial ? `The invoice is from FY ${esc(invFy)}, past the 30 Nov window (s.34(2)) — this is a commercial credit note and the GST cannot be reduced.` : '',
        offInvoice > 0.005 ? `${fmt(offInvoice)} comes off what ${esc(pname(pid))} still owes on ${esc(inv.invoiceNo)}.` : '',
        excess > 0.005 ? (v.refund === '1000' ? `${fmt(excess)} they had already paid is refunded from the bank.` : `${fmt(excess)} they had already paid is held for them.`) : '',
        'A numbered credit note is issued against the invoice.',
      ].filter(Boolean),
      allocations: offInvoice > 0.005 ? [{ coll: 'invoices', id: inv.id, amt: offInvoice, creditNote: true }] : [],
      creditNote: {
        against: inv.invoiceNo, againstId: inv.id, partyId: pid, dealId: inv.dealId || null,
        base, gstRate: rate, cgst: split.cgst, sgst: split.sgst, igst: split.igst, total,
        placeOfSupply: inv.placeOfSupply || null, sac: inv.sac || null, reason: v.why, date: v.date || today(),
        commercial, s34Window, itcReversalRequired: !commercial && !!S().parties.find(p => p.id === pid)?.gstin,
      },
    };
  },
};

// ═══════ GROUPING FOR THE RECORD SCREEN ═══════

// Grouped the way the owner thinks about money, not the way an accountant would. Each entry
// carries a one-line answer to the question people actually ask: "does this change my profit?"
// `dir` colours the button: green for money in, red for money out, grey for moving your own
// money around, amber for corrections, and plain for set-up.
// What the Record screen offers: seven broad categories, in the owner's own words — money in,
// money out, bills, invoices, service costs, deals, fix something — and the actions inside
// each. The screen shows the categories first and an action only after one is chosen, which
// is how the owner asked for it. An action that belongs in two places is listed in both
// (paying a bill is money out AND the end of a bill; a token is money in AND part of a deal).
//
// `kw` are the words the owner actually types into the search box — "rent", "EB", "patta" —
// so a search finds the action even when the label says it differently.
export const CHOOSER = [
  ['Money in', [
    { key: 'dealpay', kw: ['upi', 'received', 'neft', 'cheque', 'client paid', 'collection'], label: 'Client payment received', sub: 'Matched to their invoices. Profit unchanged.' },
    { key: 'token', kw: ['advance', 'earnest', 'booking', 'deposit'], label: 'Token / advance received', sub: 'Held for the client. Not income yet.' },
    { key: 'otherinc', kw: ['consultancy', 'referral', 'interest', 'valuation', 'fee'], label: 'Other income', sub: 'Consultancy, referral fee, interest — invoice or receipt.' },
    { key: 'funding', kw: ['capital', 'director', 'investment', 'infusion'], label: 'Capital / director loan received', sub: 'Financing, never income.' },
    { key: 'bankloan', kw: ['loan', 'nbfc', 'borrow'], label: 'New bank / NBFC loan', sub: 'Creates the EMI schedule.' },
  ]],
  ['Money out', [
    { key: 'expense', kw: ['rent', 'eb', 'electricity', 'fuel', 'print', 'coffee', 'tea', 'paid', 'purchase', 'shop'], label: 'Expense — paid now', sub: 'Used and paid together.' },
    { key: 'petty', kw: ['voucher', 'box', 'cash', 'small'], label: 'Petty cash spends', sub: 'Up to three spends from the box.' },
    { key: 'paybill', kw: ['vendor', 'settle', 'paid bill', 'clear'], label: 'Pay a vendor bill', sub: 'Matched to the bills it settles.' },
    { key: 'dealcost', kw: ['ec', 'patta', 'lawyer', 'legal', 'travel', 'documentation'], label: 'Cost on a deal', sub: 'EC, patta, legal — for one particular deal.' },
    { key: 'salary', kw: ['payroll', 'staff', 'bonus', 'wages', 'employee'], label: 'Salary / bonus', sub: 'Gross is the cost.' },
    { key: 'statutory', kw: ['gst', 'tds', 'pf', 'tax', 'government', 'challan', 'return'], label: 'Pay GST / TDS / PF to government', sub: 'Remitting what you held. Not a cost.' },
    { key: 'emi', kw: ['loan', 'instalment', 'installment', 'repayment'], label: 'Pay an EMI', sub: 'Only the interest is a cost.' },
    { key: 'transfer', kw: ['card bill', 'petty cash', 'top up', 'bank to', 'contra', 'withdraw', 'deposit cash'], label: 'Transfer — bank, cash box, card bill, director', sub: 'Your own money moving. Never a cost.' },
    { key: 'director', kw: ['own pocket', 'personal', 'reimburse'], label: 'Paid personally by the director', sub: 'Cost now; the company owes the director.' },
    { key: 'asset', kw: ['laptop', 'furniture', 'vehicle', 'depreciation', 'equipment'], label: 'Buy an asset (lasts over a year)', sub: 'Cash out now; the cost is spread monthly.' },
  ]],
  ['Bills', [
    { key: 'bill', kw: ['invoice received', 'vendor bill', 'due', 'credit'], label: 'Bill received — pay later', sub: 'Cost now, cash later. Goes on Owed with a due date.' },
    { key: 'billarrived', kw: ['bill number', 'invoice number', 'last month'], label: 'Vendor bill arrived for a month already recorded', sub: "Last month's rent or service, invoiced now." },
    { key: 'paybill', kw: ['vendor', 'settle', 'paid bill', 'clear'], label: 'Pay a vendor bill', sub: 'Matched to the bills it settles. Has a box for a discount they gave you.' },
    { key: 'billdiscount', kw: ['discount', 'let off', 'waived', 'concession', 'rounding'], label: 'Discount on a bill', sub: 'The vendor dropped what was left. No money moves; the bill closes.' },
    { key: 'vendorrefund', kw: ['refund', 'returned', 'credit'], label: 'Vendor refund / credit note received', sub: 'Reduces the cost and its GST credit, or returns an advance.' },
  ]],
  ['Invoices', [
    { key: 'invoice', kw: ['brokerage', 'commission', 'bill the', 'gst invoice'], label: 'Invoice the buyer', preset: { from: 'buyer' }, sub: 'Brokerage falls due. Income now; GST payable.' },
    { key: 'invoice', kw: ['brokerage', 'commission', 'bill the', 'gst invoice'], label: 'Invoice the seller', preset: { from: 'seller' }, sub: 'Brokerage falls due. Income now; GST payable.' },
    { key: 'otherinc', kw: ['consultancy', 'referral', 'interest', 'valuation', 'fee'], label: 'Invoice for other income', sub: 'Consultancy, referral fee, valuation — a numbered invoice.' },
    { key: 'creditnote', kw: ['reduce', 'discount', 'renegotiated'], label: 'Credit note — reduce an invoice', sub: 'Renegotiated brokerage. Income and GST come down.' },
  ]],
  ['Service costs', [
    { key: 'confirmcharge', kw: ['rent', 'subscription', 'retainer', 'saas', 'monthly', 'service', 'zoho', 'meta'], label: "Record this month's recurring cost", sub: 'Rent, subscriptions, retainers — paid, or due later.' },
    { key: 'subnew', kw: ['subscription', 'rent', 'retainer', 'set up'], label: 'Add a recurring cost', sub: 'Rent, a subscription, a retainer. Sets what you expect; nothing posts.' },
    { key: 'subchange', kw: ['price change', 'upgrade', 'plan'], label: 'Change what a recurring cost will be', sub: 'New expected amount from a month.' },
    { key: 'subcancel', kw: ['cancel', 'pause', 'stop'], label: 'Stop, pause or resume a recurring cost', sub: 'Unused prepaid leaves the books.' },
  ]],
  ['Deals', [
    { key: 'newdeal', kw: ['pipeline', 'listing', 'new deal', 'client'], label: 'Add a deal', sub: 'Opens it in the pipeline. Nothing posts.' },
    { key: 'register', kw: ['registration', 'deed', 'sale deed', 'closed'], label: 'Deal registered', sub: 'The milestone and its date. Nothing posts.' },
    { key: 'token', kw: ['advance', 'earnest', 'booking', 'deposit'], label: 'Token / advance received', sub: 'Held for the client. Not income yet.' },
    { key: 'dealcost', kw: ['ec', 'patta', 'lawyer', 'legal', 'travel', 'documentation'], label: 'Cost on a deal', sub: 'EC, patta, legal — for one particular deal.' },
    { key: 'settle', kw: ['refund', 'forfeit', 'token back'], label: 'Settle a token', sub: 'Apply to the invoice, refund, or keep.' },
  ]],
  ['Fix something', [
    { key: 'writeoff', kw: ['bad debt', 'will not pay', 'lost'], label: 'Write off a client balance', sub: 'Books the loss.' },
    { key: 'absorb', kw: ['recoverable', 'not repay'], label: 'Absorb a cost the client will not repay', sub: 'Recoverable becomes your expense.' },
    { key: 'assetdispose', kw: ['sell', 'scrap', 'dispose'], label: 'Sell or scrap an asset', sub: 'Gain or loss is worked out.' },
    { key: 'card2emi', kw: ['credit card', 'convert'], label: 'Convert a card purchase to EMI', sub: 'Restructures the debt.' },
  ]],
];

// Which field keys on each event hold a party, so finance-sync.js knows what to
// materialise before it calls build() for real.
export const PARTY_FIELDS = {
  newdeal: ['seller', 'buyer'],
  otherinc: ['party'],
  dealcost: ['vendor'],
  expense: ['vendor'],
  bill: ['vendor'],
  asset: ['vendor'],
  salary: ['emp'],
  bankloan: ['lender'],
  subnew: ['vendor'],
  confirmcharge: ['vendor'],
  vendorrefund: ['vendor'],
  funding: ['who'],
};

export function fieldsFor(key, v) {
  const ev = EV[key];
  if (!ev) return [];
  const list = typeof ev.fields === 'function' ? ev.fields(v || {}) : ev.fields;
  const shown = list.filter(f => typeof f.show !== 'function' || f.show(v || {}));
  // Two GST questions on one form is one too many: a form that carries the three-way answer
  // never also shows the old yes/no toggle. Decided from the field LIST, not from whether the
  // answer has been filled in, so it holds on the first paint as much as the tenth.
  return list.some(f => f.k === 'rcm') ? shown.filter(f => f.k !== 'gst') : shown;
}

// Field-level problems for the form, limited to fields that are currently visible.
export function validateEvent(key, v) {
  const ev = EV[key];
  if (!ev || !ev.check) return [];
  const visible = new Set(fieldsFor(key, v).map(f => f.k));
  let problems;
  try { problems = ev.check(v || {}) || []; } catch (e) { return [{ k: null, msg: e.message }]; }
  return problems.filter(p => !p.k || visible.has(p.k));
}

// The direction of an event for colour cues: in | out | move | fix | setup.
export const dirOf = key => EV[key]?.dir || 'setup';
