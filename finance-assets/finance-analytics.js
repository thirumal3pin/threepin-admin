// ═══════ 3 PIN REALTY — ANALYTICS ═══════
//
// Pure computations behind the Analytics tab: filter the ledger any way the owner wants to
// slice it, then roll it up by period, by category, by deal, by party and by channel. No DOM
// and no Firestore, so the same code runs under `node --test` and every figure the charts
// draw is one a test can assert.
//
// Everything works from transaction lines, which is why a filter on a deal or a party is
// exact: a line either carries that tag or it does not.

import { A, num, ym, addMonths, today, getState } from './finance-core.js';

export const CHANNELS = { '1000': 'Bank / UPI', '1010': 'Petty cash', '2300': 'Credit card' };
const CASH = ['1000', '1010'];
const GST_OUT = ['2200', '2201', '2202'];
const GST_IN = ['1400', '1401', '1402'];
const r2 = x => Math.round(num(x) * 100) / 100;

export function defaultFilters() {
  const m = ym(today());
  return {
    from: addMonths(m, -5) + '-01', to: today(), granularity: 'month',
    deal: '', party: '', event: '', channel: '', category: '',
    includeReversed: false, minAmt: '', maxAmt: '', q: '',
  };
}

// ═══════ FILTERING ═══════

export function filterTxns(txns, f) {
  return txns.filter(t => {
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (!f.includeReversed && (t.reversedBy || t.reversalOf)) return false;
    if (f.event && t.event !== f.event) return false;
    if (f.deal && !t.lines.some(l => l.deal === f.deal)) return false;
    if (f.party && !t.lines.some(l => l.party === f.party)) return false;
    if (f.channel && !t.lines.some(l => l.acc === f.channel)) return false;
    if (f.category && !t.lines.some(l => l.acc === f.category)) return false;
    const amt = num(t.totals?.dr);
    if (f.minAmt !== '' && f.minAmt != null && amt < num(f.minAmt)) return false;
    if (f.maxAmt !== '' && f.maxAmt != null && amt > num(f.maxAmt)) return false;
    if (f.q && !(t.desc || '').toLowerCase().includes(String(f.q).toLowerCase())) return false;
    return true;
  });
}

// The same range, one step earlier, for "compared with the previous period". A range that
// is whole calendar months steps back by months — October compares with September, not
// with 31 August to 30 September — and anything else steps back by its length in days.
export function previousRange(f) {
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const from = new Date(f.from + 'T00:00:00'), to = new Date(f.to + 'T00:00:00');
  const lastOfMonth = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === d.getDate();
  if (from.getDate() === 1 && lastOfMonth(to)) {
    const months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1;
    const pFrom = new Date(from.getFullYear(), from.getMonth() - months, 1);
    const pTo = new Date(from.getFullYear(), from.getMonth(), 0);
    return { ...f, from: iso(pFrom), to: iso(pTo) };
  }
  const days = Math.max(1, Math.round((to - from) / 86400000) + 1);
  const pTo = new Date(from); pTo.setDate(pTo.getDate() - 1);
  const pFrom = new Date(pTo); pFrom.setDate(pFrom.getDate() - days + 1);
  return { ...f, from: iso(pFrom), to: iso(pTo) };
}

// ═══════ PER-TRANSACTION MEASURES ═══════

export function measures(t) {
  let income = 0, expense = 0, cashIn = 0, cashOut = 0, gstOut = 0, gstIn = 0;
  for (const l of t.lines) {
    const a = A[l.acc];
    if (a?.type === 'income') income += num(l.cr) - num(l.dr);
    if (a?.type === 'expense') expense += num(l.dr) - num(l.cr);
    if (CASH.includes(l.acc)) { cashIn += num(l.dr); cashOut += num(l.cr); }
    if (GST_OUT.includes(l.acc)) gstOut += num(l.cr) - num(l.dr);
    if (GST_IN.includes(l.acc)) gstIn += num(l.dr) - num(l.cr);
  }
  return { income, expense, profit: income - expense, cashIn, cashOut, net: cashIn - cashOut, gstOut, gstIn };
}

// ═══════ PERIODS ═══════

export function periodKey(date, granularity) {
  const [y, m] = String(date).split('-').map(Number);
  if (granularity === 'year') return String(y);
  if (granularity === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  return String(date).slice(0, 7);
}

export function periodLabel(key) {
  if (/^\d{4}$/.test(key)) return key;
  if (/Q/.test(key)) { const [y, q] = key.split('-'); return `${q} ${y}`; }
  return new Date(key + '-01T00:00:00').toLocaleString('en-IN', { month: 'short', year: '2-digit' });
}

function nextPeriod(key, granularity) {
  if (granularity === 'year') return String(Number(key) + 1);
  if (granularity === 'quarter') {
    const [y, q] = key.split('-Q').map(Number);
    return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
  }
  return addMonths(key, 1);
}

// Totals per period, with empty periods filled in so a quiet month shows as zero rather
// than vanishing from the chart and making the trend look better than it was.
export function seriesByPeriod(txns, granularity = 'month', from, to) {
  const map = {};
  const add = (k, m) => {
    const row = map[k] = map[k] || { key: k, label: periodLabel(k), income: 0, expense: 0, profit: 0, cashIn: 0, cashOut: 0, net: 0, gstOut: 0, gstIn: 0, entries: 0 };
    for (const f of ['income', 'expense', 'profit', 'cashIn', 'cashOut', 'net', 'gstOut', 'gstIn']) row[f] += m[f];
    row.entries++;
  };
  for (const t of txns) add(periodKey(t.date, granularity), measures(t));
  const keys = Object.keys(map).sort();
  const first = from ? periodKey(from, granularity) : keys[0];
  const last = to ? periodKey(to, granularity) : keys[keys.length - 1];
  const out = [];
  if (!first) return out;
  for (let k = first, guard = 0; k <= last && guard < 120; k = nextPeriod(k, granularity), guard++) {
    out.push(map[k] || { key: k, label: periodLabel(k), income: 0, expense: 0, profit: 0, cashIn: 0, cashOut: 0, net: 0, gstOut: 0, gstIn: 0, entries: 0 });
  }
  for (const r of out) for (const f of Object.keys(r)) if (typeof r[f] === 'number') r[f] = r2(r[f]);
  return out;
}

// Running cash balance at the end of each period — needs the whole ledger up to each point,
// not just the filtered slice, or the line would start from zero.
export function runningCash(allTxns, series, granularity) {
  return series.map(p => {
    const endKey = p.key;
    let bal = 0;
    for (const t of allTxns) {
      if (periodKey(t.date, granularity) > endKey) continue;
      for (const l of t.lines) if (CASH.includes(l.acc)) bal += num(l.dr) - num(l.cr);
    }
    return { key: p.key, label: p.label, balance: r2(bal) };
  });
}

// ═══════ BREAKDOWNS ═══════

export function breakdown(txns, type) {
  const map = {};
  for (const t of txns) for (const l of t.lines) {
    const a = A[l.acc];
    if (!a || a.type !== type) continue;
    const v = type === 'income' ? num(l.cr) - num(l.dr) : num(l.dr) - num(l.cr);
    map[l.acc] = (map[l.acc] || 0) + v;
  }
  const rows = Object.entries(map).filter(([, v]) => Math.abs(v) > 0.5)
    .map(([code, amount]) => ({ code, name: A[code].name, amount: r2(amount) }))
    .sort((a, b) => b.amount - a.amount);
  const total = rows.reduce((a, r) => a + r.amount, 0);
  rows.forEach(r => { r.share = total ? r2(r.amount / total * 100) : 0; });
  return { rows, total: r2(total) };
}

export function byChannel(txns) {
  const out = {}, inn = {};
  for (const t of txns) for (const l of t.lines) {
    if (!CHANNELS[l.acc]) continue;
    if (l.acc === '2300') { out[l.acc] = (out[l.acc] || 0) + num(l.cr); continue; }
    out[l.acc] = (out[l.acc] || 0) + num(l.cr);
    inn[l.acc] = (inn[l.acc] || 0) + num(l.dr);
  }
  return Object.keys(CHANNELS).map(code => ({ code, name: CHANNELS[code], out: r2(out[code] || 0), in: r2(inn[code] || 0) }));
}

// Who brought the money in and who it went to, by the party tag on the lines.
export function byParty(txns, kind) {
  const map = {};
  const s = getState();
  for (const t of txns) {
    const m = measures(t);
    const v = kind === 'income' ? m.income : m.expense;
    if (v <= 0.5) continue;
    const pid = t.lines.find(l => l.party)?.party;
    if (!pid) continue;
    map[pid] = (map[pid] || 0) + v;
  }
  return Object.entries(map).map(([id, amount]) => ({ id, name: s.parties.find(p => p.id === id)?.name || id, amount: r2(amount) }))
    .sort((a, b) => b.amount - a.amount).slice(0, 10);
}

// ═══════ KPIs ═══════

export function kpis(txns, prevTxns) {
  const sum = list => list.reduce((acc, t) => {
    const m = measures(t);
    for (const k of Object.keys(m)) acc[k] = (acc[k] || 0) + m[k];
    return acc;
  }, { income: 0, expense: 0, profit: 0, cashIn: 0, cashOut: 0, net: 0, gstOut: 0, gstIn: 0 });
  const cur = sum(txns), prev = sum(prevTxns || []);
  const delta = k => prev[k] ? r2((cur[k] - prev[k]) / Math.abs(prev[k]) * 100) : null;
  return {
    ...Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, r2(v)])),
    margin: cur.income ? r2(cur.profit / cur.income * 100) : 0,
    entries: txns.length,
    delta: { income: delta('income'), expense: delta('expense'), profit: delta('profit'), net: delta('net') },
  };
}

// ═══════ DEALS ═══════

export function dealFunnel(state, f = {}) {
  return state.deals
    .filter(d => !f.status || d.status === f.status)
    .map(d => {
      let invoiced = 0, costs = 0, received = 0, outstanding = 0, tokens = 0;
      for (const t of state.txns) {
        if (!t.lines.some(l => l.deal === d.id)) continue;
        for (const l of t.lines) {
          const a = A[l.acc];
          if (l.deal === d.id && a?.type === 'income') invoiced += num(l.cr) - num(l.dr);
          if (l.deal === d.id && a?.type === 'expense') costs += num(l.dr) - num(l.cr);
          if (l.deal === d.id && l.acc === '1100') outstanding += num(l.dr) - num(l.cr);
          if (l.deal === d.id && l.acc === '2100') tokens += num(l.cr) - num(l.dr);
          if (CASH.includes(l.acc)) received += num(l.dr) - num(l.cr);
        }
      }
      return {
        id: d.id, name: d.nickname, status: d.status,
        expected: num(d.expSeller) + num(d.expBuyer),
        invoiced: r2(invoiced), received: r2(received), outstanding: r2(outstanding),
        tokens: r2(tokens), costs: r2(costs), net: r2(invoiced - costs),
      };
    })
    .sort((a, b) => b.expected + b.invoiced - (a.expected + a.invoiced));
}

// Days from an invoice to the cash that settled it, averaged — the number that says how
// long the business waits to be paid.
export function collectionDays(state) {
  const spans = [];
  for (const inv of state.txns.filter(t => t.event === 'invoice')) {
    for (const l of inv.lines) {
      if (l.acc !== '1100' || !num(l.dr)) continue;
      const pay = state.txns.find(t => t.event === 'dealpay' && t.date >= inv.date &&
        t.lines.some(x => x.acc === '1100' && x.party === l.party && x.deal === l.deal && num(x.cr)));
      if (pay) spans.push(Math.round((new Date(pay.date) - new Date(inv.date)) / 86400000));
    }
  }
  if (!spans.length) return { avg: null, count: 0 };
  return { avg: Math.round(spans.reduce((a, b) => a + b, 0) / spans.length), count: spans.length };
}
