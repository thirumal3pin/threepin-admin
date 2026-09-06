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
  ['1400', 'GST input credit', 'asset'],
  ['1500', 'Advances to staff', 'asset'],

  ['2000', 'Payable to vendors & partners', 'liability'],
  ['2100', 'Advances held from clients', 'liability'],
  ['2200', 'GST payable', 'liability'],
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
  ['5170', 'Insurance', 'expense'],
  ['5180', 'Miscellaneous', 'expense'],
  ['5190', 'Bad debts written off', 'expense'],
  ['5200', 'Depreciation', 'expense'],
  ['5210', 'Subscription cancellation loss', 'expense'],
  ['5220', 'Loss on disposal of assets', 'expense'],
].map(([code, name, type]) => ({ code, name, type }));

export const A = Object.fromEntries(ACCOUNTS.map(a => [a.code, a]));

// Categories a user may pick on a plain expense or bill. Excludes the accounts the engine
// reaches on its own (write-offs, depreciation, cancellation loss, interest, disposal loss).
// 5040 IS pickable: the Realtor Club event is gone, but referral fees are a normal cost.
export const EXP = ACCOUNTS.filter(
  a => a.type === 'expense' && !['5150', '5190', '5200', '5210', '5220'].includes(a.code));

export const PAY_VIA = [['1000', 'Bank / UPI'], ['2300', 'Credit card'], ['1010', 'Petty cash']];

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

// Indian digit grouping: 12,34,567 — not 1,234,567.
export function fmt(n) {
  const neg = num(n) < 0;
  let s = String(Math.abs(Math.round(num(n))));
  if (s.length > 3) s = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  return (neg ? '−' : '') + '₹' + s;
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
    capitalisationThreshold: 5000,
    emailDigest: { enabled: true, to: [] },
    bankAccounts: [],
    bankDetails: { bankName: '', accountName: '', accountNo: '', ifsc: '', branch: '' },
    attachmentBackend: 'storage',   // 'storage' | 'drive'
    openingPosted: false,
    columnMappings: {},
  };
}

export function blank() {
  return {
    settings: defaultSettings(),
    parties: [], deals: [], txns: [], subs: [], loans: [], assets: [],
    invoices: [], bankStatements: [], monthEnds: {},
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

export function bal(code, f = {}) {
  let s = 0;
  for (const t of S.txns) {
    if (f.upto && t.date > f.upto) continue;
    if (f.from && t.date < f.from) continue;
    if (f.month && ym(t.date) !== f.month) continue;
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
    gstDue: bal('2200', { upto }) - bal('1400', { upto }),
    tdsDue: bal('2250', { upto }),
  };
}

// Monthly run-rate across active services, regardless of how each one is paid.
export function serviceRunRate() {
  const active = S.subs.filter(s => s.status === 'active');
  return {
    active,
    monthly: active.reduce((s, x) => s + num(x.monthly), 0),
    annual: active.reduce((s, x) => s + num(x.monthly), 0) * 12,
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
    entries.push({
      kind: 'prepaid', ref: s.id,
      txn: {
        date: m + '-28', event: 'monthend', auto: true,
        desc: `Prepaid released — ${s.name} (${mlabel(m)})`,
        lines: [{ acc: '5080', dr: s.monthly }, { acc: '1200', cr: s.monthly }],
      },
    });
  }
  for (const a of S.assets) {
    if (a.status !== 'in use') continue;
    if (m < a.start) continue;
    if ((a.depreciated || []).includes(m)) continue;
    if ((a.depreciated || []).length >= a.life) continue;
    entries.push({
      kind: 'depreciation', ref: a.id,
      txn: {
        date: m + '-28', event: 'monthend', auto: true,
        desc: `Depreciation — ${a.name} (${mlabel(m)})`,
        lines: [{ acc: '5200', dr: a.monthly }, { acc: '1350', cr: a.monthly }],
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
