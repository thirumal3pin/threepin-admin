// ═══════ GUIDE — HOW TO USE, SOP, SCENARIOS, CHARTS, FAQ ═══════
//
// One section holding everything somebody needs to run these books without knowing
// bookkeeping. Five tabs: Start here, SOP, Scenarios, Charts, FAQ.
//
// The worked examples are not written out by hand. Each one runs the REAL event builder
// against a small set of sample books and prints whatever comes back — the same build()
// the Record screen calls. That means an example can never quietly drift away from what the
// app actually does: change the engine and the guide changes with it, or the guide breaks
// loudly. The sample books are swapped in and out around each call and never touch real data.

import {
  A, fmt, esc, num, ym, addMonths, mlabel, today,
  getState, setState, blank, defaultSettings, schedule, pl, bal,
} from './finance-core.js';
import { EV } from './finance-events.js';
import { note, tag, table, empty } from './ui.js';

let tab = 'start';

// ═══════ SAMPLE BOOKS ═══════
//
// A small but complete set of books: one deal holding a token, a vendor owed money, an
// annual plan, a monthly plan, a loan mid-repayment and an asset part-depreciated.

const S_START = '2026-09';
const S_NOW = '2026-10';

function sampleState() {
  const s = blank();
  s.settings = { ...defaultSettings(), booksStartDate: '2026-09-01', tdsEnabled: false };
  s.parties = [
    { id: 'P1', name: 'Mr. Karthik', type: 'client', phone: '98400 11111', state: 'Tamil Nadu' },
    { id: 'P2', name: 'Balaji & Co', type: 'vendor', phone: '98400 22222' },
    { id: 'P3', name: 'Priya', type: 'employee', phone: '98400 33333' },
    { id: 'P4', name: 'Card EMI', type: 'lender' },
  ];
  s.deals = [{
    id: 'D1', nickname: 'Rajan — Nungambakkam 2BHK',
    propertyCode: 'NUNG002', propertyName: 'Sunrise Apts',
    seller: null, buyer: { partyId: 'P1', name: 'Mr. Karthik', phone: '98400 11111' },
    others: [], expSeller: 0, expBuyer: 100000, status: 'open', opened: '2026-09-09',
  }];
  // A token already received, so "deal closed" has something real to adjust against.
  s.txns = [{
    id: 'T1', date: '2026-09-10', event: 'token', desc: 'Token — Rajan (Mr. Karthik)',
    lines: [{ acc: '1000', dr: 50000 }, { acc: '2100', cr: 50000, party: 'P1', deal: 'D1' }],
    totals: { dr: 50000, cr: 50000 }, meta: {}, attachments: [], auto: false,
    fy: '2026-27', createdBy: 'sample', createdAt: 0,
  }, {
    id: 'T2', date: '2026-09-12', event: 'bill', desc: 'Title opinion — Balaji & Co',
    lines: [{ acc: '5120', dr: 10000 }, { acc: '2000', cr: 10000, party: 'P2' }],
    totals: { dr: 10000, cr: 10000 }, meta: {}, attachments: [], auto: false,
    fy: '2026-27', createdBy: 'sample', createdAt: 0,
  }];
  s.subs = [
    {
      id: 'S1', name: 'Zoho CRM', vendor: 'Zoho', use: 'Lead pipeline', payMode: 'upfront',
      amount: 24000, monthly: 2000, via: '1000', start: S_START, end: '2027-08', months: 12,
      amortized: [S_START], charges: {}, status: 'active',
    },
    {
      id: 'S2', name: 'Claude Pro', vendor: 'Anthropic', use: 'Content', payMode: 'monthly',
      amount: 1800, monthly: 1800, via: '2300', start: S_START, end: null, months: 1,
      amortized: [], charges: {}, status: 'active',
    },
  ];
  s.loans = [{
    id: 'L1', lender: 'Card EMI', purpose: 'Sony A7 camera', principal: 80000,
    rate: 14, n: 12, start: '2026-10', schedule: schedule(80000, 14, 12, '2026-10'),
    paid: [], status: 'active', partyId: 'P4',
  }];
  s.assets = [{
    id: 'A1', name: 'MacBook Air', cost: 95000, date: '2026-09-03', start: S_START,
    life: 36, monthly: 95000 / 36, depreciated: [S_START], status: 'in use',
  }];
  return s;
}

// Swap the sample books in, run something, put the real books back. Synchronous on purpose:
// nothing may await in between or a render could see the wrong state.
function withSample(fn) {
  const real = getState();
  try {
    setState(sampleState());
    return fn();
  } finally {
    setState(real);
  }
}

// ═══════ SCENARIOS ═══════
//
// Each one is a real situation, the button to press, and the values to press it with. The
// journal and the consequences are produced by the engine, not typed here.

const SCENARIOS = [
  {
    group: 'A deal, start to finish',
    id: 'token',
    situation: 'A buyer pays you ₹50,000 to hold a flat. Nothing is registered yet.',
    event: 'token',
    values: { date: '2026-09-10', deal: 'D1', from: 'buyer', amt: 50000, via: '1000' },
    point: 'Cash went up ₹50,000 but you earned nothing. The money is still theirs until the deal registers — that is why profit does not move.',
  },
  {
    group: 'A deal, start to finish',
    id: 'invoice',
    situation: 'The deal registers. Your brokerage is ₹1,00,000 plus GST, and the ₹50,000 token comes off what they owe.',
    event: 'invoice',
    values: { date: '2026-10-06', deal: 'D1', from: 'buyer', base: 100000, gst: 18, tds: 0, adv: 50000, recv: 'later' },
    point: 'This is the moment income exists. The token converts, GST is collected on the government\'s behalf, and the rest becomes money they owe you.',
  },
  {
    group: 'A deal, start to finish',
    id: 'dealpay',
    situation: 'They pay the remaining ₹68,000 into your bank.',
    event: 'dealpay',
    values: { date: '2026-10-14', deal: 'D1', from: 'buyer', amt: 68000, via: '1000' },
    point: 'Cash arrives but profit does not change. The income was already counted when the deal registered — counting it again would double your earnings.',
  },
  {
    group: 'When it does not go to plan',
    id: 'settle-refund',
    situation: 'The deal falls through and you return the full ₹50,000 token.',
    event: 'settle',
    values: { date: '2026-10-20', deal: 'D1', from: 'buyer', refund: 50000, keep: 0, gst: 18, move: '', drop: 'yes' },
    point: 'Cash goes out, profit is untouched. You are giving back money that was never yours.',
  },
  {
    group: 'When it does not go to plan',
    id: 'settle-keep',
    situation: 'The buyer walks away and agrees you keep the ₹50,000.',
    event: 'settle',
    values: { date: '2026-10-20', deal: 'D1', from: 'buyer', refund: 0, keep: 50000, gst: 18, move: '', drop: 'yes' },
    point: 'Now it becomes income — but not all of it. GST is inside that ₹50,000, so only the amount net of tax is yours.',
  },
  {
    group: 'When it does not go to plan',
    id: 'writeoff',
    situation: 'A client owes you money and will never pay. You have chased and given up.',
    event: 'writeoff',
    values: { date: '2026-10-25', deal: 'D1', from: 'buyer', amt: 25000, why: 'Client unreachable since August' },
    point: 'Booking the loss stops your books claiming money you do not have. Keep evidence of the follow-ups.',
  },
  {
    group: 'Costs and paying people',
    id: 'bill',
    situation: 'A lawyer sends a ₹10,000 bill for a title opinion. You will pay next month.',
    event: 'bill',
    values: { date: '2026-10-12', vendor: 'P2', desc: 'Title opinion', acc: '5120', amt: 10000, gstin: 0, tds: 'none', tdsrate: 0 },
    point: 'The cost belongs to the month the work happened, not the month you pay. No cash has moved yet.',
  },
  {
    group: 'Costs and paying people',
    id: 'paybill',
    situation: 'You pay Balaji & Co the ₹10,000 you owed them.',
    event: 'paybill',
    values: { date: '2026-10-30', party: 'P2', amt: 10000, via: '1000' },
    point: 'Not an expense a second time. The cost was recorded when the bill arrived; this is only the cash leaving.',
  },
  {
    group: 'Costs and paying people',
    id: 'salary',
    situation: 'Priya is paid ₹25,000 gross for the month.',
    event: 'salary',
    values: { date: '2026-10-28', emp: 'P3', kind: '5010', gross: 25000, tds: 0, pf: 0 },
    point: 'Your cost is the gross figure, even though less than that leaves the bank when there are deductions to hold.',
  },
  {
    group: 'Things that last',
    id: 'asset',
    situation: 'You buy a ₹95,000 laptop that will last about three years.',
    event: 'asset',
    values: { date: '2026-10-03', name: 'MacBook Air', cost: 95000, gstin: 0, life: 36, via: '1000' },
    point: 'A big cash outflow that is not a cost yet. Spreading it over 36 months is what stops one purchase wrecking one month\'s profit.',
  },
  {
    group: 'Things that last',
    id: 'subnew',
    situation: 'You pay ₹24,000 upfront for a year of CRM software.',
    event: 'subnew',
    values: { date: '2026-10-05', name: 'Zoho CRM', vendor: 'Zoho', use: 'Lead pipeline', payMode: 'upfront', amount: 24000, months: 12, via: '1000' },
    point: 'Paid once, used twelve times. Month-end releases ₹2,000 of cost each month, so every month carries its fair share.',
  },
  {
    group: 'Borrowing and moving money',
    id: 'emi',
    situation: 'The first EMI on the camera loan goes out of your bank.',
    event: 'emi',
    values: { date: '2026-10-05', loan: 'L1', extra: 0 },
    point: 'Only the interest is a cost. The principal is you handing back money you borrowed — it was never your income to lose.',
  },
  {
    group: 'Borrowing and moving money',
    id: 'transfer',
    situation: 'You pay off ₹8,450 on the credit card from your bank account.',
    event: 'transfer',
    values: { date: '2026-10-25', kind: '1000>2300', amt: 8450 },
    point: 'Moving your own money around is never an expense. The purchase was the expense, back when you made it.',
  },
  {
    group: 'Borrowing and moving money',
    id: 'statutory',
    situation: 'You remit ₹18,000 of GST you collected to the government.',
    event: 'statutory',
    values: { date: '2026-10-20', kind: 'gst', amt: 18000, input: 0, late: 0 },
    point: 'Not a cost. You were holding it for the government from the day you invoiced.',
  },
];

// ═══════ RENDER ═══════

export function renderGuide() {
  const tabs = [
    ['start', 'Start here'],
    ['sop', 'SOP'],
    ['scenarios', 'Scenarios'],
    ['charts', 'Charts'],
    ['faq', 'FAQ'],
  ];
  return `
    <h1>Guide</h1>
    <p class="lead">You record what happened; the books keep themselves. This section is the
    manual — how to use it, the routine to follow, worked examples with real numbers, and answers.</p>

    <div class="seg" role="tablist" style="margin-bottom:18px;flex-wrap:wrap">
      ${tabs.map(([k, l]) =>
    `<button type="button" role="tab" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}"
         onclick="finGuide.setTab('${k}')">${esc(l)}</button>`).join('')}
    </div>

    ${({ start: startHere, sop: sopTab, scenarios: scenariosTab, charts: chartsTab, faq: faqTab }[tab] || startHere)()}`;
}

// ═══════ 1. START HERE ═══════

function startHere() {
  return `
    ${note('<b>The one idea.</b> Money moving and cost happening are two different things. A ₹24,000 annual plan is cash out once, but ₹2,000 of cost a month. A ₹15,000 EMI is ₹15,000 of cash out, but only the interest is a cost. A token is cash in that is not income. Keeping those apart is the whole point — it is what makes the profit figure honest.', 'info')}

    <h2>What each tab is for</h2>
    ${table(`<th>Tab</th><th>What you do there</th>`, [
      ['Overview', 'Your position at a glance — this month\'s profit, what cash is genuinely free to spend, who owes whom.'],
      ['Record', '<b>The only place anything is entered.</b> Pick what happened; the bookkeeping is worked out for you.'],
      ['Transactions', 'Everything recorded, newest first. Tap a row to see both sides of the entry, or to reverse it.'],
      ['Owed', 'The weekly worklist: who to chase and who to pay.'],
      ['Services', 'What your subscriptions actually cost per month, and what is charged this month.'],
      ['Loans', 'Each loan with its principal and interest kept apart, and the next EMI ready to record.'],
      ['Assets', 'What you own and how much value is left in it.'],
      ['Invoices', 'GST invoices, raised automatically when you close a deal.'],
      ['Bank', 'Import the statement and prove your books match reality.'],
      ['Reports', 'Profit and loss, trends, where the money went.'],
      ['Books', 'The accountant\'s view. The CSV here is what you send your CA.'],
      ['Profile', 'Company details and anything still missing.'],
      ['Settings', 'How the engine behaves — GST rate, books start date, bank accounts.'],
    ].map(([a, b]) => `<tr><td style="width:26%"><b>${esc(a)}</b></td><td>${b}</td></tr>`).join(''))}

    <h2>The three things to get right</h2>
    <div class="grid g1">
      <div class="card">
        <h3>1. Record it the same day</h3>
        <p class="small muted" style="margin:0">Memory is the weak link, not the software. Open Record, pick what
        happened, photograph the bill into the entry. Thirty seconds while you still remember what it was for.</p>
      </div>
      <div class="card">
        <h3>2. Never enter the same thing twice</h3>
        <p class="small muted" style="margin:0">If a screen offers a button, use it — it fills the form in for you.
        Recording a client payment as fresh income, on top of the invoice, is the single easiest way to
        believe you earned more than you did.</p>
      </div>
      <div class="card">
        <h3>3. Reconcile before you close a month</h3>
        <p class="small muted" style="margin:0">The bank statement is the only external check that exists.
        Twenty minutes a month is what separates books you can rely on from books you hope are right.</p>
      </div>
    </div>

    <h2>Fixing a mistake</h2>
    <p>Nothing is ever edited or deleted. You post the opposite entry instead, from
    <b>Transactions → Reverse</b>, and then record it correctly. Both entries stay visible.</p>
    ${note('That is deliberate, not a limitation. Books you can silently edit are books nobody can trust — including a tax officer, and including you in a year\'s time.')}`;
}

// ═══════ 2. SOP ═══════

function sopTab() {
  const step = (n, title, body, who) => `
    <div class="card" style="display:flex;gap:14px;align-items:flex-start">
      <div style="flex:none;width:30px;height:30px;border-radius:50%;background:var(--brand);color:#fff;
        display:grid;place-items:center;font-weight:700;font-size:14px">${n}</div>
      <div style="flex:1">
        <h3 style="margin:0 0 4px">${esc(title)}</h3>
        <p class="small muted" style="margin:0">${body}</p>
        ${who ? `<p class="small faint" style="margin:6px 0 0">${esc(who)}</p>` : ''}
      </div>
    </div>`;

  return `
    <h2>Every day</h2>
    ${step(1, 'Record what happened, as it happens',
    'Money in or out, a bill received, a token taken — open <b>Record</b> and enter it. Attach a photo of the bill or receipt to the entry itself, so the evidence and the number never get separated.',
    'Takes under a minute per entry.')}

    <h2>Every week</h2>
    ${step(2, 'Empty the petty cash box',
    'Record → <b>Petty cash</b>. Up to three categories at once. Then check the box balance on Overview matches the actual notes in the drawer.')}
    ${step(3, 'Confirm what your services actually charged',
    'Services tab → <b>Confirm charge</b> on anything showing "not yet". Pay-as-you-go tools like ad spend rarely match the estimate, so enter the real figure off the card statement.')}
    ${step(4, 'Work the Owed list, both ways',
    'Chase the oldest receivable first — anything past 30 days is flagged. Then pay what is due. Both lists have buttons that fill the form in for you.')}

    <h2>Every month</h2>
    ${step(5, 'Import the bank and card statements',
    'Bank tab → pick the account → upload the CSV. The first import asks you to confirm the columns; after that it is one tap.')}
    ${step(6, 'Clear everything unmatched',
    'On the statement but not in your books means you forgot to record it — tap <b>Create entry</b>. In your books but not on the statement means it never went through (reverse it) or it lands next month (leave it).')}
    ${step(7, 'Run month-end',
    'Only once the month shows <b>Reconciled ✓</b>. This posts depreciation and releases the monthly slice of anything paid upfront. Running it twice is harmless — the second run posts nothing.')}
    ${step(8, 'Pay GST and TDS, then send the CA the journal',
    'GST by the 20th, TDS by the 7th. Books tab → <b>Download journal CSV</b> is the file your accountant wants.',
    'Check current due dates with your CA — they move.')}

    <h2>Once a year</h2>
    ${step(9, 'Close the financial year',
    'Reports → switch to <b>By financial year</b> and download the full-year P&L. Books → export the year\'s journal and the JSON backup. Hand both to your CA with your bank statements.')}

    ${note('<b>If you only do one thing:</b> reconcile monthly. Everything else can be caught up later from bills and statements. Books that have never been checked against a bank statement cannot be caught up — you have no way of knowing what is missing.')}`;
}

// ═══════ 3. SCENARIOS ═══════

function scenariosTab() {
  const groups = [];
  for (const sc of SCENARIOS) {
    let g = groups.find(x => x.name === sc.group);
    if (!g) groups.push(g = { name: sc.group, items: [] });
    g.items.push(sc);
  }

  return `
    <p class="lead">Every example below is run through the real engine on a sample set of books, so
    what you see is exactly what the app would do. The sample has one open deal holding a ₹50,000
    token, a vendor owed ₹10,000, an annual and a monthly subscription, a camera loan and a laptop.</p>

    ${groups.map(g => `
      <h2>${esc(g.name)}</h2>
      ${g.items.map(renderScenario).join('')}`).join('')}`;
}

function renderScenario(sc) {
  const out = withSample(() => {
    try { return EV[sc.event].build({ ...sc.values }); }
    catch (e) { return { error: e.message }; }
  });

  if (!out || out.error) {
    return `<div class="card">${note(`This example could not be built: ${esc(out?.error || 'unknown')}`)}</div>`;
  }

  const lines = (out.lines || []).filter(l => num(l.dr) || num(l.cr));
  const dr = lines.reduce((a, l) => a + num(l.dr), 0);
  const cr = lines.reduce((a, l) => a + num(l.cr), 0);
  const balanced = Math.abs(dr - cr) < 0.5;

  // Party and deal names come from the sample books, so resolve them inside the swap too.
  const names = withSample(() => {
    const s = getState();
    const m = {};
    lines.forEach(l => {
      if (l.party) m['p' + l.party] = s.parties.find(p => p.id === l.party)?.name || l.party;
      if (l.deal) m['d' + l.deal] = s.deals.find(d => d.id === l.deal)?.nickname || l.deal;
    });
    return m;
  });

  return `
    <div class="card">
      <h3>${esc(sc.situation)}</h3>
      <p class="small muted" style="margin:2px 0 12px">
        Record → <b>${esc(EV[sc.event].title)}</b></p>

      <div class="grid g1" style="gap:0;margin-bottom:12px">
        <ul class="effects" style="margin-bottom:10px">
          ${(out.effects || []).map(e => `<li>${e}</li>`).join('')}
        </ul>
      </div>

      ${lines.length ? `
        <details class="journal">
          <summary>The double entry this creates</summary>
          <div class="tbl-wrap"><table>
            <thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead>
            <tbody>${lines.map(l => `<tr>
              <td>${esc(A[l.acc]?.name || l.acc)}
                ${l.party ? `<br><span class="small faint">${esc(names['p' + l.party] || '')}</span>` : ''}</td>
              <td class="n">${l.dr ? fmt(l.dr) : ''}</td>
              <td class="n">${l.cr ? fmt(l.cr) : ''}</td></tr>`).join('')}</tbody>
            <tfoot><tr>
              <td class="${balanced ? 'balanced ok' : 'balanced no'}">${balanced ? 'Balanced ✓' : 'Does not balance'}</td>
              <td class="n">${fmt(dr)}</td><td class="n">${fmt(cr)}</td></tr></tfoot>
          </table></div>
        </details>` : '<p class="small faint">Nothing is posted to the ledger — this only sets something up.</p>'}

      <div class="when" style="margin:12px 0 0">
        <b>The point.</b> ${sc.point}
      </div>
    </div>`;
}

// ═══════ 4. CHARTS ═══════

function chartsTab() {
  return `
    <p class="lead">Five pictures for the five things that confuse people most about their own books.</p>

    <h2>Cash is not profit</h2>
    <div class="card">
      ${cashVsProfitChart()}
      <p class="small muted" style="margin:10px 0 0">The same three months, measured two ways.
      October looks terrible on cash because a ₹95,000 laptop was bought and a year of software paid
      for — but almost none of that is October's <i>cost</i>. Judging the business on the cash line
      alone would have you believe you had a disastrous month when you had your best one.</p>
    </div>

    <h2>Paying once, using it all year</h2>
    <div class="card">
      ${prepaidChart()}
      <p class="small muted" style="margin:10px 0 0">₹24,000 leaves your bank in September.
      The cost does not. Each month-end releases ₹2,000, so every month carries the share it used.
      The bar is what you paid; the line is what it actually costs you as you go.</p>
    </div>

    <h2>An EMI is mostly not a cost</h2>
    <div class="card">
      ${emiChart()}
      <p class="small muted" style="margin:10px 0 0">Twelve instalments on the ₹80,000 camera loan.
      Only the small orange slice is an expense — the rest is you giving back money you borrowed.
      Notice the interest shrinking: early EMIs cost you more than later ones.</p>
    </div>

    <h2>What happens to a token</h2>
    <div class="card">
      ${tokenFlowChart()}
      <p class="small muted" style="margin:10px 0 0">A token sits in a holding account, not in income.
      Only one of the three exits turns it into earnings — and even then GST comes out of it first.</p>
    </div>

    <h2>Where a deal's money actually goes</h2>
    <div class="card">
      ${waterfallChart()}
      <p class="small muted" style="margin:10px 0 0">₹1,00,000 of brokerage is not ₹1,00,000 of profit.
      GST was never yours, the referral fee and the EC cost came out of it, and what is left is the
      real number.</p>
    </div>`;
}

// Grouped bars: cash movement against profit for the same months.
function cashVsProfitChart() {
  const data = [
    { m: 'Sep', cash: 120000, profit: -18000 },
    { m: 'Oct', cash: -142000, profit: 64000 },
    { m: 'Nov', cash: 38000, profit: 41000 },
  ];
  const W = 620, H = 280, pad = 34, mid = 118;
  const peak = 150000;
  const groupW = (W - pad * 2) / data.length;
  const bw = 46;

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>Cash movement versus profit for September, October and November. October has the worst cash and the best profit.</title>
      <line x1="${pad}" y1="${mid}" x2="${W - pad}" y2="${mid}" stroke="#E6E6E6"/>
      ${data.map((d, i) => {
    const cx = pad + i * groupW + groupW / 2;
    const bars = [
      { v: d.cash, x: cx - bw - 5, fill: '#111111', label: 'Cash' },
      { v: d.profit, x: cx + 5, fill: '#FE8D00', label: 'Profit' },
    ];
    return bars.map(b => {
      const h = Math.max(2, Math.abs(b.v) / peak * 92);
      const y = b.v >= 0 ? mid - h : mid;
      return `<rect x="${b.x}" y="${y}" width="${bw}" height="${h}" rx="3" fill="${b.fill}"/>
                <text x="${b.x + bw / 2}" y="${b.v >= 0 ? y - 6 : y + h + 14}" text-anchor="middle"
                  font-size="10.5" fill="#3F3F3F" font-weight="600">${esc(fmt(b.v))}</text>`;
    }).join('') + `<text x="${cx}" y="246" text-anchor="middle" font-size="12" fill="#6B6B6B">${d.m}</text>`;
  }).join('')}
      <rect x="${pad}" y="264" width="11" height="11" rx="2" fill="#111111"/>
      <text x="${pad + 17}" y="273" font-size="11" fill="#6B6B6B">Cash in / out</text>
      <rect x="${pad + 110}" y="264" width="11" height="11" rx="2" fill="#FE8D00"/>
      <text x="${pad + 127}" y="273" font-size="11" fill="#6B6B6B">Profit</text>
    </svg>`;
}

// One tall bar of cash out, then a flat line of monthly cost.
function prepaidChart() {
  const W = 620, H = 210, pad = 34, base = 150;
  const months = Array.from({ length: 12 }, (_, i) => addMonths('2026-09', i));
  const step = (W - pad * 2 - 60) / 12;
  const cashH = 110, costH = cashH * (2000 / 24000) * 6; // exaggerated so ₹2,000 stays visible

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>Twenty-four thousand rupees paid once in September, released as two thousand rupees of cost each month for twelve months.</title>
      <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="#E6E6E6"/>
      <rect x="${pad}" y="${base - cashH}" width="34" height="${cashH}" rx="3" fill="#111111"/>
      <text x="${pad + 17}" y="${base - cashH - 7}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#3F3F3F">${esc(fmt(24000))}</text>
      <text x="${pad + 17}" y="${base + 15}" text-anchor="middle" font-size="10.5" fill="#6B6B6B">paid</text>
      ${months.map((m, i) => {
    const x = pad + 60 + i * step;
    return `<rect x="${x}" y="${base - costH}" width="${step - 5}" height="${costH}" rx="2" fill="#FE8D00"/>
              <text x="${x + (step - 5) / 2}" y="${base + 15}" text-anchor="middle" font-size="9" fill="#949494">${esc(mlabel(m).slice(0, 3))}</text>`;
  }).join('')}
      <text x="${pad + 60}" y="${base - costH - 8}" font-size="10.5" font-weight="600" fill="#3F3F3F">${esc(fmt(2000))} of cost a month</text>
      <rect x="${pad}" y="${H - 18}" width="11" height="11" rx="2" fill="#111111"/>
      <text x="${pad + 17}" y="${H - 9}" font-size="11" fill="#6B6B6B">Cash out</text>
      <rect x="${pad + 100}" y="${H - 18}" width="11" height="11" rx="2" fill="#FE8D00"/>
      <text x="${pad + 117}" y="${H - 9}" font-size="11" fill="#6B6B6B">Actual monthly cost</text>
    </svg>`;
}

// Stacked bars: principal (not a cost) under interest (the only cost).
function emiChart() {
  const sch = schedule(80000, 14, 12, '2026-10');
  const W = 620, H = 230, pad = 34, base = 165;
  const step = (W - pad * 2) / 12;
  const peak = Math.max(...sch.map(s => s.emi));

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>Twelve EMIs on an eighty thousand rupee loan. Each instalment is mostly principal, with a shrinking slice of interest that is the only real cost.</title>
      <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="#E6E6E6"/>
      ${sch.map((s, i) => {
    const x = pad + i * step;
    const w = step - 6;
    const total = (s.emi / peak) * 120;
    const ih = Math.max(2, (s.int / peak) * 120);
    const ph = Math.max(2, total - ih);
    return `<rect x="${x}" y="${base - ph}" width="${w}" height="${ph}" rx="2" fill="#D9D9D9"/>
              <rect x="${x}" y="${base - ph - ih}" width="${w}" height="${ih}" rx="2" fill="#FE8D00"/>
              <text x="${x + w / 2}" y="${base + 14}" text-anchor="middle" font-size="9" fill="#949494">${s.n}</text>`;
  }).join('')}
      <text x="${pad}" y="${base - 135}" font-size="11" fill="#6B6B6B">Interest falls from ${esc(fmt(sch[0].int))} to ${esc(fmt(sch.at(-1).int))} a month</text>
      <rect x="${pad}" y="${H - 18}" width="11" height="11" rx="2" fill="#D9D9D9"/>
      <text x="${pad + 17}" y="${H - 9}" font-size="11" fill="#6B6B6B">Principal — not a cost</text>
      <rect x="${pad + 160}" y="${H - 18}" width="11" height="11" rx="2" fill="#FE8D00"/>
      <text x="${pad + 177}" y="${H - 9}" font-size="11" fill="#6B6B6B">Interest — the only cost</text>
    </svg>`;
}

// A small flow diagram. Boxes and arrows, no library.
function tokenFlowChart() {
  const W = 620, H = 210;
  const box = (x, y, w, h, fill, stroke, label, sub, textFill = '#111111') => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}"/>
    <text x="${x + w / 2}" y="${y + (sub ? 24 : h / 2 + 4)}" text-anchor="middle" font-size="12.5" font-weight="600" fill="${textFill}">${esc(label)}</text>
    ${sub ? `<text x="${x + w / 2}" y="${y + 42}" text-anchor="middle" font-size="10.5" fill="#6B6B6B">${esc(sub)}</text>` : ''}`;
  const arrow = (x1, y1, x2, y2) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#B5B5B5" stroke-width="1.5" marker-end="url(#gArrow)"/>`;

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>A token is received into a holding account, and leaves it in one of three ways: refunded, adjusted against the invoice, or forfeited to income.</title>
      <defs><marker id="gArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M0,0 L10,5 L0,10 z" fill="#B5B5B5"/></marker></defs>

      ${box(14, 78, 130, 54, '#FFF4E3', '#FFDCAE', 'Token received', 'Cash in')}
      ${arrow(148, 105, 196, 105)}
      ${box(200, 70, 140, 70, '#111111', '#111111', 'Held for client', 'Not income', '#FFFFFF')}

      ${arrow(344, 92, 396, 42)}
      ${arrow(344, 105, 396, 105)}
      ${arrow(344, 118, 396, 168)}

      ${box(400, 16, 206, 50, '#FFFFFF', '#E6E6E6', 'Refunded', 'Cash out · profit untouched')}
      ${box(400, 80, 206, 50, '#FFFFFF', '#E6E6E6', 'Adjusted on the invoice', 'Becomes income at registration')}
      ${box(400, 144, 206, 50, '#FFF4E3', '#FFDCAE', 'Forfeited', 'Income now, less GST')}
    </svg>`;
}

// Waterfall from gross brokerage down to what you keep.
function waterfallChart() {
  const steps = [
    { label: 'Invoiced', v: 118000, kind: 'start' },
    { label: 'GST', v: -18000, kind: 'down' },
    { label: 'Referral fee', v: -15000, kind: 'down' },
    { label: 'EC & legal', v: -10000, kind: 'down' },
    { label: 'You keep', v: 75000, kind: 'end' },
  ];
  const W = 620, H = 235, pad = 34, base = 170, top = 26;
  const step = (W - pad * 2) / steps.length;
  const peak = 118000;
  const h = v => (Math.abs(v) / peak) * (base - top);

  let running = 0;
  const bars = steps.map((s, i) => {
    const x = pad + i * step + 10;
    const w = step - 26;
    let y, height, fill;
    if (s.kind === 'start') { height = h(s.v); y = base - height; running = s.v; fill = '#111111'; }
    else if (s.kind === 'end') { height = h(s.v); y = base - height; fill = '#FE8D00'; }
    else { height = h(s.v); running += s.v; y = base - h(running) - height; fill = '#D9D9D9'; }
    return `<rect x="${x}" y="${y}" width="${w}" height="${height}" rx="3" fill="${fill}"/>
      <text x="${x + w / 2}" y="${y - 6}" text-anchor="middle" font-size="10.5" font-weight="600"
        fill="${s.kind === 'down' ? '#C0261B' : '#3F3F3F'}">${s.kind === 'down' ? '−' : ''}${esc(fmt(Math.abs(s.v)))}</text>
      <text x="${x + w / 2}" y="${base + 16}" text-anchor="middle" font-size="10.5" fill="#6B6B6B">${esc(s.label)}</text>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
      <title>A one lakh eighteen thousand rupee invoice reduces to seventy-five thousand kept, after GST, a referral fee and deal costs.</title>
      <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="#E6E6E6"/>
      ${bars}
      <text x="${pad}" y="${H - 8}" font-size="11" fill="#949494">GST was never yours — you collected it for the government.</text>
    </svg>`;
}

// ═══════ 5. FAQ ═══════

const FAQ = [
  {
    q: 'A client paid me. Why has my profit not gone up?',
    a: 'Because it already did, on the day the deal registered and you raised the invoice. That is when you earned the money. The payment is just the cash arriving afterwards. If receiving it increased profit too, you would be counting the same brokerage twice.',
  },
  {
    q: 'My bank balance is healthy but the app says I made a loss. Which is right?',
    a: 'Both. Cash includes money that is not yours — client tokens you are holding, GST you owe the government, bills you have not paid yet. That is what <b>"free to use"</b> on the Overview is for: it strips those out. A loss with cash in the bank usually means you are holding other people\'s money.',
  },
  {
    q: 'I bought a laptop. Why is it not an expense?',
    a: 'It will still be working in two years, so charging the whole cost to one month would make that month look far worse than it was and every later month better. Instead it becomes an asset and a slice of it becomes a cost each month at month-end. Anything under your capitalisation threshold in Settings is just an expense.',
  },
  {
    q: 'I paid a ₹15,000 EMI. Why did my costs only go up by about ₹900?',
    a: 'Because most of an EMI is you repaying money you borrowed — that was never income, so giving it back is not a cost. Only the interest is. Look at the Loans tab: each instalment shows the split.',
  },
  {
    q: 'When does a token become my money?',
    a: 'When the deal registers and you record <b>Deal closed</b> — it comes off what the client owes you. Or if they walk away and agree you keep it, in which case use <b>Settle a token</b> → Keep, and it becomes income under Forfeited advances, less GST.',
  },
  {
    q: 'I recorded something wrong. Can I just fix the number?',
    a: 'No, and that is on purpose. Go to Transactions, open the entry, and press <b>Reverse</b>. That posts a mirror-image entry so the two cancel out, then you record it correctly. Both stay visible, which is what makes the books trustworthy to your CA and to a tax officer.',
  },
  {
    q: 'What is the difference between Profile and Settings?',
    a: '<b>Profile</b> is who the company is — GSTIN, registered address, bank details for invoices — plus a checklist of what is still blank. <b>Settings</b> is how the engine behaves: GST rate, books start date, capitalisation threshold, bank accounts.',
  },
  {
    q: 'Do I have to reconcile every month?',
    a: 'You should. It is the only check on your books that comes from outside them. Month-end will warn you if the month is not reconciled, and you can override — but the override is recorded against your name, because someone will eventually ask why the figures do not match the bank.',
  },
  {
    q: 'Where do my bill photos go?',
    a: 'Into a <b>3PIN Finance</b> folder in your Google Drive, inside the same Sales Properties folder your brochures live in, organised as financial year then entry. You can change the folder in Settings → Attachments.',
  },
  {
    q: 'TDS fields are not showing.',
    a: 'They are switched off. All the TDS logic is built and tested — flip <b>Show TDS fields</b> in Settings when your CA says to start deducting. Nothing needs rebuilding.',
  },
  {
    q: 'Can I add my own expense category?',
    a: 'Settings → Chart of accounts → Add a category. Expenses use codes in the 5000s and income the 4000s. Note that a brand-new category needs a small code change before it appears in the Record forms.',
  },
  {
    q: 'What do I actually send my accountant?',
    a: 'Books tab → <b>Download journal CSV</b>. That is every entry with both sides and account names. There is a Tally-shaped export next to it if they use Tally, and <b>Export everything (JSON)</b> as a backup you should take before any big change.',
  },
  {
    q: 'What happens if I run month-end twice?',
    a: 'Nothing. It knows which months each asset and prepaid plan have already been processed for, so a second run posts no entries at all. It is safe to press if you are unsure.',
  },
  {
    q: 'I have not entered my opening balances yet. Does it matter?',
    a: 'Yes — until you do, the books think you started from nothing, so your balance sheet and cash figures will be wrong. Go to Overview → Enter opening balances. That screen locks after one use, so do it carefully, ideally with your CA.',
  },
];

function faqTab() {
  return `
    <p class="lead">The questions that come up first, answered in plain words.</p>
    ${FAQ.map(f => `
      <details class="journal" style="border:1px solid var(--line);border-radius:var(--r-lg);
        padding:12px 14px;margin-bottom:8px;border-top:1px solid var(--line)">
        <summary style="font-weight:600;color:var(--ink);font-size:14.5px">${esc(f.q)}</summary>
        <p class="small muted" style="margin:8px 0 0">${f.a}</p>
      </details>`).join('')}

    ${note('Still stuck, or something looks wrong? Export the JSON backup from the Books tab before changing anything, then ask. A backup costs nothing and makes every problem reversible.')}`;
}

// ═══════ TAB STATE ═══════

if (typeof window !== 'undefined') {
  window.finGuide = {
    setTab(t) { tab = t; window.fin.repaint(); },
  };
}
