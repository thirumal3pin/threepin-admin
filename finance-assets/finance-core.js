// ═══════ 3 PIN REALTY — FINANCE CORE ═══════
//
// Ported from reference/3PIN-Finance-System-v2.html. Event-based entry on top of a
// double-entry ledger: one action the user recognises -> one balanced journal underneath.
// Every view is derived from the transaction log, so no figure is ever stored twice.
//
// This module is deliberately Firebase-free and side-effect-free so the same code runs in
// the browser and under `node --test` (the same trick crm-assets/dashboardMetrics.js uses
// to keep the CRM and api/dashboard-summary.js computing identical numbers).
// Firestore reads/writes live in finance-sync.js; the event builders live in
// finance-events.js and are pure functions over the state this module holds.

// ═══════ CHART OF ACCOUNTS ═══════

export const ACCOUNTS = [
  ['1000', 'Bank', 'asset'],
  ['1010', 'Petty cash', 'asset'],
  ['1100', 'Receivable from clients', 'asset'],
  ['1150', 'TDS receivable (deducted by clients)', 'asset'],
  ['1200', 'Prepaid expenses', 'asset'],
  ['1300', 'Fixed assets', 'asset'],
  ['1350', 'Accumulated depreciation', 'asset'],
  ['1400', 'GST input credit — CGST', 'asset'],
  ['1401', 'GST input credit — SGST', 'asset'],
  ['1402', 'GST input credit — IGST', 'asset'],
  ['1405', 'GST on bills not yet received', 'asset'],
  ['1500', 'Advances to staff', 'asset'],
  ['1550', 'Advances to vendors', 'asset'],

  ['2000', 'Payable to vendors & partners', 'liability'],
  ['2100', 'Advances held from clients', 'liability'],
  ['2200', 'GST payable — CGST', 'liability'],
  ['2201', 'GST payable — SGST', 'liability'],
  ['2202', 'GST payable — IGST', 'liability'],
  ['2205', 'GST payable — reverse charge', 'liability'],
  ['2250', 'TDS payable', 'liability'],
  ['2300', 'Credit card', 'liability'],
  ['2400', 'Loans', 'liability'],
  ['2450', "Director's account", 'liability'],
  ['2550', 'Statutory deductions payable', 'liability'],

  ['3000', 'Share capital', 'equity'],
  ['3100', 'Opening balance equity', 'equity'],

  ['4000', 'Brokerage — seller side', 'income'],
  ['4010', 'Brokerage — buyer side', 'income'],
  ['4020', 'Consultancy income', 'income'],
  ['4030', 'Forfeited advances', 'income'],
  ['4040', 'Other income', 'income'],
  ['4050', 'Bad debts recovered', 'income'],
  ['4060', 'Discounts received', 'income'],

  ['5000', 'Rent', 'expense'],
  ['5010', 'Salaries', 'expense'],
  ['5020', 'Bonus & incentives', 'expense'],
  ['5030', 'Staff welfare & food', 'expense'],
  ['5040', 'Commission & referral fees', 'expense'],
  ['5045', 'Deal costs (EC, patta, legal, docs)', 'expense'],
  ['5050', 'Conveyance & fuel', 'expense'],
  ['5060', 'Electricity', 'expense'],
  ['5070', 'Internet & phone', 'expense'],
  ['5080', 'Software & subscriptions', 'expense'],
  ['5090', 'Advertising & marketing', 'expense'],
  ['5100', 'Printing & stationery', 'expense'],
  ['5110', 'Photography & video', 'expense'],
  ['5120', 'Professional fees (CA, legal)', 'expense'],
  ['5130', 'Repairs & maintenance', 'expense'],
  ['5140', 'Bank & card charges', 'expense'],
  ['5150', 'Interest & finance cost', 'expense'],
  ['5160', 'Rates, taxes & filing fees', 'expense'],
  ['5165', 'Penalties & late-payment charges', 'expense'],
  ['5075', 'Club & membership fees', 'expense'],
  ['5170', 'Insurance', 'expense'],
  ['5185', 'Gifts & client hospitality', 'expense'],
  ['5180', 'Miscellaneous', 'expense'],
  ['5190', 'Bad debts written off', 'expense'],
  ['5200', 'Depreciation', 'expense'],
  ['5210', 'Subscription cancellation loss', 'expense'],
  ['5220', 'Loss on disposal of assets', 'expense'],
  ['5225', 'Discounts allowed & short receipts', 'expense'],
  ['5230', 'Prior-period adjustments', 'expense'],
].map(([code, name, type]) => ({ code, name, type }));

export const A = Object.fromEntries(ACCOUNTS.map(a => [a.code, a]));
// Every account of a type, for the screens that drill into a total made of all of them.
export const INCOME_ACCS = ACCOUNTS.filter(a => a.type === 'income').map(a => a.code);
export const EXPENSE_ACCS = ACCOUNTS.filter(a => a.type === 'expense').map(a => a.code);
// Costs the income-tax computation adds back. Kept as data so the tax provision and the
// year-end pack can show them without anyone remembering which codes they were.
// Costs the income-tax computation adds back. A bad debt written off is NOT one of them:
// s.36(1)(vii) with TRF Ltd v. CIT (2010) 323 ITR 397 (SC) — writing it off in the books is
// enough, the assessee need not prove the debt became irrecoverable.
export const DISALLOWED = new Set(['5165']);

// Categories a user may pick on a plain expense or bill. Excludes the accounts the engine
// reaches on its own (write-offs, depreciation, cancellation loss, interest, disposal loss).
// 5040 IS pickable: the Realtor Club event is gone, but referral fees are a normal cost.
export const EXP = ACCOUNTS.filter(
  a => a.type === 'expense' && !['5150', '5165', '5190', '5200', '5210', '5220', '5225', '5230'].includes(a.code));

// Typing a state by hand silently flips CGST+SGST to IGST on an invoice, so it is chosen.
export const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra & Nagar Haveli and Daman & Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu & Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh',
  'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman & Nicobar Islands', 'Other Territory',
];

export const PAY_VIA = [['1000', 'Bank (1000)'], ['2300', 'Credit card (2300)'], ['1010', 'Petty cash (1010)']];

// How the money moved through the bank account. Not an account: UPI, a debit card and
// NetBanking all draw on the same balance. Kept on the entry so a statement line can be
// matched by it and the owner can see how something was paid.
export const PAY_METHODS = [
  ['upi', 'UPI'], ['debit', 'Debit card'], ['netbanking', 'NetBanking / NEFT'],
  ['cheque', 'Cheque'], ['cash', 'Cash at the counter'],
];
export const methodLabel = m => PAY_METHODS.find(x => x[0] === m)?.[1] || '';

// What a recurring commitment is for. Each kind has the expense account its months post to;
// a service is only one kind of thing a business pays for every month.
export const RECURRING_KINDS = [
  ['service', 'Service / subscription', '5080'],
  ['rent', 'Rent', '5000'],
  ['salary', 'Salary / retainer', '5010'],
  ['utility', 'Electricity / internet / phone', '5070'],
  ['insurance', 'Insurance', '5170'],
  ['marketing', 'Advertising / listings', '5090'],
  ['other', 'Other recurring cost', '5180'],
];
export const recurringAcc = sub => sub?.acc || RECURRING_KINDS.find(k => k[0] === (sub?.kind || 'service'))?.[2] || '5080';
export const recurringKindLabel = sub => RECURRING_KINDS.find(k => k[0] === (sub?.kind || 'service'))?.[1] || 'Service / subscription';

export const TDS_SECTIONS = [
  ['none', 'No TDS', 0],
  ['194H', '194H — Commission / brokerage', 2],
  ['194J', '194J — Professional fees', 10],
  ['194I', '194I — Rent', 10],
  ['194C', '194C — Contractor', 2],
];

// ═══════ SMALL HELPERS ═══════

export const num = v => Number(v) || 0;
export const today = () => new Date().toISOString().slice(0, 10);
export const ym = d => String(d || '').slice(0, 7);

export function addMonths(y, n) {
  const [a, b] = y.split('-').map(Number);
  const d = new Date(a, b - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

export const mlabel = y =>
  new Date(y + '-01T00:00:00').toLocaleString('en-IN', { month: 'short', year: 'numeric' });

// ═══════ DISPLAY CURRENCY ═══════
//
// The books are kept in rupees and always will be — every stored figure, every journal line,
// every invoice. This is a lens for reading them: flip to USD and every displayed amount is
// divided by the live rate, so an owner can size the business against a dollar figure without
// anything in the ledger changing. Nothing converted is ever written back.

const CUR = { code: 'INR', rate: 1, at: null };

export const displayCurrency = () => ({ ...CUR });

// rate is rupees per dollar, so INR ÷ rate = USD.
export function setDisplayCurrency(code, rate, at) {
  CUR.code = code === 'USD' ? 'USD' : 'INR';
  if (rate) CUR.rate = num(rate) || 1;
  if (at) CUR.at = at;
  return displayCurrency();
}

// Indian digit grouping: 12,34,567 — not 1,234,567.
function inr(n) {
  const neg = num(n) < 0;
  let s = String(Math.abs(Math.round(num(n))));
  if (s.length > 3) s = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  return (neg ? '−' : '') + '₹' + s;
}

// Always rupees, whatever the toggle says — for invoices and anything else that is a record
// rather than a reading.
export const fmtInr = inr;

export function fmt(n) {
  if (CUR.code === 'INR') return inr(n);
  const v = num(n) / (CUR.rate || 1);
  const abs = Math.abs(v);
  // Small amounts keep their cents; anything you would quote as a round figure loses them.
  const digits = abs < 100 ? 2 : 0;
  return (v < 0 ? '−' : '') + '$' + abs.toLocaleString('en-US', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Financial year label for a date, honouring settings.fyStartMonth (4 = April).
export function fyOf(date, fyStartMonth) {
  const start = fyStartMonth || 4;
  const [y, m] = String(date).split('-').map(Number);
  const startYear = m >= start ? y : y - 1;
  return String(startYear) + '-' + String((startYear + 1) % 100).padStart(2, '0');
}

// Rupee amount in words, for the invoice.
export function words(n) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
    'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = x => x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '');
  const three = x => x >= 100
    ? ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' + two(x % 100) : '')
    : two(x);
  let v = Math.round(num(n));
  if (v === 0) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(v / 10000000); v %= 10000000;
  const lakh = Math.floor(v / 100000); v %= 100000;
  const thousand = Math.floor(v / 1000); v %= 1000;
  if (crore) parts.push(three(crore) + ' Crore');
  if (lakh) parts.push(three(lakh) + ' Lakh');
  if (thousand) parts.push(three(thousand) + ' Thousand');
  if (v) parts.push(three(v));
  return parts.join(' ') + ' Rupees Only';
}

// ═══════ IN-MEMORY STATE ═══════
//
// Populated once by the onSnapshot listeners in finance-sync.js and kept live from then on.
// Views read from here and never re-query Firestore — that is what keeps the page responsive
// at 5,000 transactions on a phone.

export function defaultSettings() {
  return {
    companyName: '3 PIN Realty Pvt Ltd',
    gstin: '', address: '', state: 'Tamil Nadu',
    phone: '', email: '',
    gstRate: 18, sacCode: '997221',
    fyStartMonth: 4,
    booksStartDate: '2026-09-01',
    tdsEnabled: false,
    tdsRates: { '194H': 2, '194J': 10, '194I': 10, '194C': 2 },
    invoicePrefix: '3PIN/26-27/', nextInvoiceNo: 1,
    creditNotePrefix: '3PIN/CN/26-27/', nextCreditNoteNo: 1,
    sacCodes: { brokerage: '997221', consultancy: '998311' },
    incomeTaxRate: 26,              // 25% + 4% cess. s.115BAA's 25.168% needs Form 10-IC.
    tdsThresholds: { '194H': 20000, '194J': 50000, '194I': 600000, '194C': 100000 },
    capitalisationThreshold: 5000,
    emailDigest: { enabled: true, to: [] },
    bankAccounts: [],
    bankDetails: { bankName: '', accountName: '', accountNo: '', ifsc: '', branch: '' },
    attachmentBackend: 'drive',     // 'storage' | 'drive'
    driveFolderId: '',              // Drive folder that holds finance attachments
    openingPosted: false,
    columnMappings: {},
  };
}

export function blank() {
  return {
    settings: defaultSettings(),
    parties: [], deals: [], txns: [], subs: [], loans: [], assets: [],
    invoices: [], bills: [], bankStatements: [], monthEnds: {},
  };
}

let S = blank();

export const getState = () => S;
export const setState = next => { S = next; return S; };

// ═══════ LOOKUPS ═══════

export const party = id => S.parties.find(p => p.id === id) || null;
export const pname = id => (party(id) || {}).name || '—';
export const deal = id => S.deals.find(d => d.id === id) || null;
export const dname = id => {
  const d = deal(id);
  return d ? (d.nickname || d.propertyName || d.id) : '—';
};
export const sub = id => S.subs.find(s => s.id === id) || null;
export const loan = id => S.loans.find(l => l.id === id) || null;
export const asset = id => S.assets.find(a => a.id === id) || null;

// A deal's parties as [value, label] pairs for a <select>.
export function partySides(dealId) {
  const d = deal(dealId);
  if (!d) return [];
  const out = [];
  if (d.seller?.partyId) out.push(['seller', 'Seller — ' + (d.seller.name || pname(d.seller.partyId))]);
  if (d.buyer?.partyId) out.push(['buyer', 'Buyer — ' + (d.buyer.name || pname(d.buyer.partyId))]);
  (d.others || []).forEach((o, i) => {
    if (o.partyId) out.push(['other:' + i, (o.role || 'Other') + ' — ' + (o.name || pname(o.partyId))]);
  });
  return out;
}

// Resolve a 'seller' | 'buyer' | 'other:N' side token to a party id.
export function sideParty(d, side) {
  if (!d || !side) return null;
  if (side === 'seller') return d.seller?.partyId || null;
  if (side === 'buyer') return d.buyer?.partyId || null;
  const m = /^other:(\d+)$/.exec(side);
  if (m && d.others?.[+m[1]]) return d.others[+m[1]].partyId || null;
  return null;
}

// ═══════ DERIVED FIGURES ═══════
//
// Sign convention, same as the reference: bal() returns a positive number when the account
// holds what its type implies — assets and expenses debit-positive, everything else
// credit-positive. Reversed transactions are NOT filtered out: a reversal posts its own
// mirror-image entry, so the pair already nets to zero wherever it is counted.

// A reversed entry and the reversal that undid it. Together they moved nothing.
export const isUndone = t => !!(t && (t.reversedBy || t.reversalOf));

// Has this side of a deal been invoiced — a brokerage invoice for that party on that deal,
// not voided, not a credit note? Once it has, the side's estimate leaves every projection:
// the real figure is on the invoice.
export function sideInvoiced(d, side) {
  const pid = d?.[side]?.partyId;
  if (!pid) return false;
  return S.invoices.some(i => i.dealId === d.id && i.partyId === pid && i.kind !== 'creditnote' && i.status !== 'void');
}

export function bal(code, f = {}) {
  let s = 0;
  for (const t of S.txns) {
    // The pair nets to zero whenever both halves are inside the range asked for. skipUndone
    // is for the cash book's opening and the reconciliation's book balance, where a pair
    // straddling the cut-off date would otherwise leave a movement that never happened.
    if (f.skipUndone && isUndone(t)) continue;
    if (f.upto && t.date > f.upto) continue;
    if (f.from && t.date < f.from) continue;
    if (f.month && ym(t.date) !== f.month) continue;
    if (f.event && t.event !== f.event) continue;
    if (f.notEvent && t.event === f.notEvent) continue;
    for (const l of t.lines) {
      if (l.acc !== code) continue;
      if (f.party && l.party !== f.party) continue;
      if (f.deal && l.deal !== f.deal) continue;
      s += num(l.dr) - num(l.cr);
    }
  }
  const ty = A[code].type;
  return (ty === 'asset' || ty === 'expense') ? s : -s;
}

// Balance per party for one account: who owes us (1100), who we owe (2000), tokens held (2100).
export function partyBalances(code, f = {}) {
  const m = {};
  const ty = A[code].type;
  const sign = (ty === 'asset' || ty === 'expense') ? 1 : -1;
  for (const t of S.txns) {
    if (f.upto && t.date > f.upto) continue;
    for (const l of t.lines) {
      if (l.acc !== code || !l.party) continue;
      m[l.party] = (m[l.party] || 0) + sign * (num(l.dr) - num(l.cr));
    }
  }
  return m;
}

// Profit & loss. month = 'YYYY-MM' or null for all time; fy = '2026-27' for a full year.
export function pl(month, dealId, fy) {
  const inc = {}, exp = {};
  for (const t of S.txns) {
    if (month && ym(t.date) !== month) continue;
    if (fy && fyOf(t.date, S.settings.fyStartMonth) !== fy) continue;
    for (const l of t.lines) {
      if (dealId && l.deal !== dealId) continue;
      const a = A[l.acc];
      if (!a) continue;
      if (a.type === 'income') inc[l.acc] = (inc[l.acc] || 0) + num(l.cr) - num(l.dr);
      if (a.type === 'expense') exp[l.acc] = (exp[l.acc] || 0) + num(l.dr) - num(l.cr);
    }
  }
  const ti = Object.values(inc).reduce((a, b) => a + b, 0);
  const te = Object.values(exp).reduce((a, b) => a + b, 0);
  return { inc, exp, ti, te, profit: ti - te };
}

// Retained profit up to a date — the plug that makes the balance sheet tie.
export function retainedProfit(upto) {
  let ti = 0, te = 0;
  for (const t of S.txns) {
    if (upto && t.date > upto) continue;
    for (const l of t.lines) {
      const a = A[l.acc];
      if (!a) continue;
      if (a.type === 'income') ti += num(l.cr) - num(l.dr);
      if (a.type === 'expense') te += num(l.dr) - num(l.cr);
    }
  }
  return ti - te;
}

// Trial balance: every account with movement, as raw debit and credit totals.
export function trialBalance(upto) {
  const rows = [];
  for (const a of ACCOUNTS) {
    let d = 0, c = 0;
    for (const t of S.txns) {
      if (upto && t.date > upto) continue;
      for (const l of t.lines) {
        if (l.acc !== a.code) continue;
        d += num(l.dr); c += num(l.cr);
      }
    }
    if (d || c) rows.push({ acc: a, debit: d, credit: c, net: d - c });
  }
  const totalDr = rows.reduce((s, r) => s + Math.max(r.net, 0), 0);
  const totalCr = rows.reduce((s, r) => s + Math.max(-r.net, 0), 0);
  return { rows, totalDr, totalCr, balanced: Math.abs(totalDr - totalCr) < 0.5 };
}

// Balance sheet as of a date: assets = liabilities + equity + retained profit.
// 1350 Accumulated depreciation is a contra-asset — bal() returns it debit-positive, i.e.
// already negative in practice, so it subtracts correctly inside the asset total.
export function balanceSheet(upto) {
  const pick = type => ACCOUNTS.filter(a => a.type === type)
    .map(a => ({ acc: a, amt: bal(a.code, { upto }) }))
    .filter(r => Math.abs(r.amt) > 0.5);

  const assets = pick('asset');
  const liabilities = pick('liability');
  const equity = pick('equity');
  const totalAssets = assets.reduce((s, r) => s + r.amt, 0);
  const totalLiab = liabilities.reduce((s, r) => s + r.amt, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amt, 0);
  const retained = retainedProfit(upto);
  const diff = totalAssets - (totalLiab + totalEquity + retained);
  return {
    assets, liabilities, equity,
    totalAssets, totalLiab, totalEquity, retained,
    diff, balanced: Math.abs(diff) < 0.5,
  };
}

// Ledger for one account: every line that touched it, with a running balance.
export function ledger(code, f = {}) {
  const ty = A[code].type;
  const sign = (ty === 'asset' || ty === 'expense') ? 1 : -1;
  const rows = [];
  const sorted = [...S.txns].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  let running = 0;
  for (const t of sorted) {
    if (f.from && t.date < f.from) continue;
    if (f.upto && t.date > f.upto) continue;
    for (const l of t.lines) {
      if (l.acc !== code) continue;
      if (f.party && l.party !== f.party) continue;
      running += sign * (num(l.dr) - num(l.cr));
      rows.push({
        txnId: t.id, date: t.date, desc: t.desc, event: t.event,
        dr: num(l.dr), cr: num(l.cr), party: l.party || null, deal: l.deal || null,
        balance: running,
      });
    }
  }
  return rows;
}

// EMI amortisation.
//
// Each instalment is posted to the ledger as whole rupees, so the ROUNDED principals are what
// actually reduce account 2400 — and rounding each one independently lets them drift a rupee
// or two away from the amount borrowed, leaving a residue on the loan that never clears.
// Instead the rounded closing balance is computed first and each principal is taken as the
// drop between one rounded balance and the next. That makes the principals sum to exactly the
// amount borrowed by construction, and the final balance land on precisely zero.
export function schedule(P, rate, n, startYM) {
  const r = num(rate) / 1200;
  const emi = r ? P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1) : P / n;
  const out = [];
  let exact = P;
  let prevBal = Math.round(P);
  for (let i = 1; i <= n; i++) {
    const int = exact * r;
    let prin = emi - int;
    if (i === n) prin = exact;
    exact -= prin;
    const bal = i === n ? 0 : Math.round(Math.max(exact, 0));
    const roundedPrin = prevBal - bal;
    const roundedInt = Math.round(int);
    out.push({
      n: i, month: addMonths(startYM, i - 1),
      emi: roundedPrin + roundedInt, int: roundedInt, prin: roundedPrin, bal,
    });
    prevBal = bal;
  }
  return out;
}

export const prepaidLeft = s => Math.max(0, num(s.amount) - (s.amortized || []).length * num(s.monthly));

// Per-deal economics for the deal drawer and the Owed view.
export function dealFigures(d) {
  const p = pl(null, d.id);
  return {
    income: p.ti, costs: p.te, net: p.profit,
    tokens: bal('2100', { deal: d.id }),
    recv: bal('1100', { deal: d.id }),
  };
}

// Cash position for the Overview. "Free to use" strips out money that is not really ours.
export function cashPosition(upto) {
  const bank = bal('1000', { upto }), petty = bal('1010', { upto }), card = bal('2300', { upto });
  const vendorDues = bal('2000', { upto }), tokens = bal('2100', { upto });
  return {
    bank, petty, card, cash: bank + petty,
    free: bank + petty - card - vendorDues - tokens,
    vendorDues, tokens,
    receivable: bal('1100', { upto }),
    loans: bal('2400', { upto }),
    gstDue: gstOutputBal({ upto }) - gstInputBal({ upto }) + bal('2205', { upto }),
    tdsDue: bal('2250', { upto }),
  };
}

// Monthly run-rate across active services, regardless of how each one is paid. The
// expectation for a month is the plan that was in force THAT month — a rise dated for
// January must not inflate today's run-rate, which is why this reads the history rather
// than sub.monthly (which always holds the latest plan entered).
export function serviceRunRate(month) {
  const m = month || ym(today());
  const active = S.subs.filter(s => s.status === 'active');
  const at = x => x.payMode === 'upfront' ? num(x.monthly) : expectedFor(x, m);
  return {
    active,
    monthly: r2(active.reduce((s, x) => s + at(x), 0)),
    annual: r2(active.reduce((s, x) => s + at(x), 0) * 12),
    prepaidUnused: S.subs
      .filter(s => s.payMode === 'upfront' && !s.closedOut)
      .reduce((s, x) => s + prepaidLeft(x), 0),
  };
}

// ═══════ MONTH END ═══════
//
// Idempotent by construction: each subscription and asset records the months it has already
// been processed for, and those are skipped. Running month-end twice posts nothing the
// second time. Returns the entries to post; finance-sync.js writes them in one batch.

export function monthEndEntries(m) {
  const entries = [];
  for (const s of S.subs) {
    if (s.payMode !== 'upfront' || s.closedOut) continue;
    if (m < s.start || (s.end && m > s.end)) continue;
    if ((s.amortized || []).includes(m)) continue;
    // The final month releases whatever is left, so the rounded slices always sum to the
    // amount actually paid and 1200 closes at zero.
    const doneM = (s.amortized || []).length;
    const left = prepaidLeft(s);
    const slice = doneM + 1 >= num(s.months) ? left : Math.min(num(s.monthly), left);
    if (slice <= 0.005) continue;
    entries.push({
      kind: 'prepaid', ref: s.id,
      txn: {
        date: m + '-28', event: 'monthend', auto: true,
        desc: `Prepaid released — ${s.name} (${mlabel(m)})`,
        lines: [{ acc: '5080', dr: r2(slice) }, { acc: '1200', cr: r2(slice) }],
      },
    });
  }
  for (const a of S.assets) {
    if (a.status !== 'in use') continue;
    if (m < a.start) continue;
    if ((a.depreciated || []).includes(m)) continue;
    if ((a.depreciated || []).length >= a.life) continue;
    const doneA = (a.depreciated || []).length;
    const written = r2(doneA * num(a.monthly));
    const slice = doneA + 1 >= num(a.life) ? r2(num(a.cost) - written) : num(a.monthly);
    if (slice <= 0.005) continue;
    entries.push({
      kind: 'depreciation', ref: a.id,
      txn: {
        date: m + '-28', event: 'monthend', auto: true,
        desc: `Depreciation — ${a.name} (${mlabel(m)})`,
        lines: [{ acc: '5200', dr: slice }, { acc: '1350', cr: slice }],
      },
    });
  }
  return entries;
}

// ═══════ VALIDATION ═══════

// Round every leg to paise, then make the largest line absorb any residual drift, so an
// entry built from percentages can never fail the balance check by a rounding crumb.
export function normalise(lines) {
  const out = lines
    .filter(l => num(l.dr) || num(l.cr))
    .map(l => {
      const o = { acc: l.acc };
      if (num(l.dr)) o.dr = Math.round(num(l.dr) * 100) / 100;
      if (num(l.cr)) o.cr = Math.round(num(l.cr) * 100) / 100;
      if (l.party) o.party = l.party;
      if (l.deal) o.deal = l.deal;
      if (l.method) o.method = l.method;
      return o;
    });
  const dr = out.reduce((s, l) => s + num(l.dr), 0);
  const cr = out.reduce((s, l) => s + num(l.cr), 0);
  const drift = Math.round((dr - cr) * 100) / 100;
  if (drift && Math.abs(drift) < 0.5 && out.length) {
    let big = out[0];
    for (const l of out) {
      if (Math.max(num(l.dr), num(l.cr)) > Math.max(num(big.dr), num(big.cr))) big = l;
    }
    if (num(big.dr)) big.dr = Math.round((big.dr - drift) * 100) / 100;
    else big.cr = Math.round((big.cr + drift) * 100) / 100;
  }
  return out;
}

// Throws with a message meant to be shown to the user as-is.
export function validate(t) {
  const lines = normalise(t.lines || []);
  if (!lines.length) throw new Error('Nothing to post');
  const dr = lines.reduce((s, l) => s + num(l.dr), 0);
  const cr = lines.reduce((s, l) => s + num(l.cr), 0);
  if (Math.abs(dr - cr) > 0.5) {
    throw new Error('Entry does not balance (' + fmt(dr) + ' vs ' + fmt(cr) + ')');
  }
  for (const l of lines) {
    if (!A[l.acc]) throw new Error('Unknown account ' + l.acc);
  }
  const start = S.settings.booksStartDate;
  if (start && t.date && t.date < start) {
    throw new Error('Date is before the books start (' + start + ')');
  }
  return { lines, dr, cr };
}

// A reversal is the same lines with debit and credit swapped.
export function reversalLines(lines) {
  return lines.map(l => {
    const o = { acc: l.acc };
    if (num(l.dr)) o.cr = num(l.dr);
    if (num(l.cr)) o.dr = num(l.cr);
    if (l.party) o.party = l.party;
    if (l.deal) o.deal = l.deal;
    return o;
  });
}

// ═══════ GST ═══════
//
// CGST + SGST when the client is in the company's own state (or the state is unknown);
// IGST otherwise. Tamil Nadu is the company state per settings.

export function splitGst(base, rate, clientState, companyState) {
  const total = num(base) * num(rate) / 100;
  const home = (companyState || 'Tamil Nadu').trim().toLowerCase();
  const theirs = (clientState || '').trim().toLowerCase();
  const intra = !theirs || theirs === home;
  return intra
    ? { cgst: total / 2, sgst: total / 2, igst: 0, total }
    : { cgst: 0, sgst: 0, igst: total, total };
}


// ═══════ GST — HEADS, SET-OFF, RETURNS ═══════
//
// GST is three taxes, not one. Output tax is CGST+SGST on an in-state supply or IGST on an
// inter-state one, and input credit arrives the same way from vendors. They live in separate
// ledgers because GSTR-3B reports each head on its own, and because credit can only be used
// across heads in one fixed order (Rule 88A). A single "GST" account would make the return
// impossible to fill and the set-off impossible to check.

export const GST_INPUT = { cgst: '1400', sgst: '1401', igst: '1402' };
export const GST_OUTPUT = { cgst: '2200', sgst: '2201', igst: '2202' };
export const GST_RCM = '2205';
const HEADS = ['cgst', 'sgst', 'igst'];
const r2 = x => Math.round(num(x) * 100) / 100;
const pad2 = n => String(n).padStart(2, '0');
const isoLocal = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

export const gstInputBal = (f = {}) => HEADS.reduce((a, h) => a + bal(GST_INPUT[h], f), 0);
export const gstOutputBal = (f = {}) => HEADS.reduce((a, h) => a + bal(GST_OUTPUT[h], f), 0);

// Split one tax figure into heads. In-state: half CGST, half SGST, the odd paisa to SGST.
export function gstHeads(tax, intra) {
  const t = r2(tax);
  if (!intra) return { cgst: 0, sgst: 0, igst: t };
  const half = r2(t / 2);
  return { cgst: half, sgst: r2(t - half), igst: 0 };
}

export function outputTaxLines(tax, intra, extra = {}) {
  const h = gstHeads(tax, intra);
  return HEADS.filter(k => h[k] > 0.004).map(k => ({ acc: GST_OUTPUT[k], cr: h[k], ...extra }));
}

export function inputTaxLines(tax, intra, extra = {}) {
  const h = gstHeads(tax, intra);
  return HEADS.filter(k => h[k] > 0.004).map(k => ({ acc: GST_INPUT[k], dr: h[k], ...extra }));
}

// Rule 88A set-off. IGST credit is used first and against anything; CGST credit against CGST
// then IGST; SGST credit against SGST then IGST; CGST and SGST never cross.
export function gstSetOff(liability, credit) {
  const L = { cgst: r2(liability.cgst), sgst: r2(liability.sgst), igst: r2(liability.igst) };
  const C = { cgst: r2(credit.cgst), sgst: r2(credit.sgst), igst: r2(credit.igst) };
  const util = [];
  const use = (from, to) => {
    const a = r2(Math.min(C[from], L[to]));
    if (a <= 0.004) return;
    C[from] = r2(C[from] - a);
    L[to] = r2(L[to] - a);
    util.push({ from, to, amt: a });
  };
  use('igst', 'igst'); use('igst', 'cgst'); use('igst', 'sgst');
  use('cgst', 'cgst'); use('cgst', 'igst');
  use('sgst', 'sgst'); use('sgst', 'igst');
  return { util, payable: L, carry: C };
}

// Debit-minus-credit movement on an account within a month, optionally leaving one kind of
// event out — the remittance itself must not count as that month's liability.
function movement(code, month, notEvent) {
  let s = 0;
  for (const t of S.txns) {
    if (ym(t.date) !== month) continue;
    if (notEvent && t.event === notEvent) continue;
    for (const l of t.lines) if (l.acc === code) s += num(l.dr) - num(l.cr);
  }
  return s;
}

// Mirrors BLOCKED_ITC in finance-events.js: categories whose GST can never be claimed.
const BLOCKED = new Set(['5030', '5050', '5075', '5185']);

// Everything GSTR-3B needs for one month, and the set-off the remittance should use.
//
// Liability and credit are the balances as at the month's end, so an earlier month left
// unpaid is still owed. A remittance for this month is normally posted in the next one, so
// any statutory entry tagged with this month is subtracted whatever its date — that is what
// makes paying the same month twice show a zero.
export function gstComputation(month) {
  const end = month + '-31';
  const output = {}, availed = {}, liability = {}, credit = {};
  for (const h of HEADS) {
    output[h] = r2(-movement(GST_OUTPUT[h], month, 'statutory'));
    availed[h] = r2(movement(GST_INPUT[h], month, 'statutory'));
    liability[h] = r2(bal(GST_OUTPUT[h], { upto: end, notEvent: 'statutory' }));
    credit[h] = r2(bal(GST_INPUT[h], { upto: end, notEvent: 'statutory' }));
  }
  let rcmDue = r2(bal(GST_RCM, { upto: end, notEvent: 'statutory' }));
  const rcmMonth = r2(-movement(GST_RCM, month, 'statutory'));

  // Remittances already made — for this month, or for earlier months (dated up to the end
  // of this one) — come off the balances.
  for (const t of S.txns) {
    if (t.event !== 'statutory') continue;
    const forMonth = t.meta?.month;
    const counts = forMonth ? forMonth <= month : t.date <= end;
    if (!counts) continue;
    for (const l of t.lines) {
      for (const h of HEADS) {
        if (l.acc === GST_OUTPUT[h]) liability[h] = r2(liability[h] - num(l.dr) + num(l.cr));
        if (l.acc === GST_INPUT[h]) credit[h] = r2(credit[h] - num(l.cr) + num(l.dr));
      }
      if (l.acc === GST_RCM) rcmDue = r2(rcmDue - num(l.dr) + num(l.cr));
    }
  }
  for (const h of HEADS) { liability[h] = Math.max(0, liability[h]); credit[h] = Math.max(0, credit[h]); }
  rcmDue = Math.max(0, rcmDue);

  let blocked = 0;
  for (const t of S.txns) {
    if (ym(t.date) !== month) continue;
    const m = t.meta || {};
    if (m.gst === 'yes' && BLOCKED.has(m.acc)) blocked += num(m.gstAmt);
  }
  const setoff = gstSetOff(liability, credit);
  const cash = r2(HEADS.reduce((a, h) => a + setoff.payable[h], 0) + rcmDue);
  return { month, output, availed, liability, credit, rcmMonth, rcmDue, blocked: r2(blocked), setoff, cash };
}

// Outward register for GSTR-1: every invoice and credit note of the month.
export function gstr1Rows(month) {
  return S.invoices
    .filter(i => ym(i.date) === month)
    .map(i => {
      const p = S.parties.find(x => x.id === i.partyId);
      const cn = i.kind === 'creditnote';
      const sign = cn ? -1 : 1;
      const interState = String(i.placeOfSupply || S.settings.state).trim().toLowerCase()
        !== String(S.settings.state || '').trim().toLowerCase();
      const type = cn
        ? (p?.gstin ? 'CDNR' : 'CDNUR')
        : p?.gstin ? 'B2B'
          : (interState && num(i.total) > 250000) ? 'B2CL' : 'B2CS';
      return {
        type,
        no: i.invoiceNo, date: i.date, party: p?.name || '', gstin: p?.gstin || '',
        placeOfSupply: i.placeOfSupply || S.settings.state, sac: i.sac || S.settings.sacCode,
        taxable: sign * num(i.base), rate: num(i.gstRate),
        cgst: sign * num(i.cgst), sgst: sign * num(i.sgst), igst: sign * num(i.igst),
        total: sign * num(i.total), against: i.against || '',
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.no).localeCompare(String(b.no)));
}

// Inward register: every purchase carrying GST, and what each credit claim rests on. A claim
// needs a tax invoice from a registered vendor — without the GSTIN and invoice number it is
// a figure in the books that GSTR-2B will never match.
const ITC_EVENTS = new Set(['expense', 'bill', 'dealcost', 'asset', 'subnew', 'confirmcharge']);
export function itcRegister(month) {
  const rows = [];
  for (const t of S.txns) {
    if (ym(t.date) !== month || !ITC_EVENTS.has(t.event)) continue;
    const m = t.meta || {};
    const rcm = m.rcm === 'yes';
    // s.16(4): credit for a financial year may be taken up to 30 November of the next one.
    // Booking an old invoice late is the commonest way a claim is lost.
    const invFy = fyOf(m.vinvDate || t.date, S.settings.fyStartMonth);
    const timeBarred = !rcm && t.date > `${Number(invFy.slice(0, 4)) + 1}-11-30`;
    if (m.gst !== 'yes' && !rcm) continue;
    const heads = {};
    for (const h of HEADS) {
      heads[h] = r2(t.lines.filter(l => l.acc === GST_INPUT[h]).reduce((a, l) => a + num(l.dr) - num(l.cr), 0));
    }
    const blocked = BLOCKED.has(m.acc) && !rcm;
    const vendorLine = t.lines.find(l => l.acc === '2000' && l.party);
    const vendor = vendorLine ? (S.parties.find(p => p.id === vendorLine.party)?.name || '') : (m.vendor ? pname(m.vendor) : '');
    const tax = rcm ? heads.cgst + heads.sgst + heads.igst : num(m.gstAmt);
    rows.push({
      no: t.no, date: t.date, desc: t.desc, vendor, gstin: m.vgstin || '', invoice: m.vinv || '',
      taxable: num(m.amt), tax: r2(tax), ...heads, blocked, rcm,
      eligible: !blocked && !timeBarred && (rcm || (!!m.vgstin && !!m.vinv)),
      timeBarred,
      reason: blocked ? 'Blocked under s.17(5) — part of the cost'
        : timeBarred ? `Time-barred under s.16(4) — the window for FY ${invFy} closed on 30 Nov ${Number(invFy.slice(0, 4)) + 1}`
          : rcm ? 'Reverse charge — pay in cash with the return, then claim'
            : (!m.vgstin || !m.vinv) ? 'Vendor GSTIN or invoice no. missing — claim at risk' : '',
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || num(a.no) - num(b.no));
}

// ═══════ RULE 37 — ITC ON BILLS UNPAID FOR 180 DAYS ═══════
//
// s.16(2) second proviso with Rule 37(1): credit taken on a supply whose consideration is
// not paid within 180 days of the invoice date must be added back to output liability, with
// interest under s.50(1). It is reclaimed when the bill is finally paid. Nothing here posts
// anything — it lists what the return has to carry, because only the CA can decide the
// interest period.

// The input credit a bill actually took, head by head, read back from the entries that
// created and trued it up — never re-derived from a rate. Netting across those entries is
// what makes it right in every shape the app can produce: an accrual parks the tax in 1405
// and "Bill arrived" releases it to 1400/1401, so the pair nets to the credit really held;
// blocked ITC was capitalised into the cost and never appears here at all, which is correct,
// because reducing the cost already gives it back.
//
// `share` is the fraction of the bill being given up. Rule 37 (and s.34(2) for a credit note)
// both work on exactly that proportion.
export function billTaxBack(bill, share = 1) {
  if (!bill) return [];
  const CODES = ['1400', '1401', '1402', '1405'];
  const net = {};
  for (const t of S.txns || []) {
    if (t.reversedBy || t.reversalOf) continue;
    const mine = t.id === bill.txnId || t.meta?.billId === bill.id;
    if (!mine) continue;
    for (const l of t.lines || []) {
      if (!CODES.includes(l.acc)) continue;
      net[l.acc] = r2((net[l.acc] || 0) + num(l.dr) - num(l.cr));
    }
  }
  return CODES.filter(c => (net[c] || 0) > HALF_PAISA)
    .map(c => ({ acc: c, amt: r2(net[c] * share) }))
    .filter(x => x.amt > HALF_PAISA);
}

export function rule37Rows(month) {
  const at = lastDayOfMonth(month || ym(today()));
  const cutoff = addDays(at, -180);
  return (S.bills || [])
    .filter(b => b.status !== 'void' && num(b.gst) > 0 && billOutstanding(b) > HALF_PAISA && b.date <= cutoff)
    .map(b => {
      const unpaidShare = billOutstanding(b) / (num(b.net ?? b.total) || 1);
      return {
        billId: b.id, no: b.no, date: b.date, dueDate: b.dueDate || null,
        vendor: b.vendorName || pname(b.partyId), desc: b.desc,
        total: num(b.net ?? b.total), outstanding: billOutstanding(b),
        days: daysApart(b.date, at),
        reverse: r2(num(b.gst) * unpaidShare),
      };
    })
    .sort((a, b) => b.days - a.days);
}

// ═══════ TDS THRESHOLDS ═══════

// Total billed by one vendor this financial year — the figure the s.194 thresholds test.
// Who an entry paid, when no line names them: the bill it produced, or the vendor on the
// recurring commitment it recorded. A month paid on the spot has neither a payable line nor
// a vendor on the form.
export function payeeOf(t) {
  const bill = (S.bills || []).find(b => b.txnId === t.id);
  if (bill?.partyId) return bill.partyId;
  const m = t.meta || {};
  if (t.event === 'confirmcharge' && m.sub) return S.subs.find(s => s.id === m.sub)?.vendorId || null;
  return null;
}
// The lowest an account will sit at from this date onward, so a back-dated entry has to fit
// every later day too — not only the balance on its own day. Same-day entries are taken
// together, since nothing orders them within the day.
export function roomIn(code, date) {
  const from = date || today();
  const sign = (A[code]?.type === 'asset' || A[code]?.type === 'expense') ? 1 : -1;
  let run = bal(code, { upto: from });
  let low = run;
  const later = S.txns.filter(t => t.date > from).sort((a, b) => a.date.localeCompare(b.date));
  let cur = null;
  for (const t of later) {
    if (cur && t.date !== cur) low = Math.min(low, run);
    cur = t.date;
    for (const l of t.lines) if (l.acc === code) run += sign * (num(l.dr) - num(l.cr));
  }
  return r2(Math.min(low, run));
}
export const pettyRoom = date => roomIn('1010', date);
export function tdsFyTotal(partyId, fy, section) {
  let s = 0;
  for (const t of S.txns) {
    if (t.fy !== fy || t.reversedBy || t.reversalOf) continue;
    const m = t.meta || {};
    // The payee is whoever the entry names: a payable line, or the vendor on the form.
    const payee = t.lines.find(l => l.acc === '2000' && l.party)?.party || m.vendor || payeeOf(t) || null;
    if (payee !== partyId) continue;
    if (!['bill', 'expense', 'confirmcharge', 'dealcost'].includes(t.event)) continue;
    if (section && m.tds && m.tds !== 'none' && m.tds !== section) continue;
    s += num(m.amt);
  }
  return r2(s);
}

// What has been withheld and what has been deposited, by section — the two sides of 26Q.
export function tdsRegister(fy) {
  const withheld = {}, deposited = {};
  for (const t of S.txns) {
    if (t.fy !== fy || t.reversedBy || t.reversalOf) continue;
    const m = t.meta || {};
    const cr = t.lines.filter(l => l.acc === '2250').reduce((a, l) => a + num(l.cr), 0);
    const dr = t.lines.filter(l => l.acc === '2250').reduce((a, l) => a + num(l.dr), 0);
    if (cr > 0.005) {
      // On a salary or EMI entry `meta.tds` is the rupee amount, so the section comes from
      // the event; everywhere else the form named it.
      const sec = t.event === 'salary' ? '192' : t.event === 'emi' ? '194A' : (m.tds && m.tds !== 'none' ? m.tds : 'other');
      (withheld[sec] = withheld[sec] || []).push({ txn: t, amt: r2(cr), party: t.lines.find(l => l.party)?.party || m.vendor || m.emp || payeeOf(t) || null, month: ym(t.date) });
    }
    if (dr > 0.005 && t.event === 'statutory') {
      const sec = m.tdsSection || 'other';
      (deposited[sec] = deposited[sec] || []).push({ txn: t, amt: r2(dr), month: m.tdsMonth || ym(t.date), challan: m.challan || '', bsr: m.bsr || '' });
    }
  }
  return { withheld, deposited };
}

// ═══════ COMPLIANCE CALENDAR ═══════

// The next filing and payment dates, computed rather than typed, so the Overview always
// shows what is actually coming rather than a list that goes stale. ROC dates depend on the
// AGM and are shown as the usual latest dates.
export function complianceCalendar(from, opts = {}) {
  const base = new Date((from || today()) + 'T00:00:00');
  const out = [];
  const push = (d, what, note) => { if (d >= base) out.push({ date: isoLocal(d), what, note }); };
  const monthName = d => d.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  const prev = d => monthName(new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const y = base.getFullYear(), mo = base.getMonth();
  for (let k = 0; k < 4; k++) {
    const d = new Date(y, mo + k, 1);
    push(new Date(d.getFullYear(), d.getMonth(), 11), 'GSTR-1', `Outward supplies for ${prev(d)}`);
    push(new Date(d.getFullYear(), d.getMonth(), 20), 'GSTR-3B + GST payment', `For ${prev(d)}`);
    if (opts.tdsEnabled) push(new Date(d.getFullYear(), d.getMonth(), 7), 'TDS deposit', `Deducted in ${prev(d)}`);
  }
  const fyY = mo >= 3 ? y : y - 1;
  [[fyY, 5, 15, '15%'], [fyY, 8, 15, '45%'], [fyY, 11, 15, '75%'], [fyY + 1, 2, 15, '100%']]
    .forEach(([yy, m, d, pct]) => push(new Date(yy, m, d), 'Advance tax', `${pct} of the year's estimated tax`));
  if (opts.tdsEnabled) {
    [[fyY, 6, 31], [fyY, 9, 31], [fyY + 1, 0, 31], [fyY + 1, 4, 31]]
      .forEach(([yy, m, d]) => push(new Date(yy, m, d), 'TDS return (26Q)', 'Quarterly'));
  }
  push(new Date(fyY + 1, 9, 31), 'Income-tax return', `Company return for FY ${fyY}-${String(fyY + 1).slice(2)}`);
  push(new Date(fyY + 1, 9, 29), 'ROC — AOC-4', 'Financial statements; 30 days from the AGM');
  push(new Date(fyY + 1, 10, 28), 'ROC — MGT-7', 'Annual return; 60 days from the AGM');
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, opts.limit || 6);
}

// ═══════ WHAT NEEDS CASH SOON ═══════

// The next month's known outgoings, set against what is in the bank and the box.
export function upcomingCash(fromDate) {
  const from = fromDate || today();
  const month = ym(from), next = addMonths(month, 1);
  const items = [];
  for (const l of S.loans) {
    if (l.status !== 'active') continue;
    const due = (l.schedule || []).find(x => !(l.paid || []).includes(x.n));
    if (due && due.month <= next) items.push({ what: `EMI ${due.n}/${l.n} — ${l.lender}`, amt: due.emi, when: due.month });
  }
  for (const s of S.subs) {
    if (s.status !== 'active') continue;
    if (s.payMode === 'upfront' && s.end && s.end <= next) {
      items.push({ what: `${s.name} renews`, amt: num(s.amount) || num(s.monthly) * num(s.months), when: s.end });
    }
    if (s.payMode === 'monthly') items.push({ what: `${s.name}`, amt: expectedFor(s, next), when: next });
  }
  // One row per bill, on the date it is actually due — a bill due in six weeks is not money
  // needed now, and one that went overdue in April is not "due next month".
  const limit = lastDayOfMonth(next);
  let documented = 0;
  for (const b of openBills(null)) {
    const outstanding = billOutstanding(b);
    documented = r2(documented + outstanding);
    const due = b.dueDate || b.date;
    if (due > limit) continue;
    items.push({
      what: `${b.vendorName || pname(b.partyId)} — ${b.desc}`,
      amt: outstanding, when: ym(due), due, overdue: due < from,
    });
  }
  // Anything owed that has no bill behind it — opening balances, entries from before
  // documents were tracked — is still real money, so it is shown as one undated row.
  const undocumented = r2(bal('2000', { upto: from }) - documented);
  if (undocumented > 0.5) items.push({ what: 'Vendor dues with no bill on record', amt: undocumented, when: month });
  const g = gstComputation(month);
  if (g.cash > 0.5) items.push({ what: `GST for ${mlabel(month)} (after set-off)`, amt: g.cash, when: next });
  const tds = bal('2250', { upto: from });
  if (tds > 0.5) items.push({ what: 'TDS to deposit', amt: tds, when: next });
  const total = r2(items.reduce((a, i) => a + num(i.amt), 0));
  return { items, total, cash: bal('1000', { upto: from }) + bal('1010', { upto: from }) };
}

// ═══════ RECEIVABLES AGEING ═══════

// Ageing runs per INVOICE, from the day it fell due — not from a party's first-ever debit.
// A ten-year client's invoice raised last week is not ninety days old. What a party owes
// beyond their open invoices (recovered costs, opening balances) has no due date of its own,
// so it is reported separately rather than dated by guesswork.
const AGE_BUCKETS = () => ({ '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, 'no document': 0 });
const bucketFor = days => days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';

// ═══════ THE MONTH, FOUR WAYS ═══════
//
// The same commitment is looked at four times before it is over: it starts as an estimate,
// becomes an event when the month is used up, arrives as a bill with a due date, and is
// finally paid. A month view that shows only one of those is useless for deciding whether
// there is room to spend. Nothing here posts — it reads the books, the documents and the
// commitments, and each bucket is also given as rows so the screen can show what is in it.
//
// Overlap is deliberate: a bill that arrived this month AND is due this month is in both
// "invoiced" and "due", because those answer different questions. Only `committed` — what
// still has to be found in cash — is a sum that must not double count, so it is built from
// due + overdue + estimates alone, and drops the entries that never move money.
export function monthPicture(month) {
  const m = month || ym(today());
  const first = m + '-01';
  const last = lastDayOfMonth(m);
  const bills = (S.bills || []).filter(b => b.paid !== undefined && b.status !== 'void');
  const invs = (S.invoices || []).filter(i => i.paid !== undefined && i.status !== 'void' && i.kind !== 'creditnote');

  const bucket = () => ({ amt: 0, rows: [] });
  const push = (b, row) => { b.rows.push(row); b.amt = r2(b.amt + num(row.amt)); };
  const out = { paid: bucket(), invoiced: bucket(), due: bucket(), overdue: bucket(), estimated: bucket() };
  const inn = { paid: bucket(), invoiced: bucket(), due: bucket(), overdue: bucket(), estimated: bucket() };

  // 1. Money that actually moved this month — bank and box only, so "paid" and the cash
  //    line are the same arithmetic. A card purchase has not taken cash yet; it is counted
  //    separately and the card balance is shown as what it is, a debt with a date to come.
  let onCard = 0;
  for (const t of S.txns) {
    if (ym(t.date) !== m || isUndone(t)) continue;
    const mv = moneyMoved(t, ['1000', '1010']);
    const card = -(t.lines || []).reduce((s2, l) => l.acc === '2300' ? s2 + num(l.dr) - num(l.cr) : s2, 0);
    // A card purchase raises the card balance without touching bank or box.
    if (card > 0.005 && Math.abs(mv.net) < 0.005) onCard = r2(onCard + card);
    if (Math.abs(mv.net) < 0.005) continue;
    push(mv.net < 0 ? out.paid : inn.paid, {
      what: t.desc || t.event, amt: Math.abs(mv.net), when: t.date, txnId: t.id, kind: t.event,
    });
  }

  // 2. Documents: what has been billed and what falls due.
  for (const b of bills) {
    const left = billOutstanding(b);
    if (left <= HALF_PAISA) continue;
    const due = b.dueDate || b.date;
    const row = {
      what: `${b.vendorName || pname(b.partyId) || 'Vendor'} — ${b.desc}`,
      amt: left, when: due, docId: b.id, txnId: b.txnId || null,
      kind: b.accrued ? 'accrued' : 'bill', waiting: !b.billNo,
      period: b.period || b.month || ym(b.date), date: b.date,
    };
    if (ym(b.date) === m) push(out.invoiced, row);
    if (ym(due) === m) push(out.due, row);
    else if (due < first) push(out.overdue, row);
  }
  for (const i of invs) {
    const left = invoiceOutstanding(i);
    if (left <= HALF_PAISA) continue;
    const due = i.dueDate || i.date;
    const row = {
      what: `${pname(i.partyId) || 'Client'} — ${i.invoiceNo || i.desc || 'Invoice'}`,
      amt: left, when: due, docId: i.id, txnId: i.txnId || null, kind: 'invoice', date: i.date,
    };
    if (ym(i.date) === m) push(inn.invoiced, row);
    if (ym(due) === m) push(inn.due, row);
    else if (due < first) push(inn.overdue, row);
  }

  // 3. Estimates: a commitment for this month that has not become an event yet. The moment
  //    the month is recorded, the estimate stops being one — it never counts twice.
  const outEst = [], innEst = [];
  for (const s of S.subs) {
    if (s.status !== 'active') continue;
    if (s.start && s.start > m) continue;
    if (s.end && s.end < m) continue;
    const rec = (s.charges || {})[m];
    if (rec && !rec.reversed) continue;
    const amt = s.payMode === 'upfront' ? num(s.monthly) : expectedFor(s, m);
    if (amt <= 0.005) continue;
    outEst.push({
      what: s.name, amt, when: last, kind: 'recurring', subId: s.id, code: recurringAcc(s),
      noCash: s.payMode === 'upfront', why: recurringKindLabel(s.kind),
    });
  }
  for (const l of S.loans) {
    if (l.status !== 'active') continue;
    for (const x of l.schedule || []) {
      if (x.month !== m || (l.paid || []).includes(x.n)) continue;
      outEst.push({ what: `EMI ${x.n}/${l.n} — ${l.lender}`, amt: num(x.emi), when: last, kind: 'emi', loanId: l.id, code: '5150' });
    }
  }
  for (const a of S.assets) {
    if (a.status !== 'in use' || (a.start && a.start > m)) continue;
    if ((a.depreciated || []).includes(m) || (a.depreciated || []).length >= num(a.life)) continue;
    outEst.push({ what: `${a.name} — depreciation`, amt: num(a.monthly), when: last, kind: 'depreciation', noCash: true, code: '5200' });
  }
  // Per side: a deal that has registered but whose seller is not yet invoiced is the surest
  // expectation there is, and the buyer having been billed says nothing about the seller.
  for (const d of S.deals) {
    if (d.status === 'cancelled' || d.expMonth !== m) continue;
    const amt = r2((sideInvoiced(d, 'seller') ? 0 : num(d.expSeller)) + (sideInvoiced(d, 'buyer') ? 0 : num(d.expBuyer)));
    if (amt > 0.005) innEst.push({ what: `${d.nickname} — expected to close`, amt, when: last, kind: 'deal', dealId: d.id, code: '4000', soft: true });
  }
  // A figure the owner typed for an account REPLACES what the app worked out for it — the
  // same rule the Budget page states and applies. Adding the two would show one internet
  // subscription twice, on two screens, for the same month.
  const done = pl(m);
  for (const [code, amount] of Object.entries(budgetLines(m))) {
    const a = A[code];
    if (!a) continue;
    const bucket = a.type === 'income' ? innEst : outEst;
    for (let i = bucket.length - 1; i >= 0; i--) if (bucket[i].code === code) bucket.splice(i, 1);
    const already = a.type === 'income' ? num(done.inc[code]) : num(done.exp[code]);
    const left = r2(num(amount) - already);
    if (left <= 0.005) continue;
    bucket.push({ what: `${a.name} — your figure`, amt: left, when: last, kind: 'budget', code, soft: a.type === 'income' });
  }
  for (const r of outEst) push(out.estimated, r);
  for (const r of innEst) push(inn.estimated, r);

  // Biggest first inside a bucket, except money that has already moved, which reads as a
  // diary. The largest item of the month is the one worth seeing without scrolling.
  const sortRows = (b, byDate) => {
    b.rows.sort(byDate
      ? (x, y) => String(x.when).localeCompare(String(y.when)) || y.amt - x.amt
      : (x, y) => y.amt - x.amt || String(x.when).localeCompare(String(y.when)));
    return b;
  };
  const cashOf = b => r2(b.rows.filter(r => !r.noCash).reduce((s, r) => s + num(r.amt), 0));
  const side = (o, booked) => {
    for (const k of Object.keys(o)) sortRows(o[k], k === 'paid');
    return {
      ...o, booked: r2(booked),
      settled: o.paid.amt,
      toSettle: r2(o.due.amt + o.overdue.amt),
      // Documents with a date behind them, and nothing else. On the money-in side this is
      // the only figure safe to commit against: a deal the owner hopes to close is not cash.
      documented: r2(cashOf(o.due) + cashOf(o.overdue)),
      estimatedCash: cashOf(o.estimated),
      estimatedNoCash: r2(o.estimated.amt - cashOf(o.estimated)),
      committed: r2(cashOf(o.due) + cashOf(o.overdue) + cashOf(o.estimated)),
    };
  };
  const O = side(out, done.te);
  const I = side(inn, done.ti);
  // One definition of cash across the app: what is in the bank and the box, less the client
  // money sitting in it and what the card already owes. Vendor dues are NOT taken off here —
  // they are inside `committed` and would otherwise be counted twice.
  const inHand = r2(bal('1000') + bal('1010'));
  const tokens = r2(bal('2100'));
  const card = r2(bal('2300'));
  const yours = r2(inHand - tokens - card);
  O.onCard = r2(onCard);
  return {
    month: m, from: first, to: last,
    out: O, in: I,
    net: {
      paid: r2(I.paid.amt - O.paid.amt),
      booked: r2(done.profit),
      toSettle: r2(I.toSettle - O.toSettle),
      estimated: r2(I.estimated.amt - O.estimated.amt),
      committed: r2(I.committed - O.committed),
    },
    cash: {
      now: yours, inHand, tokens, card, onCard: r2(onCard),
      needed: O.committed,
      expected: I.documented, expectedAll: I.committed,
      after: r2(yours + I.documented - O.committed),
      afterAll: r2(yours + I.committed - O.committed),
      current: m === ym(today()),
    },
  };
}

// The next few months, if nothing new happens: what is already committed to go out, what is
// expected in, and where that leaves the bank and the box. Only what is still unsettled
// counts — money already paid this month is in the opening figure, not counted twice. The
// certainty column matters more than the total: a due bill will happen, an estimate may not.
export function outlook(months = 3, from) {
  const start = from || ym(today());
  // Same cash definition as monthPicture: client tokens and the card balance are not yours.
  let running = r2(bal('1000') + bal('1010') - bal('2100') - bal('2300'));
  const opening = running;
  const rows = [];
  for (let i = 0, m = start; i < months && i < 24; i++, m = addMonths(m, 1)) {
    const p = monthPicture(m);
    // Money out counts estimates (safe to over-state); money in counts only what has a
    // document behind it (over-stating income is how a business misses a payment).
    const out = p.out.committed, inn = p.in.documented;
    const fixed = r2(p.out.due.amt + p.out.overdue.amt);
    running = r2(running + inn - out);
    rows.push({
      month: m, out, in: inn, net: r2(inn - out), closing: running,
      committed: fixed, guessed: r2(out - fixed),
      hoped: r2(p.in.committed - p.in.documented),
      short: running < -0.5,
    });
  }
  return {
    opening, rows, closing: running,
    worst: rows.reduce((w, r) => r.closing < w ? r.closing : w, opening),
    firstShort: rows.find(r => r.short)?.month || null,
  };
}

// This month against last month and against what was expected, and — the part anyone
// actually acts on — the handful of accounts that moved the most. A table of forty rows
// hides the three that matter.
export function monthCompare(month) {
  const m = month || ym(today());
  const prev = addMonths(m, -1);
  const now = pl(m), was = pl(prev);
  const plan = projection(m);
  const planOf = code => plan.rows.find(r => r.code === code)?.planned || 0;
  const rows = [];
  for (const code of new Set([...Object.keys(now.inc), ...Object.keys(now.exp), ...Object.keys(was.inc), ...Object.keys(was.exp), ...plan.rows.map(r => r.code)])) {
    const a = A[code];
    if (!a) continue;
    const isInc = a.type === 'income';
    const nowAmt = r2(isInc ? num(now.inc[code]) : num(now.exp[code]));
    const wasAmt = r2(isInc ? num(was.inc[code]) : num(was.exp[code]));
    const planned = r2(planOf(code));
    if (!nowAmt && !wasAmt && !planned) continue;
    rows.push({
      code, name: a.name, type: a.type, now: nowAmt, prev: wasAmt, planned,
      change: r2(nowAmt - wasAmt), vsPlan: r2(nowAmt - planned),
      // A cost going up and income going down are both bad news; the sign alone does not say.
      worse: a.type === 'income' ? nowAmt < wasAmt : nowAmt > wasAmt,
    });
  }
  rows.sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
  return {
    month: m, prev, rows,
    movers: rows.filter(r => Math.abs(r.change) > 0.5).slice(0, 3),
    income: { now: r2(now.ti), prev: r2(was.ti), planned: plan.planned.income },
    expense: { now: r2(now.te), prev: r2(was.te), planned: plan.planned.expense },
    profit: { now: r2(now.profit), prev: r2(was.profit), planned: plan.planned.profit },
  };
}

// What it costs to open the doors: the commitments that arrive whether or not a deal closes.
// Everything here is already in the books as a commitment, a schedule or an asset — none of
// it is typed in twice.
export function fixedMonthly(month) {
  const m = month || ym(today());
  const items = [];
  for (const s of S.subs) {
    if (s.status !== 'active') continue;
    if (s.start && s.start > m) continue;
    if (s.end && s.end < m) continue;
    const amt = s.payMode === 'upfront' ? num(s.monthly) : expectedFor(s, m);
    if (amt > 0.005) items.push({ what: s.name, amt: r2(amt), kind: recurringKindLabel(s.kind) || 'Recurring' });
  }
  for (const l of S.loans) {
    if (l.status !== 'active') continue;
    const due = (l.schedule || []).find(x => x.month === m) || (l.schedule || []).find(x => !(l.paid || []).includes(x.n));
    if (due) items.push({ what: `EMI — ${l.lender}`, amt: r2(num(due.emi)), kind: 'Loan' });
  }
  for (const a of S.assets) {
    if (a.status !== 'in use' || (a.start && a.start > m)) continue;
    if ((a.depreciated || []).length >= num(a.life)) continue;
    items.push({ what: `${a.name} — depreciation`, amt: r2(num(a.monthly)), kind: 'Depreciation', noCash: true });
  }
  items.sort((x, y) => y.amt - x.amt);
  const total = r2(items.reduce((s2, i) => s2 + i.amt, 0));
  const cash = r2(items.filter(i => !i.noCash).reduce((s2, i) => s2 + i.amt, 0));
  return { month: m, items, total, cash };
}

// How much has to be earned in a month before the business is standing still. Margin comes
// from the last three completed months, so it reflects how this business actually trades
// rather than an assumption typed into a box.
export function breakEven(month) {
  const m = month || ym(today());
  const fixed = fixedMonthly(m);
  const DIRECT = PL_GROUPS.find(g => g.key === 'direct').codes;
  let income = 0, direct = 0;
  const months = [];
  for (let i = 1; i <= 3; i++) months.push(addMonths(m, -i));
  for (const x of months) {
    const p = pl(x);
    income = r2(income + p.ti);
    for (const code of DIRECT) direct = r2(direct + num(p.exp[code]));
  }
  const margin = income > 0.005 ? r2((income - direct) / income) : 1;
  const need = margin > 0.005 ? r2(fixed.total / margin) : 0;
  const actual = pl(m).ti;
  return {
    month: m, fixed: fixed.total, fixedCash: fixed.cash, items: fixed.items,
    margin, marginPct: Math.round(margin * 100),
    need, actual: r2(actual), gap: r2(need - actual),
    covered: actual >= need - 0.5,
    basedOn: months.filter(x => pl(x).ti > 0.005).length,
  };
}

// An entry is not the whole story: a bill is one entry and the payment that closes it is
// another. This ties them together both ways — the documents this entry created and what is
// still open on them, and the documents this entry settled — so a row in the list can say
// "settled" instead of repeating "not yet paid" for ever.
export function settlementOf(txnId) {
  const byId = id => S.txns.find(t => t.id === id) || null;
  const made = [];
  for (const [coll, list] of [['bills', S.bills || []], ['invoices', S.invoices || []]]) {
    for (const d of list) {
      if (d.txnId !== txnId || d.paid === undefined) continue;
      const total = coll === 'bills' ? num(d.net ?? d.total) : num(d.total);
      const left = coll === 'bills' ? billOutstanding(d) : invoiceOutstanding(d);
      made.push({
        coll, doc: d, total: r2(total), outstanding: r2(left),
        status: d.status === 'void' ? 'void' : docStatus(left, total),
        who: coll === 'bills' ? (d.vendorName || pname(d.partyId)) : pname(d.partyId),
        payments: (d.allocations || []).map(a => {
          const t = byId(a.txnId);
          return { txnId: a.txnId, no: t?.no ?? null, date: a.date || t?.date || '', amt: r2(num(a.amt)), desc: t?.desc || '', writtenOff: !!a.writtenOff, creditNote: !!a.creditNote, reversal: !!a.reversal };
        }),
      });
    }
  }
  const settled = [];
  for (const a of (byId(txnId)?.allocations || [])) {
    const list = a.coll === 'bills' ? (S.bills || []) : (S.invoices || []);
    const d = list.find(x => x.id === a.id);
    if (!d) continue;
    const total = a.coll === 'bills' ? num(d.net ?? d.total) : num(d.total);
    const left = a.coll === 'bills' ? billOutstanding(d) : invoiceOutstanding(d);
    settled.push({
      coll: a.coll, doc: d, amt: r2(num(a.amt)), total: r2(total), outstanding: r2(left),
      status: d.status === 'void' ? 'void' : docStatus(left, total),
      who: a.coll === 'bills' ? (d.vendorName || pname(d.partyId)) : pname(d.partyId),
      madeBy: d.txnId || null, madeNo: byId(d.txnId)?.no ?? null,
    });
  }
  const open = r2(made.reduce((s2, m) => s2 + (m.status === 'void' ? 0 : m.outstanding), 0));
  return {
    made, settled, open,
    // What the entry means today, in one word, for the list.
    state: !made.length ? null
      : made.every(m => m.status === 'void') ? 'void'
        : open <= HALF_PAISA ? 'settled' : made.some(m => m.status === 'part') ? 'part' : 'open',
  };
}

// ═══════ WHAT IS BEHIND A FIGURE ═══════
//
// Every total on every page is the sum of some lines in the ledger. This turns the total back
// into those lines, so any figure can be opened and read rather than believed. One spec covers
// every case a screen needs to ask about:
//
//   accs    account codes the line must be in ('5000', or ['5000','5010'])
//   side    'dr' | 'cr' | 'net' (default) — which way the line has to move
//   from/to date range, or month for a whole month
//   party, deal, event, method — narrow to one counterparty, deal, kind of entry or channel
//   moved   true to keep only entries where bank, box or card actually moved
//
// The rows come back with the amount that figure took from each entry, so the parts add up to
// the total that was clicked. Nothing is recomputed a second way — it reads S.txns, inside
// whatever petty-cash scope the calling view is rendering in.
export function explain(spec = {}) {
  const accs = spec.profit ? new Set([...INCOME_ACCS, ...EXPENSE_ACCS])
    : spec.accs === undefined ? null
      : new Set((Array.isArray(spec.accs) ? spec.accs : [spec.accs]).map(String));
  const from = spec.month ? spec.month + '-01' : spec.from || null;
  const to = spec.month ? lastDayOfMonth(spec.month) : spec.to || null;
  const side = spec.side || 'net';
  const rows = [];
  let total = 0;
  for (const t of S.txns) {
    if (from && t.date < from) continue;
    if (to && t.date > to) continue;
    if (spec.event && t.event !== spec.event) continue;
    if (spec.events && !spec.events.includes(t.event)) continue;
    if (spec.fy && t.fy !== spec.fy) continue;
    // A cash drill-down ties to totals that leave void pairs out, so it leaves them out too.
    // A profit or ledger drill-down keeps them: there the parts net to the total shown.
    if (spec.moved && (!movesMoney(t) || isUndone(t))) continue;
    if (spec.includeReversed === false && isUndone(t)) continue;
    let amt = 0, hit = false;
    for (const l of t.lines || []) {
      if (accs && !accs.has(String(l.acc))) continue;
      if (spec.party && l.party !== spec.party) continue;
      if (spec.deal && l.deal !== spec.deal) continue;
      const dr = num(l.dr), cr = num(l.cr);
      if (side === 'dr' && !dr) continue;
      if (side === 'cr' && !cr) continue;
      hit = true;
      // Profit is the one figure made of two kinds of line at once: income the credit way
      // round, costs the debit way round. Asking for it by hand would get the sign wrong.
      if (spec.profit) {
        const ty = A[l.acc]?.type;
        if (ty === 'income') amt += cr - dr;
        else if (ty === 'expense') amt -= dr - cr;
        else { hit = false; continue; }
      } else {
        amt += side === 'dr' ? dr : side === 'cr' ? cr : dr - cr;
      }
    }
    if (!hit) continue;
    // A sign convention that reads the way the figure on screen reads: an income or liability
    // total is a credit balance, and nobody wants to see it as a negative number.
    const shown = spec.flip ? -amt : amt;
    if (Math.abs(shown) < 0.005 && !spec.keepZero) continue;
    rows.push({
      txnId: t.id, no: t.no ?? null, date: t.date, desc: t.desc || t.event,
      event: t.event, amt: r2(shown),
      party: (t.lines.find(l => l.party) || {}).party || null,
      reversed: !!t.reversedBy, reversal: !!t.reversalOf, auto: !!t.auto,
    });
    total = r2(total + shown);
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.amt) - Math.abs(a.amt));
  return { spec, rows, total, count: rows.length };
}

// Bills sitting on Owed with no vendor bill number against them — a month closed on an
// estimate, waiting for the paperwork. This is the queue "Bill arrived" works through.
export function awaitingBill() {
  return (S.bills || [])
    .filter(b => b.paid !== undefined && b.status !== 'void' && billOutstanding(b) > HALF_PAISA)
    .filter(b => !b.billNo)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// ═══════ STATEMENTS, THE WAY AN ACCOUNTANT READS THEM ═══════

// A trial balance with movement, not only the closing position: what the account opened at,
// what went through it in the period, and where it ended. This is the form every accounting
// package prints and the one a CA can tie to the ledger without asking questions.
export function trialBalanceDetail(from, upto) {
  const rows = [];
  // Income and expense accounts are closed to reserves at each year end, so their opening
  // figure is what has run through them since THIS financial year began — never the whole
  // history. Otherwise a second-year trial balance opens with last year's revenue on it.
  const fyFrom = from ? fyStartDate(fyOf(from, S.settings.fyStartMonth), S.settings.fyStartMonth) : null;
  for (const a of ACCOUNTS) {
    // Raw debit-minus-credit, not the reading convention: a trial balance shows a liability
    // as a credit, and `closing = opening + debits - credits` has to hold line by line.
    const sign = (a.type === 'asset' || a.type === 'expense') ? 1 : -1;
    const isPl = a.type === 'income' || a.type === 'expense';
    const opening = !from ? 0
      : r2(sign * bal(a.code, { upto: prevDay(from), ...(isPl && fyFrom && fyFrom <= from ? { from: fyFrom } : {}) }));
    let debit = 0, credit = 0;
    for (const t of S.txns) {
      if (from && t.date < from) continue;
      if (upto && t.date > upto) continue;
      for (const l of t.lines) {
        if (l.acc !== a.code) continue;
        debit += num(l.dr); credit += num(l.cr);
      }
    }
    const closing = r2(opening + debit - credit);
    if (!opening && !debit && !credit) continue;
    rows.push({ acc: a, opening: r2(opening), debit: r2(debit), credit: r2(credit), closing });
  }
  const sum = (k, f) => r2(rows.reduce((s, r) => s + (f(r) ? Math.abs(r[k]) : 0), 0));
  const totals = {
    debit: r2(rows.reduce((s, r) => s + r.debit, 0)),
    credit: r2(rows.reduce((s, r) => s + r.credit, 0)),
    closingDr: sum('closing', r => r.closing > 0),
    closingCr: sum('closing', r => r.closing < 0),
    openingDr: sum('opening', r => r.opening > 0),
    openingCr: sum('opening', r => r.opening < 0),
  };
  return {
    rows, totals,
    balanced: Math.abs(totals.debit - totals.credit) < 0.5 && Math.abs(totals.closingDr - totals.closingCr) < 0.5,
  };
}
const prevDay = iso => addDays(iso, -1);
// The first day of a financial year, from the label fyOf() produces ("2026-27").
export function fyStartDate(fy, startMonth) {
  return `${String(fy).slice(0, 4)}-${String(num(startMonth) || 4).padStart(2, '0')}-01`;
}

// Profit and loss in the order it is read: revenue, what it directly cost, what running the
// business cost, then the things below the operating line — finance, depreciation, and the
// costs the tax computation adds back. Any account not named in a group still appears, under
// administration, so nothing can quietly fall out of the statement.
export const PL_GROUPS = [
  { key: 'revenue', label: 'Revenue from operations', type: 'income', codes: ['4000', '4010', '4020'] },
  { key: 'otherinc', label: 'Other income', type: 'income', codes: ['4030', '4040', '4050', '4060'] },
  { key: 'direct', label: 'Direct costs of earning it', type: 'expense', codes: ['5040', '5045'] },
  { key: 'people', label: 'People', type: 'expense', codes: ['5010', '5020', '5030'] },
  { key: 'place', label: 'Place and running costs', type: 'expense', codes: ['5000', '5060', '5070', '5130', '5170', '5160'] },
  { key: 'selling', label: 'Selling and marketing', type: 'expense', codes: ['5090', '5110', '5185', '5225'] },
  { key: 'admin', label: 'Administration', type: 'expense', codes: ['5050', '5075', '5080', '5100', '5120', '5140', '5180'] },
  { key: 'finance', label: 'Finance cost', type: 'expense', codes: ['5150'] },
  { key: 'depreciation', label: 'Depreciation', type: 'expense', codes: ['5200'] },
  { key: 'exceptional', label: 'Exceptional and one-off', type: 'expense', codes: ['5165', '5190', '5210', '5220', '5230'] },
];
const PL_HOME = Object.fromEntries(PL_GROUPS.flatMap(g => g.codes.map(c => [c, g.key])));

export function plStatement(o = {}) {
  const p = pl(o.month || null, o.deal || null, o.fy || null);
  const groups = PL_GROUPS.map(g => ({ ...g, rows: [], total: 0 }));
  const at = k => groups.find(g => g.key === k);
  const place = (code, amt, type) => {
    if (Math.abs(amt) < 0.005) return;
    const g = at(PL_HOME[code] || (type === 'income' ? 'otherinc' : 'admin'));
    g.rows.push({ code, name: A[code]?.name || code, amt: r2(amt) });
    g.total = r2(g.total + amt);
  };
  for (const [code, amt] of Object.entries(p.inc)) place(code, amt, 'income');
  for (const [code, amt] of Object.entries(p.exp)) place(code, amt, 'expense');
  for (const g of groups) g.rows.sort((a, b) => Math.abs(b.amt) - Math.abs(a.amt));

  const t = k => at(k).total;
  const revenue = t('revenue'), otherIncome = t('otherinc'), direct = t('direct');
  const opex = r2(t('people') + t('place') + t('selling') + t('admin'));
  const grossProfit = r2(revenue - direct);
  const ebitda = r2(grossProfit + otherIncome - opex);
  const depreciation = t('depreciation'), finance = t('finance'), exceptional = t('exceptional');
  const pbt = r2(ebitda - depreciation - finance - exceptional);
  const prov = taxProvision(pbt);
  return {
    groups: groups.filter(g => g.rows.length),
    revenue, otherIncome, direct, grossProfit, opex, ebitda,
    depreciation, finance, exceptional, pbt,
    tax: prov.tax, taxRate: prov.rate, pat: prov.pat,
    income: r2(p.ti), expense: r2(p.te), profit: r2(p.profit),
    margin: p.ti ? Math.round((p.profit / p.ti) * 100) : 0,
  };
}

// The balance sheet in schedule order, with fixed assets shown at cost less depreciation and
// the profit split into what earlier years left behind and what this year has made.
export const BS_GROUPS = [
  { key: 'fixed', side: 'assets', label: 'Fixed assets', codes: ['1300', '1350'] },
  { key: 'current', side: 'assets', label: 'Current assets', codes: ['1000', '1010', '1100', '1150', '1200', '1400', '1401', '1402', '1405', '1500', '1550'] },
  { key: 'funds', side: 'funds', label: "Owner's funds", codes: ['3000', '3100'] },
  { key: 'borrowings', side: 'funds', label: 'Borrowings', codes: ['2400'] },
  { key: 'payables', side: 'funds', label: 'Current liabilities', codes: ['2000', '2100', '2200', '2201', '2202', '2205', '2250', '2300', '2450', '2550'] },
];

export function balanceSheetGrouped(upto, fyStart) {
  const seen = new Set();
  const groups = BS_GROUPS.map(g => {
    const rows = [];
    let total = 0;
    for (const code of g.codes) {
      seen.add(code);
      // bal() already reports a liability or equity credit balance as a positive number,
      // which is how a balance sheet reads it — nothing is flipped here.
      const amt = bal(code, { upto });
      if (Math.abs(amt) < 0.5) continue;
      rows.push({ code, name: A[code]?.name || code, amt: r2(amt) });
      total = r2(total + amt);
    }
    return { ...g, rows, total };
  });
  // Anything the groups do not name still has to appear somewhere.
  const strays = ACCOUNTS.filter(a => !seen.has(a.code) && ['asset', 'liability', 'equity'].includes(a.type))
    .map(a => ({ code: a.code, name: a.name, amt: r2(bal(a.code, { upto })), type: a.type }))
    .filter(r => Math.abs(r.amt) > 0.5);
  for (const s of strays) {
    const g = groups.find(x => x.key === (s.type === 'asset' ? 'current' : 'payables'));
    g.rows.push({ code: s.code, name: s.name, amt: s.amt });
    g.total = r2(g.total + s.amt);
  }

  const thisYear = fyStart ? r2(retainedProfit(upto) - retainedProfit(prevDay(fyStart))) : retainedProfit(upto);
  const earlier = r2(retainedProfit(upto) - thisYear);
  const assets = groups.filter(g => g.side === 'assets');
  const funds = groups.filter(g => g.side === 'funds');
  const totalAssets = r2(assets.reduce((s, g) => s + g.total, 0));
  const totalFunds = r2(funds.reduce((s, g) => s + g.total, 0) + thisYear + earlier);
  const diff = r2(totalAssets - totalFunds);
  return {
    assets, funds, totalAssets, totalFunds, diff,
    profitThisYear: thisYear, profitEarlier: earlier,
    retained: r2(thisYear + earlier),
    balanced: Math.abs(diff) < 0.5,
  };
}

// What an accountant checks before signing anything off: does it balance, do the control
// accounts agree with the documents behind them, is anything obviously unfinished. Each check
// says what to do about it, so the page is a worklist rather than a verdict.
export function booksHealth(upto) {
  const asOf = upto || today();
  const list = [];
  const add = (key, label, ok, detail, o = {}) => list.push({ key, label, ok, detail, level: o.level || (ok ? 'ok' : 'bad'), go: o.go || null, amount: o.amount ?? null });

  // Not "does the total balance" — that is arithmetic and cannot fail. This looks for an
  // individual entry whose own two sides disagree, which is what a corrupt or hand-edited
  // record looks like.
  const lopsided = S.txns.filter(t => {
    const d = (t.lines || []).reduce((s2, l) => s2 + num(l.dr), 0);
    const c2 = (t.lines || []).reduce((s2, l) => s2 + num(l.cr), 0);
    return Math.abs(d - c2) > HALF_PAISA;
  });
  add('tb', 'Every entry balances on its own', lopsided.length === 0,
    lopsided.length ? `${lopsided.length} entr${lopsided.length === 1 ? 'y has' : 'ies have'} debits and credits that do not agree — entry #${lopsided[0].no || lopsided[0].id} is the first.`
      : `All ${S.txns.length} entries have equal debits and credits.`, { go: 'txns' });

  const bs = balanceSheetGrouped(asOf);
  add('bs', 'The balance sheet ties out', bs.balanced,
    bs.balanced ? 'Assets equal funds and liabilities plus profit.' : `Out by ${fmt(Math.abs(bs.diff))}.`);

  const apLedger = bal('2000', { upto: asOf });
  const apDocs = r2(openBills(null).reduce((a, b) => a + billOutstanding(b), 0));
  const apGap = r2(apLedger - apDocs);
  add('ap', 'Vendor payables agree with the bills behind them', Math.abs(apGap) < 0.5,
    Math.abs(apGap) < 0.5 ? `${fmt(apDocs)} owed, every rupee on a bill.`
      : `${fmt(Math.abs(apGap))} of the ${fmt(apLedger)} owed has no bill document — entries made before bills were tracked, or an opening balance.`,
    { level: Math.abs(apGap) < 0.5 ? 'ok' : 'warn', amount: apGap, go: 'owed' });

  const arLedger = bal('1100', { upto: asOf });
  const arDocs = r2(openInvoices(null).reduce((a, i) => a + invoiceOutstanding(i), 0));
  const arGap = r2(arLedger - arDocs);
  add('ar', 'Client receivables agree with the invoices behind them', Math.abs(arGap) < 0.5,
    Math.abs(arGap) < 0.5 ? `${fmt(arDocs)} receivable, every rupee on an invoice.`
      : `${fmt(Math.abs(arGap))} of the ${fmt(arLedger)} receivable has no invoice document.`,
    { level: Math.abs(arGap) < 0.5 ? 'ok' : 'warn', amount: arGap, go: 'owed' });

  // The box is an account like any other and is allowed to run negative — that is usually a
  // top-up nobody has recorded yet. What matters is where it stands now: a dip that has since
  // been squared is history, exactly as it would be on a bank account.
  const boxNow = bal('1010', { upto: asOf });
  const boxLow = pettyRoom('1900-01-01');
  add('petty', 'The cash box is not overdrawn', boxNow > -0.5,
    boxNow > -0.5
      ? (boxLow > -0.5 ? 'It never went below zero.' : `It holds ${fmt(boxNow)} today. It did dip ${fmt(Math.abs(boxLow))} below zero earlier, which is squared now.`)
      : `The box is ${fmt(Math.abs(boxNow))} overdrawn. Usually a top-up from the bank has not been recorded — add it and the balance comes back.`,
    { level: boxNow > -0.5 ? 'ok' : 'warn', amount: boxNow, go: 'petty' });

  const noDue = openBills(null).filter(b => !b.dueDate).length;
  add('due', 'Every open bill has a due date', noDue === 0,
    noDue ? `${noDue} open bill${noDue === 1 ? ' has' : 's have'} no due date, so they cannot appear in what is due this month.` : 'Everything owed has a date against it.',
    { level: noDue ? 'warn' : 'ok', go: 'owed' });

  const waiting = awaitingBill();
  add('waiting', 'Vendor bills received for what you accrued', waiting.length === 0,
    waiting.length ? `${waiting.length} recorded month${waiting.length === 1 ? '' : 's'} still ${waiting.length === 1 ? 'has' : 'have'} no vendor bill number — record them with "Bill arrived" when the invoice comes.`
      : 'No month is waiting for its paperwork.',
    { level: waiting.length ? 'warn' : 'ok', amount: r2(waiting.reduce((a, b) => a + billOutstanding(b), 0)), go: 'owed' });

  const missing = missingServiceMonths ? missingServiceMonths(ym(asOf)) : [];
  add('recurring', 'Every recurring month is recorded', missing.length === 0,
    missing.length ? `${missing.length} month${missing.length === 1 ? '' : 's'} of a recurring cost ${missing.length === 1 ? 'is' : 'are'} not recorded yet.` : 'Nothing outstanding on the recurring tab.',
    { level: missing.length ? 'warn' : 'ok', go: 'services' });

  const closed = Object.keys(S.monthEnds || {});
  const pend = [];
  for (let mth = ym(S.txns.map(t => t.date).sort()[0] || asOf), guard = 0; mth < ym(asOf) && guard < 60; mth = addMonths(mth, 1), guard++) {
    if (!closed.includes(mth) && monthEndEntries(mth).length) pend.push(mth);
  }
  add('monthend', 'Month-end has been run on every closed month', pend.length === 0,
    pend.length ? `${pend.map(mlabel).join(', ')} still ${pend.length === 1 ? 'has' : 'have'} depreciation or prepaid entries waiting.` : 'Depreciation and prepaid slices are up to date.',
    { level: pend.length ? 'warn' : 'ok', go: 'overview' });

  // Rule 30(2): the 7th of the following month, except March, which is the 30th of April.
  // Money withheld this month and not yet due is not a finding.
  const tds = bal('2250', { upto: asOf });
  const lastM = addMonths(ym(asOf), -1);
  const dueBy = lastM.endsWith('-03') ? `${lastM.slice(0, 4)}-04-30` : addDays(lastM + '-01', 37).slice(0, 8) + '07';
  const overdueTds = tds > 0.5 && asOf > dueBy;
  add('tds', 'TDS withheld has been deposited', !overdueTds,
    tds < 0.5 ? 'Nothing withheld is sitting with you.'
      : overdueTds ? `${fmt(tds)} withheld is past its deposit date (${dueBy}) — interest runs at 1.5% a month under s.201(1A).`
        : `${fmt(tds)} withheld, not yet due. ${lastM.endsWith('-03') ? 'March is deposited by 30 April' : 'Deposit by the 7th'}.`,
    { level: overdueTds ? 'bad' : 'ok', amount: tds, go: 'gst' });

  // Two vendor bills with the same number are either a duplicate entry or a duplicate
  // payment waiting to happen. This is the first thing an auditor tests on payables.
  const seenBills = new Map();
  const dupes = [];
  for (const b of (S.bills || [])) {
    if (!b.billNo || b.status === 'void') continue;
    const k = `${b.partyId}|${String(b.billNo).trim().toUpperCase()}`;
    if (seenBills.has(k)) dupes.push(b); else seenBills.set(k, b);
  }
  add('dupbills', 'No vendor bill number is recorded twice', dupes.length === 0,
    dupes.length ? `${dupes.length} bill number${dupes.length === 1 ? ' is' : 's are'} repeated for the same vendor — ${esc(dupes[0].billNo)} is the first. Check before paying either.`
      : 'Every vendor bill number appears once.',
    { level: dupes.length ? 'bad' : 'ok', go: 'owed' });

  // GST held back because no tax invoice has arrived. It is not claimable until it does
  // (s.16(2)(a) and (aa)), and it dies after the s.16(4) date.
  const parked = bal('1405', { upto: asOf });
  add('parkedgst', 'No GST is stuck waiting for an invoice', parked < 0.5,
    parked < 0.5 ? 'Nothing is waiting.'
      : `${fmt(parked)} of GST cannot be claimed until the vendor's invoice is on record. Use "Bill arrived" as each one comes in.`,
    { level: parked > 0.5 ? 'warn' : 'ok', amount: parked, go: 'owed' });

  const noSelf = S.txns.filter(t => (t.lines || []).some(l => l.acc === '2205' && num(l.cr)) && !t.selfInvoiceNo).length;
  add('selfinv', 'Every reverse-charge entry has a self-invoice', noSelf === 0,
    noSelf ? `${noSelf} reverse-charge entr${noSelf === 1 ? 'y has' : 'ies have'} no self-invoice number — s.31(3)(f) requires one.` : 'Self-invoices are numbered on every reverse-charge entry.',
    { level: noSelf ? 'warn' : 'ok', go: 'gst' });

  const start = S.settings.booksStartDate;
  const before = start ? S.txns.filter(t => t.date < start).length : 0;
  add('start', 'Nothing is dated before the books start', before === 0,
    before ? `${before} entr${before === 1 ? 'y is' : 'ies are'} dated before ${start}.` : start ? `Books start ${start}.` : 'No start date set — set one in Settings so nothing can be back-dated by accident.',
    { level: before ? 'bad' : start ? 'ok' : 'warn', go: 'settings' });

  const opening = Math.abs(bal('3100', { upto: asOf }));
  add('opening', 'Opening balances are on record', opening > 0.5,
    opening > 0.5 ? 'Opening balances were entered.' : 'No opening balances have been posted. Until they are, the bank and what you owe start from zero on day one.',
    { level: opening > 0.5 ? 'ok' : 'warn', go: 'opening' });

  return { asOf, checks: list, bad: list.filter(c => c.level === 'bad').length, warn: list.filter(c => c.level === 'warn').length };
}

export function agedReceivables(asOf) {
  const at = asOf || today();
  const buckets = AGE_BUCKETS();
  const per = partyBalances('1100', { upto: at });
  for (const [pid, amt] of Object.entries(per)) {
    if (amt <= 0.5) continue;
    let documented = 0;
    for (const i of openInvoices(pid)) {
      if (i.date > at) continue;
      const outstanding = invoiceOutstanding(i);
      documented = r2(documented + outstanding);
      buckets[bucketFor(daysApart(i.dueDate || i.date, at))] += outstanding;
    }
    const rest = r2(amt - documented);
    if (Math.abs(rest) > 0.005) buckets['no document'] += rest;
  }
  for (const k of Object.keys(buckets)) buckets[k] = r2(buckets[k]);
  return buckets;
}

// The same picture the other way round: how long you have been sitting on what you owe.
export function agedPayables(asOf) {
  const at = asOf || today();
  const buckets = AGE_BUCKETS();
  let documented = 0;
  for (const b of openBills(null)) {
    if (b.date > at) continue;
    const outstanding = billOutstanding(b);
    documented = r2(documented + outstanding);
    buckets[bucketFor(daysApart(b.dueDate || b.date, at))] += outstanding;
  }
  const rest = r2(bal('2000', { upto: at }) - documented);
  if (Math.abs(rest) > 0.005) buckets['no document'] += rest;
  for (const k of Object.keys(buckets)) buckets[k] = r2(buckets[k]);
  return buckets;
}

const daysApart = (from, to) => Math.round((new Date(to) - new Date(from)) / 86400000);

// ═══════ CASH ↔ PROFIT BRIDGE ═══════
//
// "I made ₹4 lakh and the bank went down" is the question every owner asks. Each step is a
// real movement that explains part of the gap; `residual` is what none of them explain and
// should be nil. Anything left in it is a bug worth seeing rather than hiding.

export function cashProfitBridge(month) {
  const m = month || ym(today());
  const prev = addMonths(m, -1) + '-31';
  const end = m + '-31';
  const delta = (code, opts = {}) => r2(bal(code, { ...opts, upto: end }) - bal(code, { ...opts, upto: prev }));

  const profit = r2(pl(m).profit);
  const receivables = r2(-delta('1100'));
  const payables = delta('2000');
  const tokens = delta('2100');
  const advances = r2(-delta('1550'));
  // Month-end costs that never moved cash.
  const noncash = r2(S.txns
    .filter(t => t.event === 'monthend' && ym(t.date) === m)
    .reduce((a, t) => a + t.lines.reduce((x, l) => x + num(l.dr), 0), 0));
  // Cash that never touched profit.
  const capex = r2(-S.txns.filter(t => ym(t.date) === m)
    .reduce((a, t) => a + t.lines.reduce((x, l) => x + (l.acc === '1300' ? num(l.dr) - num(l.cr) : 0), 0), 0));
  const prepaid = r2(-S.txns.filter(t => ym(t.date) === m && t.event !== 'monthend')
    .reduce((a, t) => a + t.lines.reduce((x, l) => x + (l.acc === '1200' ? num(l.dr) - num(l.cr) : 0), 0), 0));
  const principal = r2(delta('2400'));
  const funding = r2(delta('3000') + delta('2450'));
  const taxes = r2(delta('2200') + delta('2201') + delta('2202') + delta('2205') + delta('2250') + delta('2550')
    - delta('1400') - delta('1401') - delta('1402') - delta('1150'));
  const card = r2(delta('2300'));

  const steps = [
    { label: 'Profit for the month', amt: profit },
    { label: 'Depreciation and prepaid released (no cash)', amt: noncash },
    { label: 'Money clients still owe', amt: receivables },
    { label: 'Bills not yet paid', amt: payables },
    { label: 'Client tokens held', amt: tokens },
    { label: 'Advances paid to vendors', amt: advances },
    { label: 'Assets bought', amt: capex },
    { label: 'Paid ahead for services', amt: prepaid },
    { label: 'Loan drawn / repaid', amt: principal },
    { label: 'Capital and director loans', amt: funding },
    { label: 'Credit card balance', amt: card },
    { label: 'Taxes collected less claimed', amt: taxes },
  ].filter(x => Math.abs(x.amt) > 0.5);

  const cashMoved = r2(bal('1000', { upto: end }) + bal('1010', { upto: end })
    - bal('1000', { upto: prev }) - bal('1010', { upto: prev }));
  const explained = r2(steps.reduce((a, x) => a + x.amt, 0));
  return { month: m, steps, explained, cashMoved, residual: r2(cashMoved - explained) };
}

// ═══════ TAX PROVISION ═══════

// A private company under s.115BAA pays 22% + 10% surcharge + 4% cess = 25.168%. The rate
// lives in Settings so the CA can change it. This is an estimate for the owner, not the
// computation the return will use — that adds back disallowances and uses tax depreciation.
export function taxProvision(profit, rate) {
  // 26% = 25% + 4% cess, the rate for a company with turnover under 400 crore that has NOT
  // elected s.115BAA. The concessional 25.168% is an irrevocable election made on Form 10-IC
  // before the return is filed — so it is a setting, never the assumption.
  const r = num(rate ?? S.settings.incomeTaxRate) || 26;
  const pbt = num(profit);
  const tax = pbt > 0 ? r2(pbt * r / 100) : 0;
  return { pbt, rate: r, tax, pat: r2(pbt - tax) };
}


// ═══════ MONEY THAT ACTUALLY MOVED ═══════
//
// A bill received is a real cost and a real entry, but no money has moved. The owner needs
// to see both: the books (every entry) and the cash (only what left or arrived). These are
// the pockets money moves through, and the tests that tell the two views apart.

export const MONEY_ACCS = ['1000', '1010', '2300'];
export const movesMoney = t => (t.lines || []).some(l => MONEY_ACCS.includes(l.acc) && (num(l.dr) || num(l.cr)));
export function moneyMoved(t, accs = MONEY_ACCS) {
  let inn = 0, out = 0;
  for (const l of t.lines || []) {
    if (!accs.includes(l.acc)) continue;
    inn += num(l.dr); out += num(l.cr);
  }
  return { in: r2(inn), out: r2(out), net: r2(inn - out) };
}

// The cash book: opening, every movement in date order with a running balance, closing —
// for the bank and the box together, or any set of pockets. Closing always equals what the
// ledger says those accounts hold, because it is computed from the same entries.
export function cashBook(from, to, accs = ['1000', '1010']) {
  const f = from || S.settings.booksStartDate || '2000-01-01';
  const t = to || today();
  const before = addDays(f, -1);
  const opening = r2(accs.reduce((a, c) => a + bal(c, { upto: before, skipUndone: true }), 0));
  let running = opening;
  const rows = [];
  const inRange = [...S.txns].filter(x => x.date >= f && x.date <= t)
    .sort((a, b) => a.date.localeCompare(b.date) || num(a.no) - num(b.no));
  for (const x of inRange) {
    // A mistake and its reversal are not two movements through the bank; they are none.
    if (isUndone(x)) continue;
    const m = moneyMoved(x, accs);
    if (!m.in && !m.out) continue;
    running = r2(running + m.net);
    rows.push({ t: x, in: m.in, out: m.out, after: running,
      pocket: accs.length > 1 ? [...new Set(x.lines.filter(l => accs.includes(l.acc)).map(l => A[l.acc]?.name || l.acc))].join(' + ') : '' });
  }
  const totalIn = r2(rows.reduce((a, r) => a + r.in, 0));
  const totalOut = r2(rows.reduce((a, r) => a + r.out, 0));
  return { from: f, to: t, accs, opening, rows, in: totalIn, out: totalOut, closing: r2(opening + totalIn - totalOut) };
}

// ═══════ SCOPE — WITH, WITHOUT OR ONLY PETTY CASH ═══════
//
// "What went through the box?" is a question about entries, not accounts, so the scope is a
// filter on entries: an entry is petty-cash if any of its lines touches 1010. Lists, the P&L,
// category and cash-flow reports and every export honour it. The trial balance and balance
// sheet do not — a bank-to-box top-up touches both accounts, and a statement that ignored it
// would misstate the bank.

export const PETTY = '1010';
const SCOPES = ['with', 'without', 'only'];
let SCOPE = 'with';

export function setScope(mode) { SCOPE = SCOPES.includes(mode) ? mode : 'with'; return SCOPE; }
export const scopeMode = () => SCOPE;
export const scopeLabel = m => ({ with: 'All money', without: 'Without petty cash', only: 'Petty cash only' })[m || SCOPE];
export const touchesPetty = t => (t.lines || []).some(l => l.acc === PETTY);
export function inScope(t, mode = SCOPE) {
  if (mode === 'only') return touchesPetty(t);
  if (mode === 'without') return !touchesPetty(t);
  return true;
}
export const scopedTxns = (txns, mode = SCOPE) => (txns || S.txns).filter(t => inScope(t, mode));

// Run fn with the books narrowed to the scope. Synchronous on purpose — nothing may await
// in between, or another render could see the narrowed set.
export function scoped(fn, mode = SCOPE) {
  if (mode === 'with') return fn();
  const all = S.txns;
  S.txns = all.filter(t => inScope(t, mode));
  try { return fn(); } finally { S.txns = all; }
}

// The box's own story: what went in, what went out, and what it paid for.
export function pettyActivity(f = {}) {
  const rows = [];
  for (const t of S.txns) {
    if (f.month && ym(t.date) !== f.month) continue;
    if (f.upto && t.date > f.upto) continue;
    if (isUndone(t)) continue;
    const l = t.lines.find(x => x.acc === PETTY);
    if (!l) continue;
    const dr = num(l.dr), cr = num(l.cr);
    const other = t.lines.filter(x => x.acc !== PETTY);
    const kind = dr > 0
      ? (other.some(x => x.acc === '1000') ? 'topup' : 'in')
      : (other.some(x => x.acc === '1000') ? 'sweep' : 'spend');
    rows.push({ t, kind, in: dr, out: cr, what: other.map(x => A[x.acc]?.name || x.acc).join(', ') });
  }
  const sum = k => r2(rows.filter(r => r.kind === k).reduce((a, r) => a + (r.in || r.out), 0));
  return {
    rows: rows.sort((a, b) => b.t.date.localeCompare(a.t.date) || num(b.t.no) - num(a.t.no)),
    topups: sum('topup'), received: sum('in'), spent: sum('spend'), swept: sum('sweep'),
    balance: bal(PETTY, f.upto ? { upto: f.upto } : {}),
  };
}

// ═══════ BUDGET AND PROJECTIONS ═══════
//
// An estimate is never an entry. What the owner expects lives in three places that already
// exist — a recurring commitment's dated history, a loan's schedule, a deal's expected
// brokerage and close month — plus budget lines typed per account for anything else. All of
// it is read here and set against the actual P&L for the month. A typed budget for an
// account is the owner's number and wins over the automatic projection for that account.

export function budgetFor(month, code) { return num(S.settings.budgets?.[month]?.[code]); }
export function budgetLines(month) { return { ...(S.settings.budgets?.[month] || {}) }; }

export function projection(month) {
  const m = month || ym(today());
  const income = {}, expense = {}, why = {};
  const add = (map, code, amt, note) => {
    if (!(num(amt) > 0.005)) return;
    map[code] = r2((map[code] || 0) + num(amt));
    (why[code] = why[code] || []).push(note);
  };

  for (const sub of S.subs) {
    if (sub.status !== 'active') continue;
    if (sub.start && sub.start > m) continue;
    if (sub.end && sub.end < m) continue;
    if (sub.payMode === 'upfront') add(expense, '5080', sub.monthly, `${sub.name} (prepaid slice)`);
    else add(expense, recurringAcc(sub), expectedFor(sub, m), sub.name);
  }
  let principal = 0;
  for (const l of S.loans) {
    if (l.status !== 'active') continue;
    for (const x of l.schedule || []) {
      if (x.month !== m || (l.paid || []).includes(x.n)) continue;
      add(expense, '5150', x.int, `${l.lender} EMI interest`);
      principal = r2(principal + num(x.prin));
    }
  }
  for (const a of S.assets) {
    if (a.status !== 'in use' || (a.start && a.start > m)) continue;
    if ((a.depreciated || []).length >= num(a.life)) continue;
    add(expense, '5200', a.monthly, `${a.name} depreciation`);
  }
  for (const d of S.deals) {
    if (d.status === 'cancelled' || d.expMonth !== m) continue;
    if (!sideInvoiced(d, 'seller')) add(income, '4000', d.expSeller, `${d.nickname} (seller side)`);
    if (!sideInvoiced(d, 'buyer')) add(income, '4010', d.expBuyer, `${d.nickname} (buyer side)`);
  }
  // The owner's own numbers override what the app worked out for that account.
  const typed = budgetLines(m);
  for (const [code, amt] of Object.entries(typed)) {
    const type = A[code]?.type;
    if (type === 'income') { income[code] = num(amt); why[code] = ['budget']; }
    else if (type === 'expense') { expense[code] = num(amt); why[code] = ['budget']; }
  }

  const actual = pl(m);
  const ti = r2(Object.values(income).reduce((a, b) => a + b, 0));
  const te = r2(Object.values(expense).reduce((a, b) => a + b, 0));
  const rows = [];
  for (const code of new Set([...Object.keys(income), ...Object.keys(expense), ...Object.keys(actual.inc), ...Object.keys(actual.exp)])) {
    const a = A[code];
    if (!a) continue;
    const isInc = a.type === 'income';
    const planned = isInc ? num(income[code]) : num(expense[code]);
    const done = isInc ? num(actual.inc[code]) : num(actual.exp[code]);
    rows.push({ code, name: a.name, type: a.type, planned: r2(planned), actual: r2(done), variance: r2(done - planned), why: why[code] || [], typed: typed[code] !== undefined });
  }
  rows.sort((x, y) => x.type.localeCompare(y.type) || x.code.localeCompare(y.code));
  return {
    month: m, rows, principal,
    planned: { income: ti, expense: te, profit: r2(ti - te) },
    actual: { income: r2(actual.ti), expense: r2(actual.te), profit: r2(actual.profit) },
  };
}

// ═══════ REBUILDING A LOAN SCHEDULE ═══════
//
// After extra principal is paid the old schedule overstates every later month's interest.
// The instalments already paid are kept as they were; the ones still to come are rebuilt on
// the new balance at the same rate over the same remaining months — a lower EMI, same end.

export function regenerateSchedule(loan, newBalance, paidNos) {
  const paid = new Set(paidNos || loan.paid || []);
  const kept = (loan.schedule || []).filter(x => paid.has(x.n));
  const remaining = (loan.schedule || []).filter(x => !paid.has(x.n));
  if (!remaining.length || newBalance <= 0.5) return kept.map(x => ({ ...x }));
  const fresh = schedule(newBalance, num(loan.rate), remaining.length, remaining[0].month);
  return [...kept.map(x => ({ ...x })), ...fresh.map((x, i) => ({ ...x, n: remaining[i].n, rebuilt: true }))];
}

// ═══════ DOCUMENTS — BILLS, INVOICES, ALLOCATION ═══════
//
// A ledger of events cannot answer "which bill did this payment settle?" or "what did we
// expect this month against what was billed?". Documents can. A bill (payable) or invoice
// (receivable) has an identity, a total, what has been paid against it so far, and links to
// the service, deal and month it belongs to. A payment is ALLOCATED to documents — oldest
// first unless the owner says otherwise — and a document's status is derived from its
// allocations, never typed.

const HALF_PAISA = 0.005;

export const billOutstanding = b => r2(num(b.net ?? b.total) - num(b.paid));
export const invoiceOutstanding = i => r2(num(i.total) - num(i.paid));

// Status is a fact about the numbers, so it is computed, not stored as an opinion.
export function docStatus(outstanding, total) {
  if (outstanding <= HALF_PAISA) return 'paid';
  if (outstanding < num(total) - HALF_PAISA) return 'part';
  return 'open';
}

export function openBills(partyId, opts = {}) {
  return (S.bills || [])
    .filter(b => b.paid !== undefined)
    .filter(b => (!partyId || b.partyId === partyId) && b.status !== 'void' && billOutstanding(b) > HALF_PAISA)
    .filter(b => !opts.serviceId || b.serviceId === opts.serviceId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || num(a.no) - num(b.no));
}

export function openInvoices(partyId, dealId) {
  return (S.invoices || [])
    .filter(i => i.paid !== undefined && i.status !== 'void')
    .filter(i => i.kind !== 'creditnote' && (!partyId || i.partyId === partyId) && (!dealId || i.dealId === dealId))
    .filter(i => invoiceOutstanding(i) > HALF_PAISA)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.invoiceNo).localeCompare(String(b.invoiceNo)));
}

// Spread an amount across documents, oldest first. Returns the allocations and what is left
// over — which the caller decides about (an advance, or a validation error).
export function allocate(amount, docs, outstandingOf) {
  let left = r2(amount);
  const rows = [];
  for (const d of docs) {
    if (left <= HALF_PAISA) break;
    const due = r2(outstandingOf(d));
    if (due <= HALF_PAISA) continue;
    const take = Math.min(left, due);
    rows.push({ id: d.id, amt: r2(take), due });
    left = r2(left - take);
  }
  return { rows, leftover: left };
}

export const vendorAdvance = pid => bal('1550', { party: pid });

// Bills for a vendor, open or not, newest first — the vendor statement.
export function vendorBills(partyId) {
  return (S.bills || []).filter(b => b.partyId === partyId)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// ═══════ SERVICES — EXPECTED VS ACTUAL, MONTH BY MONTH ═══════
//
// A service's expected charge changes over time — a plan upgrade from October, a price rise
// in January. That is a dated history, not a single number, so the expectation for any past
// month is the one that was true then and a month's variance means something.

export function expectedFor(sub, month) {
  const hist = [...(sub.history || [])].filter(h => h.from && h.from <= month).sort((a, b) => a.from.localeCompare(b.from));
  if (hist.length) return num(hist[hist.length - 1].amount);
  return num(sub.monthly);
}

export function currentPlan(sub, month) {
  const m = month || ym(today());
  const hist = [...(sub.history || [])].filter(h => h.from && h.from <= m).sort((a, b) => a.from.localeCompare(b.from));
  return hist.length ? hist[hist.length - 1] : { from: sub.start, amount: num(sub.monthly), plan: sub.plan || '' };
}

// The next change already scheduled after this month, if any.
export function nextPlanChange(sub, month) {
  const m = month || ym(today());
  return [...(sub.history || [])].filter(h => h.from && h.from > m).sort((a, b) => a.from.localeCompare(b.from))[0] || null;
}

// Every month a monthly service has been running, with what was expected, what was recorded,
// and whether anything is missing. Upfront plans are released by month-end and have no
// monthly record, so they are described by their amortisation instead.
export function serviceMonths(sub, upto) {
  const end = upto || ym(today());
  const out = [];
  if (!sub.start) return out;
  // Months already carrying a record beyond today (a month billed in advance) still belong
  // on the grid, so the range runs to the later of today and the last recorded month.
  const recorded = Object.keys(sub.charges || {}).sort().at(-1) || '';
  let last = sub.end && sub.end < end ? sub.end : end;
  if (recorded > last) last = recorded;
  for (let m = sub.start, guard = 0; m <= last && guard < 240; m = addMonths(m, 1), guard++) {
    const raw = (sub.charges || {})[m] || null;
    const rec = raw && !raw.reversed ? raw : null;
    const expected = expectedFor(sub, m);
    // Paid or not is a fact about the bill document, which a later payment updates — the
    // month record only knows what was true when it was written.
    const bill = rec?.billId ? (S.bills || []).find(b => b.id === rec.billId) : null;
    const unpaid = bill ? bill.status !== 'void' && billOutstanding(bill) > HALF_PAISA : rec?.paid === false;
    let status;
    if (sub.payMode === 'upfront') status = (sub.amortized || []).includes(m) ? 'released' : 'pending';
    else if (rec?.skipped) status = 'skipped';
    else if (rec) status = unpaid ? 'billed' : 'recorded';
    // A dated expectation of nothing is a pause, not a month somebody forgot.
    else if (expected <= 0.005) status = 'paused';
    else status = m > end ? 'upcoming' : m === end ? 'due' : 'missing';
    const actual = rec && !rec.skipped ? num(rec.actual) : 0;
    out.push({
      month: m, expected, actual, rec, status,
      variance: rec && !rec.skipped ? r2(actual - expected) : 0,
      billId: rec?.billId || null, billStatus: bill?.status || null,
    });
  }
  return out;
}

// Months a monthly service has run but nothing was recorded for — the thing that quietly
// makes a run-rate wrong.
export function missingServiceMonths(upto) {
  const out = [];
  for (const sub of (S.subs || [])) {
    if (sub.payMode !== 'monthly' || sub.status !== 'active') continue;
    for (const m of serviceMonths(sub, upto)) if (m.status === 'missing' || m.status === 'due') out.push({ sub, ...m });
  }
  return out;
}

// ═══════ DATE HELPERS FOR VALIDATION ═══════

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}

export function lastDayOfMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return isoLocal(new Date(y, m, 0));
}
