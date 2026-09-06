// ═══════ FINANCE ENGINE TESTS ═══════
//
// Runs three months of a working agent's books through the real event builders and asserts
// the accounting comes out right. No Firebase: the harness below reproduces exactly what
// finance-sync.js save() does — resolve parties, build, normalise, validate, post, then apply
// the master-record creates and updates — so what is tested is the code that actually runs.
//
//   node tests/finance-engine.test.mjs

import {
  getState, setState, blank, defaultSettings, normalise, validate, reversalLines,
  fyOf, num, fmt, ym, addMonths, bal, pl, trialBalance, balanceSheet, partyBalances,
  monthEndEntries, schedule, prepaidLeft, splitGst, words, A,
  setDisplayCurrency, displayCurrency, fmtInr,
  gstOutputBal, gstInputBal, gstHeads, gstSetOff, gstComputation, itcRegister,
  tdsFyTotal, complianceCalendar, upcomingCash, agedReceivables, taxProvision,
} from '../finance-assets/finance-core.js';
import { EV, PARTY_FIELDS, gstSync } from '../finance-assets/finance-events.js';
import {
  filterTxns, previousRange, periodKey, seriesByPeriod, runningCash, breakdown, kpis, dealFunnel, collectionDays, byChannel,
} from '../finance-assets/finance-analytics.js';

// ═══════ TINY TEST RUNNER ═══════

let passed = 0, failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) { passed++; return true; }
  failed++;
  failures.push(`${label}${detail ? ' — ' + detail : ''}`);
  console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

// Money comparisons tolerate a paisa of float drift; anything larger is a real bug.
const near = (a, b, tol = 0.02) => Math.abs(num(a) - num(b)) <= tol;

function eq(label, actual, expected, tol) {
  return check(label, near(actual, expected, tol), `got ${fmt(actual)} (${actual}), expected ${fmt(expected)} (${expected})`);
}

function section(name) { console.log(`\n── ${name}`); }

// ═══════ HARNESS ═══════
//
// Mirrors finance-sync.js save(). Kept deliberately close to it, line for line, so a change
// there that this does not reflect shows up as a behaviour difference rather than passing
// silently.

let seq = 0;
const nid = p => `${p}${String(++seq).padStart(4, '0')}`;

function resolveParty(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const s = getState();
  const hit = s.parties.find(p => p.name.trim().toLowerCase() === String(value.name).trim().toLowerCase());
  if (hit) return hit.id;
  const id = nid('P');
  s.parties.push({ id, name: String(value.name).trim(), type: value.type || 'other', phone: '', state: '' });
  return id;
}

function applyUpdate(obj, data) {
  // Firestore treats a dotted key as a nested path; charges.2026-09 must not create a
  // literal "charges.2026-09" property or confirmcharge silently stops working.
  for (const [k, v] of Object.entries(data)) {
    if (k.includes('.')) {
      const keys = k.split('.');
      let node = obj;
      keys.slice(0, -1).forEach(key => { node = node[key] = node[key] || {}; });
      node[keys.at(-1)] = v;
    } else obj[k] = v;
  }
}

const COLL_KEY = { deals: 'deals', subscriptions: 'subs', loans: 'loans', assets: 'assets', parties: 'parties' };

function save(evKey, values) {
  const s = getState();
  const ev = EV[evKey];
  if (!ev) throw new Error('Unknown event ' + evKey);
  const v = { ...values };

  for (const k of (PARTY_FIELDS[evKey] || [])) v[k] = resolveParty(v[k]);
  if (evKey === 'card2emi') v.__lender = resolveParty({ __new: true, name: 'Card EMI', type: 'lender' });

  const out = ev.build(v);
  if (out.incomplete) throw new Error(out.effects[0]);

  const lines = normalise(out.lines || []);
  let txnId = null;
  if (lines.length) {
    validate({ ...out, date: v.date, lines });
    txnId = nid('TX');
    s.txns.push({
      id: txnId, date: v.date, event: evKey, desc: out.desc, lines,
      totals: {
        dr: Math.round(lines.reduce((a, l) => a + num(l.dr), 0) * 100) / 100,
        cr: Math.round(lines.reduce((a, l) => a + num(l.cr), 0) * 100) / 100,
      },
      meta: Object.fromEntries(Object.entries(v).filter(([k, x]) => x != null && typeof x !== 'object' && !k.startsWith('__'))),
      attachments: [], auto: false,
      fy: fyOf(v.date, s.settings.fyStartMonth), createdBy: 'test', createdAt: Date.now(),
    });
  }

  for (const d of out.docs || []) {
    const key = COLL_KEY[d.coll];
    s[key].push({ ...d.data, id: nid(d.coll[0].toUpperCase()) });
  }
  for (const u of out.updates || []) {
    const key = COLL_KEY[u.coll];
    const target = s[key].find(x => x.id === u.id);
    if (target) applyUpdate(target, u.data);
  }
  return txnId;
}

function reverse(txnId) {
  const s = getState();
  const t = s.txns.find(x => x.id === txnId);
  const rid = nid('TX');
  const lines = normalise(reversalLines(t.lines));
  s.txns.push({
    id: rid, date: t.date, event: 'reverse', desc: 'Reversal — ' + t.desc, lines,
    totals: {
      dr: lines.reduce((a, l) => a + num(l.dr), 0),
      cr: lines.reduce((a, l) => a + num(l.cr), 0),
    },
    reversalOf: t.id, auto: false, attachments: [], meta: {},
    fy: t.fy, createdBy: 'test', createdAt: Date.now(),
  });
  t.reversedBy = rid;
  return rid;
}

function runMonthEnd(month) {
  const s = getState();
  const entries = monthEndEntries(month);
  for (const e of entries) {
    const lines = normalise(e.txn.lines);
    s.txns.push({
      id: nid('TX'), ...e.txn, lines,
      totals: {
        dr: lines.reduce((a, l) => a + num(l.dr), 0),
        cr: lines.reduce((a, l) => a + num(l.cr), 0),
      },
      meta: {}, attachments: [], fy: fyOf(e.txn.date, s.settings.fyStartMonth),
      createdBy: 'test', createdAt: Date.now(),
    });
    if (e.kind === 'prepaid') {
      const sub = s.subs.find(x => x.id === e.ref);
      sub.amortized = [...(sub.amortized || []), month];
    } else {
      const a = s.assets.find(x => x.id === e.ref);
      a.depreciated = [...(a.depreciated || []), month];
    }
  }
  s.monthEnds[month] = { ranAt: Date.now(), entriesPosted: entries.length };
  return entries.length;
}

const byName = (arr, name) => arr.find(x => x.name === name || x.nickname === name);

// ═══════ SCENARIO ═══════

const M0 = '2026-09', M1 = '2026-10', M2 = '2026-11';

function fresh() {
  seq = 0;
  const s = blank();
  s.settings = { ...defaultSettings(), booksStartDate: '2026-09-01', tdsEnabled: false };
  setState(s);
  return s;
}

console.log('3 PIN Realty — finance engine tests');
const s = fresh();

// ── SEPTEMBER: getting started ──────────────────────────────────────────────
section('September 2026 — setting up');

save('funding', { date: '2026-09-01', kind: '3000', who: 'Swaminathan N G', amt: 500000 });
save('asset', { date: '2026-09-03', name: 'MacBook Air', amt: 95000, gst: 'no', life: 36, via: '1000' });
save('asset', { date: '2026-09-04', name: 'Sony A7 camera', amt: 80000, gst: 'no', life: 36, via: '2300' });
save('subnew', {
  date: '2026-09-05', name: 'Zoho CRM', vendor: 'Zoho', use: 'Lead pipeline',
  payMode: 'upfront', amt: 24000, gst: 'no', months: 12, via: '1000',
});
save('subnew', {
  date: '2026-09-05', name: 'Claude Pro', vendor: 'Anthropic', use: 'Content',
  payMode: 'monthly', amt: 1800, gst: 'no', via: '2300',
});
save('expense', { date: '2026-09-08', desc: 'Office rent — Sep', acc: '5000', amt: 35000, gst: 'no', via: '1000' });

save('newdeal', {
  date: '2026-09-09', nickname: 'Rajan — Nungambakkam 2BHK',
  seller: { __new: true, name: 'Mr. Rajan' }, buyer: { __new: true, name: 'Mr. Karthik' },
  expSeller: 200000, expBuyer: 100000,
});
const deal1 = byName(s.deals, 'Rajan — Nungambakkam 2BHK').id;

save('token', { date: '2026-09-10', deal: deal1, from: 'buyer', amt: 50000, via: '1000' });
save('bill', {
  date: '2026-09-12', vendor: { __new: true, name: 'Balaji & Co' }, desc: 'Title opinion',
  acc: '5120', amt: 10000, gst: 'no', tds: 'none', tdsrate: 0,
});
const claude = byName(s.subs, 'Claude Pro').id;
save('confirmcharge', { sub: claude, month: M0, date: '2026-09-05', result: 'charged', amt: 1800, gst: 'no' });
save('transfer', { date: '2026-09-15', kind: '1000>1010', amt: 10000 });
save('petty', { date: '2026-09-20', a1: 3000, c1: '5050', a2: 0, c2: '5050', a3: 0, c3: '5050' });
save('salary', { date: '2026-09-28', emp: { __new: true, name: 'Priya' }, kind: '5010', gross: 25000, tds: 0, pf: 0 });

const sepBefore = pl(M0);
eq('September income before month-end', sepBefore.ti, 0);
eq('September expenses before month-end', sepBefore.te, 35000 + 10000 + 1800 + 3000 + 25000);
eq('Token is not income', bal('2100'), 50000);
eq('Bank after September activity', bal('1000'),
  500000 - 95000 - 24000 - 35000 + 50000 - 10000 - 25000);
eq('Petty cash box', bal('1010'), 10000 - 3000);
eq('Card owes camera + Claude', bal('2300'), 80000 + 1800);

section('September month-end');
const meSep = runMonthEnd(M0);
eq('Three automatic entries posted', meSep, 3);
// 24000/12 prepaid, 95000/36 and 80000/36 depreciation.
eq('September expenses after month-end', pl(M0).te, 74800 + 2000 + 2638.89 + 2222.22);
eq('Prepaid left after one month', prepaidLeft(byName(s.subs, 'Zoho CRM')), 22000);

const meSepAgain = runMonthEnd(M0);
check('Running September month-end twice posts nothing', meSepAgain === 0, `posted ${meSepAgain}`);

// ── OCTOBER: the deal closes ────────────────────────────────────────────────
section('October 2026 — deal closes, card converted to EMI');

save('invoice', {
  date: '2026-10-06', deal: deal1, from: 'buyer', amt: 100000, gst: 'yes', gstRate: 18, gstAmt: 18000, total: 118000, tds: 0,
  adv: 50000, recv: 'later',
});
eq('Income booked at registration', pl(M1).ti, 100000);
eq('Token converted, none left held', bal('2100', { deal: deal1 }), 0);
eq('GST collected is owed, not income', gstOutputBal(), 18000);
eq('…split evenly into CGST and SGST for a Tamil Nadu property', bal('2200'), 9000);
eq('Client owes the balance', bal('1100'), 118000 - 50000);
check('Deal is marked registered', s.deals.find(d => d.id === deal1).status === 'registered');

save('dealpay', { date: '2026-10-14', deal: deal1, from: 'buyer', amt: 68000, via: '1000' });
eq('Nothing left owed on the deal', bal('1100', { deal: deal1 }), 0);
eq('Paying does not book income again', pl(M1).ti, 100000);

const balaji = s.parties.find(p => p.name === 'Balaji & Co').id;
save('paybill', { date: '2026-10-15', party: balaji, amt: 10000, via: '1000' });
eq('Vendor is settled', bal('2000', { party: balaji }), 0);

save('confirmcharge', { sub: claude, month: M1, date: '2026-10-05', result: 'charged', amt: 1800, gst: 'no' });
save('expense', { date: '2026-10-08', desc: 'Office rent — Oct', acc: '5000', amt: 35000, gst: 'no', via: '1000' });
save('salary', { date: '2026-10-28', emp: 'Priya', kind: '5010', gross: 25000, tds: 0, pf: 0 });

const cardBefore = bal('2300');
save('card2emi', { date: '2026-10-20', what: 'Sony A7 camera', amt: 80000, rate: 14, n: 12, fee: 0 });
eq('Card drops by the converted amount', bal('2300'), cardBefore - 80000);
eq('Loan picks it up — total debt unchanged', bal('2400'), 80000);
const loan = s.loans.find(l => l.lender === 'Card EMI');
check('EMI schedule was generated', loan && loan.schedule.length === 12);

save('transfer', { date: '2026-10-25', kind: '1000>2300', amt: bal('2300') });
eq('Card paid off', bal('2300'), 0);

eq('October income', pl(M1).ti, 100000);
eq('October expenses before month-end', pl(M1).te, 1800 + 35000 + 25000);

section('October month-end');
runMonthEnd(M1);
eq('October expenses after month-end', pl(M1).te, 61800 + 2000 + 2638.89 + 2222.22);
eq('October profit', pl(M1).profit, 100000 - (61800 + 2000 + 2638.89 + 2222.22));

// ── NOVEMBER: refunds, forfeits, cancellations, EMIs, a mistake ─────────────
section('November 2026 — the messy month');

// A token refunded in full: cash out, profit untouched.
save('newdeal', { date: '2026-11-02', nickname: 'Meena — Adyar', seller: { __new: true, name: 'Meena' }, expSeller: 150000 });
const deal2 = byName(s.deals, 'Meena — Adyar').id;
save('token', { date: '2026-11-03', deal: deal2, from: 'seller', amt: 30000, via: '1000' });
const profitBeforeRefund = pl(M2).profit;
save('settle', { date: '2026-11-10', deal: deal2, from: 'seller', refund: 30000, keep: 0, gst: 18, move: '', drop: 'no' });
eq('Refunding a token does not touch profit', pl(M2).profit, profitBeforeRefund);
eq('Nothing held on that deal any more', bal('2100', { deal: deal2 }), 0);

// A token forfeited: becomes income, net of GST, with no cash movement.
save('newdeal', { date: '2026-11-04', nickname: 'Suresh — OMR', seller: { __new: true, name: 'Suresh' }, expSeller: 80000 });
const deal3 = byName(s.deals, 'Suresh — OMR').id;
save('token', { date: '2026-11-05', deal: deal3, from: 'seller', amt: 20000, via: '1000' });
const bankBeforeForfeit = bal('1000');
save('settle', { date: '2026-11-12', deal: deal3, from: 'seller', refund: 0, keep: 20000, gst: 18, move: '', drop: 'yes' });
eq('Forfeited token books income net of GST', bal('4030'), 20000 / 1.18);
eq('Forfeiting moves no cash', bal('1000'), bankBeforeForfeit);
check('Deal marked cancelled', s.deals.find(d => d.id === deal3).status === 'cancelled');

// Cancelling an annual plan part-way: unused balance leaves the books.
const zoho = byName(s.subs, 'Zoho CRM');
eq('Two months of prepaid used', prepaidLeft(zoho), 24000 - 4000);
save('subcancel', { date: '2026-11-15', sub: zoho.id, action: 'cancel', refund: 12000 });
eq('Cancellation loss is the unrefunded remainder', bal('5210'), 20000 - 12000);
eq('Prepaid account is emptied', bal('1200'), 0);

// Upgrading a monthly service closes the old line and opens a new one.
save('subchange', { date: '2026-11-16', sub: claude, plan: 'Max', payMode: 'monthly', amount: 3000, months: 12, refund: 0 });
check('Old service line closed', s.subs.find(x => x.id === claude).status === 'changed');
check('New service line is active', s.subs.some(x => x.parent === claude && x.status === 'active'));

// Two EMIs. Only the interest is a cost.
const i1 = loan.schedule[0], i2 = loan.schedule[1];
const loanBefore = bal('2400');
save('emi', { date: '2026-11-05', loan: loan.id, extra: 0 });
save('emi', { date: '2026-11-06', loan: loan.id, extra: 0 });
eq('Principal reduces the loan', bal('2400'), loanBefore - i1.prin - i2.prin);
eq('Only interest is booked as a cost', bal('5150'), i1.int + i2.int);
check('Both instalments marked paid', s.loans.find(l => l.id === loan.id).paid.length === 2);

// A cost paid for a client, then written off when they refuse to pay.
save('dealcost', {
  date: '2026-11-07', deal: deal2, what: 'EC extract', amt: 5000, gst: 'no',
  bear: 'seller', how: '1000',
});
eq('Recoverable cost is not an expense', bal('1100', { deal: deal2 }), 5000);
save('writeoff', { date: '2026-11-20', deal: deal2, from: 'seller', amt: 5000, why: 'Client unreachable' });
eq('Write-off clears the receivable', bal('1100', { deal: deal2 }), 0);
eq('Write-off books the loss', bal('5190'), 5000);

save('expense', { date: '2026-11-08', desc: 'Office rent — Nov', acc: '5000', amt: 35000, gst: 'no', via: '1000' });
save('salary', { date: '2026-11-28', emp: 'Priya', kind: '5010', gross: 25000, tds: 0, pf: 0 });

// A wrong entry, reversed. The pair must net to nothing anywhere it is counted.
section('Reversing a mistake');
const profitBeforeMistake = pl(M2).profit;
const cashBeforeMistake = bal('1000');
const wrong = save('expense', { date: '2026-11-22', desc: 'Wrong amount', acc: '5180', amt: 7777, gst: 'no', via: '1000' });
check('The mistake did land', !near(pl(M2).profit, profitBeforeMistake));
reverse(wrong);
eq('Reversal returns profit to where it was', pl(M2).profit, profitBeforeMistake);
eq('Reversal returns cash to where it was', bal('1000'), cashBeforeMistake);
eq('Misc expense nets to zero', bal('5180'), 0);
check('Original is flagged as reversed', !!s.txns.find(t => t.id === wrong).reversedBy);
check('Both entries remain on the record', s.txns.filter(t => t.id === wrong || t.reversalOf === wrong).length === 2);

section('November month-end');
const meNov = runMonthEnd(M2);
eq('Cancelled prepaid is not released again', meNov, 2);
check('Zoho was not amortised in November', !byName(s.subs, 'Zoho CRM').amortized.includes(M2));

// ── ACCOUNTING INVARIANTS ───────────────────────────────────────────────────
section('Accounting invariants');

const tb = trialBalance();
check('Trial balance balances', tb.balanced, `Dr ${fmt(tb.totalDr)} vs Cr ${fmt(tb.totalCr)}`);

const bs = balanceSheet();
check('Balance sheet balances', bs.balanced, `out by ${fmt(bs.diff)}`);
eq('Assets = liabilities + equity + retained profit',
  bs.totalAssets, bs.totalLiab + bs.totalEquity + bs.retained);

let unbalanced = 0;
for (const t of s.txns) {
  const dr = t.lines.reduce((a, l) => a + num(l.dr), 0);
  const cr = t.lines.reduce((a, l) => a + num(l.cr), 0);
  if (!near(dr, cr)) unbalanced++;
}
check('Every single entry balances on its own', unbalanced === 0, `${unbalanced} do not`);

const everyLineHasAccount = s.txns.every(t => t.lines.every(l => !!A[l.acc]));
check('Every line posts to a real account', everyLineHasAccount);

section('Month-end idempotency across all months');
const before = s.txns.length;
[M0, M1, M2].forEach(m => runMonthEnd(m));
check('Re-running every month-end posts nothing', s.txns.length === before,
  `${s.txns.length - before} extra entries`);

// ── TARGETED UNIT TESTS ─────────────────────────────────────────────────────
section('Loan schedule');
const sch = schedule(100000, 12, 24, '2026-10');
eq('Schedule repays exactly the principal', sch.reduce((a, x) => a + x.prin, 0), 100000, 1);
eq('Final balance is zero', sch.at(-1).bal, 0);
check('Interest falls over the life', sch[0].int > sch.at(-1).int);
const zero = schedule(120000, 0, 12, '2026-10');
eq('A zero-interest loan splits evenly', zero[0].prin, 10000);
eq('A zero-interest loan charges no interest', zero.reduce((a, x) => a + x.int, 0), 0);

section('GST split');
const intra = splitGst(100000, 18, 'Tamil Nadu', 'Tamil Nadu');
eq('Same state splits CGST', intra.cgst, 9000);
eq('Same state splits SGST', intra.sgst, 9000);
eq('Same state charges no IGST', intra.igst, 0);
const inter = splitGst(100000, 18, 'Karnataka', 'Tamil Nadu');
eq('Other state charges IGST', inter.igst, 18000);
eq('Other state charges no CGST', inter.cgst, 0);
const unknown = splitGst(100000, 18, '', 'Tamil Nadu');
eq('Unknown state falls back to CGST+SGST', unknown.cgst, 9000);

section('Validation refuses bad entries');
let threw = null;
try { validate({ date: '2026-10-01', lines: [{ acc: '1000', dr: 100 }, { acc: '5000', cr: 50 }] }); }
catch (e) { threw = e.message; }
check('An unbalanced entry is rejected', !!threw, threw || 'it was accepted');

threw = null;
try { validate({ date: '2026-10-01', lines: [] }); } catch (e) { threw = e.message; }
check('An empty entry is rejected', !!threw);

threw = null;
try { validate({ date: '2026-08-01', lines: [{ acc: '1000', dr: 100 }, { acc: '5000', cr: 100 }] }); }
catch (e) { threw = e.message; }
check('A date before the books start is rejected', !!threw, threw || 'it was accepted');

threw = null;
try { validate({ date: '2026-10-01', lines: [{ acc: '9999', dr: 100 }, { acc: '5000', cr: 100 }] }); }
catch (e) { threw = e.message; }
check('An unknown account is rejected', !!threw);

section('Rounding never breaks the balance');
// A third of a rupee three ways is the classic way to end up a paisa out.
const thirds = normalise([{ acc: '5000', dr: 100 / 3 }, { acc: '5010', dr: 100 / 3 }, { acc: '5020', dr: 100 / 3 }, { acc: '1000', cr: 100 }]);
const tdr = thirds.reduce((a, l) => a + num(l.dr), 0);
const tcr = thirds.reduce((a, l) => a + num(l.cr), 0);
eq('Thirds still balance after rounding', tdr, tcr, 0.005);

section('Asset disposal');
const mac = byName(s.assets, 'MacBook Air');
const accumulated = mac.depreciated.length * mac.monthly;
const wdv = mac.cost - accumulated;
const fixedBefore = bal('1300');
save('assetdispose', { date: '2026-11-29', assetId: mac.id, proceeds: Math.round(wdv) + 5000, via: '1000' });
eq('Asset leaves the books at cost', bal('1300'), fixedBefore - mac.cost);
check('Selling above written-down value books a gain', bal('4040') > 0, `4040 = ${fmt(bal('4040'))}`);
check('Disposed asset is marked', s.assets.find(a => a.id === mac.id).status === 'disposed');
const afterDisposal = runMonthEnd('2026-12');
check('No more depreciation on a disposed asset',
  !s.txns.some(t => t.date.startsWith('2026-12') && t.desc.includes('MacBook')),
  `month-end posted ${afterDisposal}`);

check('Trial balance still balances after disposal', trialBalance().balanced);
check('Balance sheet still balances after disposal', balanceSheet().balanced);

section('GST widget');
{
  const v = { amt: 1000, gst: 'yes', gstRate: 18 };
  gstSync('amt', v);
  eq('Amount + rate fills the tax', v.gstAmt, 180);
  eq('Amount + rate fills the total', v.total, 1180);
  v.total = 1000; gstSync('total', v);
  eq('Editing the total backs out the amount', v.amt, 847.46);
  eq('Editing the total backs out the tax', v.gstAmt, 152.54);
  eq('Amount + tax still equals the total', v.amt + v.gstAmt, 1000);
  v.gstAmt = 200; gstSync('gstAmt', v);
  eq('Editing the tax moves the total', v.total, 1047.46);
  const off = { amt: 500, gst: 'no', gstRate: 18, gstAmt: 90, total: 590 };
  gstSync('amt', off);
  eq('GST off zeroes the tax', off.gstAmt, 0);
  eq('GST off makes total equal the amount', off.total, 500);
  const untouched = { amt: 1000, gst: 'yes', gstRate: 18, gstAmt: 999, total: 1999, desc: 'x' };
  gstSync('desc', untouched);
  eq('Typing in an unrelated field leaves a hand-edited tax alone', untouched.gstAmt, 999);
}

section('GST lands on the right accounts');
{
  const inputBefore = gstInputBal();
  const expenseBefore = bal('5000');
  save('expense', { date: '2026-11-25', desc: 'Rent with GST', acc: '5000', amt: 10000, gst: 'yes', gstRate: 18, gstAmt: 1800, total: 11800, via: '1000' });
  eq('Only the taxable amount is a cost', bal('5000') - expenseBefore, 10000);
  eq('The tax goes to input credit', gstInputBal() - inputBefore, 1800);
  eq('…half of it as CGST', bal('1400') - 0, bal('1400'));
  const outputBefore = gstOutputBal();
  save('otherinc', { date: '2026-11-26', party: s.parties.find(p => p.name === 'Mr. Rajan').id, desc: 'Consultancy', acc: '4020', amt: 5000, gst: 'yes', gstRate: 18, gstAmt: 900, total: 5900, via: '1000' });
  eq('Only the taxable amount is income', bal('4020'), 5000);
  eq('Charged GST goes to GST payable', gstOutputBal() - outputBefore, 900);
  const payBefore = bal('2000');
  save('bill', { date: '2026-11-27', vendor: s.parties.find(p => p.name === 'Balaji & Co').id, desc: 'Audit fee', acc: '5120', amt: 20000, gst: 'yes', gstRate: 18, gstAmt: 3600, total: 23600, tds: 'none', tdsrate: 0 });
  eq('A bill with GST is owed in full, tax included', bal('2000') - payBefore, 23600);
  check('Books still balance with GST both ways', trialBalance().balanced && balanceSheet().balanced);

  // s.17(5): no input credit on food — the tax is part of the cost.
  const foodBefore = bal('5030'), creditBefore = gstInputBal();
  save('expense', { date: '2026-11-28', desc: 'Team lunch', acc: '5030', amt: 1000, gst: 'yes', gstRate: 5, gstAmt: 50, total: 1050, via: '1010' });
  eq('Blocked-credit category: the whole bill is the cost', bal('5030') - foodBefore, 1050);
  eq('Blocked-credit category: nothing goes to input credit', gstInputBal() - creditBefore, 0);
}

section('Place of supply follows the property');
{
  const dealTN = s.deals.find(d => d.id === deal1);
  dealTN.propertyState = 'Tamil Nadu';
  const outTN = EV.invoice.build({ date: '2026-11-29', deal: deal1, from: 'buyer', amt: 10000, gst: 'yes', gstRate: 18, gstAmt: 1800, total: 11800, tds: 0, adv: 0, recv: 'later' });
  eq('Tamil Nadu property → CGST', outTN.invoice.cgst, 900);
  eq('Tamil Nadu property → no IGST', outTN.invoice.igst, 0);
  dealTN.propertyState = 'Karnataka';
  const outKA = EV.invoice.build({ date: '2026-11-29', deal: deal1, from: 'buyer', amt: 10000, gst: 'yes', gstRate: 18, gstAmt: 1800, total: 11800, tds: 0, adv: 0, recv: 'later' });
  eq('Karnataka property → IGST', outKA.invoice.igst, 1800);
  check('Place of supply is recorded on the invoice', outKA.invoice.placeOfSupply === 'Karnataka');
  dealTN.propertyState = 'Tamil Nadu';
}

section('GST heads and set-off (Rule 88A)');
{
  const h = gstHeads(100.01, true);
  eq('In-state tax halves into CGST', h.cgst, 50.01, 0.005);
  eq('…and SGST, with the odd paisa on SGST', h.sgst, 50, 0.005);
  eq('Inter-state tax is all IGST', gstHeads(180, false).igst, 180);

  const so = gstSetOff({ cgst: 1000, sgst: 1000, igst: 500 }, { cgst: 200, sgst: 1500, igst: 900 });
  const used = (from, to) => so.util.filter(u => u.from === from && u.to === to).reduce((a, u) => a + u.amt, 0);
  eq('IGST credit clears IGST liability first', used('igst', 'igst'), 500);
  eq('Remaining IGST credit goes against CGST', used('igst', 'cgst'), 400);
  eq('CGST credit against CGST', used('cgst', 'cgst'), 200);
  eq('SGST credit against SGST', used('sgst', 'sgst'), 1000);
  eq('SGST credit never touches CGST', used('sgst', 'cgst'), 0);
  eq('CGST cash payable', so.payable.cgst, 400);
  eq('SGST cash payable', so.payable.sgst, 0);
  eq('Unused SGST credit carries forward', so.carry.sgst, 500);
}

section('GSTR-3B for November, then the remittance');
{
  const g = gstComputation('2026-11');
  // Output: invoice 18,000 (Oct, unpaid), forfeit 3,050.85, consultancy 900 — all in-state.
  eq('Liability outstanding at month end (CGST+SGST)', g.liability.cgst + g.liability.sgst, 21950.85, 0.02);
  eq('Credit available (rent 1,800 + audit 3,600)', g.credit.cgst + g.credit.sgst, 5400, 0.02);
  eq('Blocked credit reported separately', g.blocked, 50);
  eq('Cash to pay after set-off', g.cash, 16550.85, 0.02);

  const out = EV.statutory.build({ date: '2026-12-20', kind: 'gst', month: '2026-11', cgst: g.setoff.payable.cgst, sgst: g.setoff.payable.sgst, igst: 0, rcm: 0, late: 0 });
  const dr = out.lines.reduce((a, l) => a + num(l.dr), 0), cr = out.lines.reduce((a, l) => a + num(l.cr), 0);
  eq('Remittance entry balances', dr, cr);
  eq('Bank goes down by the cash figure', out.lines.find(l => l.acc === '1000').cr, 16550.85, 0.02);
  save('statutory', { date: '2026-12-20', kind: 'gst', month: '2026-11', cgst: g.setoff.payable.cgst, sgst: g.setoff.payable.sgst, igst: 0, rcm: 0, late: 0 });
  eq('GST payable is cleared', gstOutputBal(), 0, 0.02);
  eq('Input credit is fully used', gstInputBal(), 0, 0.02);
  eq('Paying the same month again shows nothing due', gstComputation('2026-11').cash, 0, 0.02);
  check('Books balance after the remittance', trialBalance().balanced && balanceSheet().balanced);
}

section('Reverse charge on an advocate bill');
{
  const owedBefore = bal('2000');
  save('bill', { date: '2026-12-02', vendor: { __new: true, name: 'Adv. Meenakshi' }, desc: 'Sale deed drafting', acc: '5120', amt: 10000, rcm: 'yes', rcmRate: 18, rcmType: 'intra', gst: 'no', tds: 'none', tdsrate: 0 });
  eq('Vendor is owed only the bare fee', bal('2000') - owedBefore, 10000);
  eq('Reverse-charge liability is booked', bal('2205'), 1800);
  eq('…and the same amount is input credit', gstInputBal(), 1800, 0.02);
  const g = gstComputation('2026-12');
  eq('RCM must be paid in cash, credit cannot cover it', g.rcmDue, 1800);
  check('Books balance', trialBalance().balanced);
}

section('Any income can carry an invoice');
{
  const rajan = s.parties.find(p => p.name === 'Mr. Rajan').id;
  const out = EV.otherinc.build({ date: '2026-12-03', party: rajan, desc: 'Valuation report', acc: '4020', amt: 8000, gst: 'yes', gstRate: 18, gstAmt: 1440, total: 9440, via: 'later', sac: '998311' });
  check('An invoice record is produced', out.invoice && out.invoice.kind === 'other', JSON.stringify(out.invoice));
  eq('Invoice total', out.invoice.total, 9440);
  eq('Split follows the client (in-state)', out.invoice.cgst, 720);
  check('SAC is the consultancy code', out.invoice.sac === '998311');
  check('Unpaid income becomes a receivable', out.lines.some(l => l.acc === '1100' && l.dr === 9440));
  const noParty = EV.otherinc.build({ date: '2026-12-03', desc: 'x', acc: '4040', amt: 100, gst: 'yes', gstRate: 18, gstAmt: 18, total: 118, via: '1000' });
  check('GST without a client is refused — an invoice needs a recipient', !!noParty.incomplete);
}

section('ITC register knows what a claim rests on');
{
  save('expense', { date: '2026-12-04', desc: 'Printer toner', acc: '5100', amt: 2000, gst: 'yes', gstRate: 18, gstAmt: 360, total: 2360, via: '1000', gstType: 'intra', vgstin: '33AAAAA0000A1Z5', vinv: 'INV-77' });
  save('expense', { date: '2026-12-05', desc: 'Stationery, no invoice', acc: '5100', amt: 500, gst: 'yes', gstRate: 18, gstAmt: 90, total: 590, via: '1010' });
  const rows = itcRegister('2026-12');
  const toner = rows.find(r => r.desc === 'Printer toner');
  const stat = rows.find(r => r.desc === 'Stationery, no invoice');
  check('A purchase with GSTIN and invoice no. is eligible', toner?.eligible === true, JSON.stringify(toner));
  check('One without them is flagged, not silently counted', stat?.eligible === false && /missing/.test(stat.reason), JSON.stringify(stat));
  check('Reverse-charge rows appear with their reason', rows.some(r => r.rcm && /Reverse charge/.test(r.reason)));
}

section('TDS thresholds, ageing, calendar, cash, tax');
{
  const balaji = s.parties.find(p => p.name === 'Balaji & Co').id;
  eq('Bills by one vendor this FY are totalled', tdsFyTotal(balaji, '2026-27'), 30000);
  const aged = agedReceivables('2026-12-31');
  check('Ageing buckets sum to the receivable', Math.abs(Object.values(aged).reduce((a, b) => a + b, 0) - bal('1100', { upto: '2026-12-31' })) < 0.02);
  const cal = complianceCalendar('2026-09-06', { tdsEnabled: true });
  check('Calendar starts with the next TDS deposit on the 7th', cal[0].what === 'TDS deposit' && cal[0].date === '2026-09-07', JSON.stringify(cal[0]));
  check('…then GSTR-1 on the 11th', cal[1].what === 'GSTR-1' && cal[1].date === '2026-09-11', JSON.stringify(cal[1]));
  check('Advance tax lands on 15 Sep', cal.some(c => c.what === 'Advance tax' && c.date === '2026-09-15'));
  const up = upcomingCash('2026-12-05');
  check('Upcoming cash lists the next EMI', up.items.some(i => /EMI/.test(i.what)));
  check('Upcoming cash lists reverse-charge GST', up.items.some(i => /GST/.test(i.what)));
  const tp = taxProvision(100000, 25.168);
  eq('Tax provision at the s.115BAA rate', tp.tax, 25168);
  eq('Profit after tax', tp.pat, 74832);
  eq('No tax on a loss', taxProvision(-5000).tax, 0);
}

section('Analytics — filters');
{
  const all = s.txns;
  const sep = filterTxns(all, { from: '2026-09-01', to: '2026-09-30', includeReversed: true });
  check('Date range keeps only September', sep.every(t => t.date.startsWith('2026-09')) && sep.length > 5, String(sep.length));
  const noRev = filterTxns(all, { from: '2026-09-01', to: '2026-12-31', includeReversed: false });
  check('Reversed pairs drop out by default', !noRev.some(t => t.reversedBy || t.reversalOf));
  const withRev = filterTxns(all, { from: '2026-09-01', to: '2026-12-31', includeReversed: true });
  check('…and come back when asked for', withRev.length === noRev.length + 2);
  const onDeal = filterTxns(all, { from: '2026-09-01', to: '2026-12-31', deal: deal1, includeReversed: true });
  check('Deal filter matches lines tagged with the deal', onDeal.length >= 3 && onDeal.every(t => t.lines.some(l => l.deal === deal1)));
  const card = filterTxns(all, { from: '2026-09-01', to: '2026-12-31', channel: '2300', includeReversed: true });
  check('Channel filter finds the card entries', card.length >= 3 && card.every(t => t.lines.some(l => l.acc === '2300')));
  const big = filterTxns(all, { from: '2026-09-01', to: '2026-12-31', minAmt: 100000, includeReversed: true });
  check('Amount floor keeps only the large entries', big.length >= 2 && big.every(t => num(t.totals.dr) >= 100000));
  const prev = previousRange({ from: '2026-10-01', to: '2026-10-31' });
  check('Previous range is the same length, immediately before', prev.from === '2026-09-01' && prev.to === '2026-09-30', JSON.stringify(prev));
}

section('Analytics — periods and rollups');
{
  check('Quarter key', periodKey('2026-11-15', 'quarter') === '2026-Q4');
  check('Year key', periodKey('2026-02-01', 'year') === '2026');
  const inRange = filterTxns(s.txns, { from: '2026-09-01', to: '2026-12-31', includeReversed: false });
  const series = seriesByPeriod(inRange, 'month', '2026-09-01', '2026-12-31');
  check('One row per month across the range, gaps filled', series.length === 4 && series.map(r => r.key).join() === '2026-09,2026-10,2026-11,2026-12', series.map(r => r.key).join());
  eq('October income in the series matches the P&L', series[1].income, pl('2026-10').ti);
  eq('October profit in the series matches the P&L', series[1].profit, pl('2026-10').profit);
  const q = seriesByPeriod(inRange, 'quarter', '2026-09-01', '2026-12-31');
  check('Quarterly rollup spans Q3 and Q4', q.length === 2 && q[0].key === '2026-Q3');
  const cash = runningCash(s.txns.filter(t => !t.reversedBy && !t.reversalOf), series, 'month');
  eq('Running cash at end of December equals bank + petty', cash[3].balance, bal('1000', { upto: '2026-12-31' }) + bal('1010', { upto: '2026-12-31' }));
  const exp = breakdown(inRange, 'expense');
  check('Expense breakdown is sorted largest first', exp.rows.every((r, i) => i === 0 || r.amount <= exp.rows[i - 1].amount));
  eq('Breakdown shares sum to 100', exp.rows.reduce((a, r) => a + r.share, 0), 100, 0.5);
  const k = kpis(filterTxns(s.txns, { from: '2026-10-01', to: '2026-10-31' }), filterTxns(s.txns, { from: '2026-09-01', to: '2026-09-30' }));
  eq('KPI income is October income', k.income, pl('2026-10').ti);
  check('KPI delta is computed against September', typeof k.delta.expense === 'number');
  const ch = byChannel(inRange);
  check('Channel table has all three channels', ch.length === 3 && ch.some(c => c.code === '2300' && c.out > 0));
}

section('Analytics — deals and collection');
{
  const f = dealFunnel(s);
  const d1 = f.find(d => d.id === deal1);
  eq('Deal funnel: invoiced brokerage', d1.invoiced, 100000);
  eq('Deal funnel: expected from both sides', d1.expected, 300000);
  eq('Deal funnel: nothing outstanding after payment', d1.outstanding, 0);
  check('Deal funnel: cash received on the deal is positive', d1.received > 0);
  const c = collectionDays(s);
  check('Days to collect measured from invoice to payment', c.count === 1 && c.avg === 8, JSON.stringify(c));
}

section('Display currency');
{
  check('Default is rupees', displayCurrency().code === 'INR');
  setDisplayCurrency('USD', 88);
  check('Large amounts convert with no cents', fmt(88000) === '$1,000', fmt(88000));
  check('Small amounts keep their cents', fmt(880) === '$10.00', fmt(880));
  check('Negatives keep the minus', fmt(-4400) === '−$50.00', fmt(-4400));
  check('Exactly $100 loses the cents', fmt(-8800) === '−$100', fmt(-8800));
  setDisplayCurrency('USD', 80);
  check('A different rate gives a different figure', fmt(80000) === '$1,000', fmt(80000));
  check('fmtInr ignores the toggle — documents stay in rupees', fmtInr(88000) === '₹88,000', fmtInr(88000));
  setDisplayCurrency('INR');
  check('Switching back restores rupees', fmt(88000) === '₹88,000', fmt(88000));
  check('Nothing in the ledger moved', trialBalance().balanced && balanceSheet().balanced);
}

section('Number formatting');
check('Indian grouping at lakh scale', fmt(1234567) === '₹12,34,567', fmt(1234567));
check('Indian grouping at thousand scale', fmt(45000) === '₹45,000', fmt(45000));
check('Negatives use a minus sign', fmt(-5000) === '−₹5,000', fmt(-5000));
check('Amount in words', words(118000) === 'One Lakh Eighteen Thousand Rupees Only', words(118000));

section('Financial year');
check('April starts the new FY', fyOf('2026-04-01', 4) === '2026-27', fyOf('2026-04-01', 4));
check('March is still the old FY', fyOf('2026-03-31', 4) === '2025-26', fyOf('2026-03-31', 4));
check('September falls in 2026-27', fyOf('2026-09-06', 4) === '2026-27', fyOf('2026-09-06', 4));

// ═══════ RESULT ═══════

console.log(`\n${'─'.repeat(58)}`);
console.log(`${passed} passed, ${failed} failed  ·  ${getState().txns.length} entries posted`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
console.log('All green.');
