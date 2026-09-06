// ═══════ ANALYTICS ═══════
//
// Slice the books any way you like — range, granularity, deal, party, channel, category,
// event, amount — and see the same set of pictures update: income against expenses and
// profit by period, cash moving with the running balance, where the money came from and
// went, deal by deal, and who the largest clients and vendors are. Every figure comes from
// finance-analytics.js, and every table exports.

import { A, EXP, fmt, esc, num, today, ym, addMonths, getState } from './finance-core.js';
import { EV } from './finance-events.js';
import {
  CHANNELS, defaultFilters, filterTxns, previousRange, seriesByPeriod, runningCash,
  breakdown, byChannel, byParty, kpis, dealFunnel, collectionDays, measures as measuresOf,
} from './finance-analytics.js';
import { stat, signed, empty, note, tag, table, seg, downloadCsv } from './ui.js';

let F = defaultFilters();

const ORANGE = '#F58A07', INK = '#17150F', GREY = '#D3CABC', GREEN = '#1F7A4D', LINE = '#E7E1D7', MUTED = '#8A8174';

// A phone gets a narrower drawing so bars and labels stay readable rather than the desktop
// picture scaled down to a third of its size.
const phone = () => typeof window !== 'undefined' && window.innerWidth < 600;
const short = n => {
  const a = Math.abs(n);
  if (a >= 1e7) return (n / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (a >= 1e5) return (n / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
  if (a >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(Math.round(n));
};

// ═══════ RENDER ═══════

export function renderAnalytics() {
  const s = getState();
  if (!s.txns.length) {
    return `<h1>Analytics</h1>${empty('<b>Nothing to analyse yet.</b><br>Record a few weeks of activity and this page fills in.')}`;
  }

  const txns = filterTxns(s.txns, F);
  const prev = filterTxns(s.txns, previousRange(F));
  const k = kpis(txns, prev);
  const series = seriesByPeriod(txns, F.granularity, F.from, F.to);
  const cashLine = runningCash(s.txns.filter(t => !t.reversedBy && !t.reversalOf || F.includeReversed), series, F.granularity);
  const inc = breakdown(txns, 'income'), exp = breakdown(txns, 'expense');
  const channels = byChannel(txns);
  const clients = byParty(txns, 'income'), vendors = byParty(txns, 'expense');
  const funnel = dealFunnel({ ...s, txns }, {});
  const coll = collectionDays(s);
  const events = [...new Set(s.txns.map(t => t.event))].sort();
  const active = Object.entries(F).filter(([key, v]) => !['from', 'to', 'granularity'].includes(key) && v !== '' && v !== false).length;

  return `
    <h1>Analytics</h1>
    <p class="lead">${txns.length} of ${s.txns.length} entries in view. Every chart below redraws from the filters.</p>

    <div class="card">
      <div class="filters">
        <input type="date" value="${esc(F.from)}" onchange="finAn.set('from',this.value)" aria-label="From">
        <input type="date" value="${esc(F.to)}" onchange="finAn.set('to',this.value)" aria-label="To">
        ${seg([['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']], F.granularity, 'finAn.gran')}
      </div>
      <div class="filters">
        <select onchange="finAn.set('deal',this.value)" aria-label="Deal">
          <option value="">All deals</option>
          ${s.deals.map(d => `<option value="${d.id}" ${F.deal === d.id ? 'selected' : ''}>${esc(d.nickname)}</option>`).join('')}
        </select>
        <select onchange="finAn.set('party',this.value)" aria-label="Party">
          <option value="">All parties</option>
          ${s.parties.map(p => `<option value="${p.id}" ${F.party === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <select onchange="finAn.set('channel',this.value)" aria-label="Channel">
          <option value="">All channels</option>
          ${Object.entries(CHANNELS).map(([c, l]) => `<option value="${c}" ${F.channel === c ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <select onchange="finAn.set('category',this.value)" aria-label="Category">
          <option value="">All categories</option>
          ${EXP.map(a => `<option value="${a.code}" ${F.category === a.code ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
        <select onchange="finAn.set('event',this.value)" aria-label="Type">
          <option value="">All types</option>
          ${events.map(e => `<option value="${esc(e)}" ${F.event === e ? 'selected' : ''}>${esc(EV[e]?.title || e)}</option>`).join('')}
        </select>
      </div>
      <div class="filters">
        <input type="number" placeholder="Min amount" value="${esc(F.minAmt)}" onchange="finAn.set('minAmt',this.value)" aria-label="Minimum amount">
        <input type="number" placeholder="Max amount" value="${esc(F.maxAmt)}" onchange="finAn.set('maxAmt',this.value)" aria-label="Maximum amount">
        <input type="search" placeholder="Search description" value="${esc(F.q)}" onchange="finAn.set('q',this.value)" aria-label="Search">
        <label class="small" style="display:flex;align-items:center;gap:6px;min-height:44px">
          <input type="checkbox" ${F.includeReversed ? 'checked' : ''} onchange="finAn.set('includeReversed',this.checked)" style="width:auto;min-height:0"> include reversed</label>
        ${active ? `<button class="btn ghost sm" type="button" onclick="finAn.reset()">Clear ${active} filter${active === 1 ? '' : 's'}</button>` : ''}
      </div>
    </div>

    <div class="grid g3">
      ${kpi('Income', k.income, k.delta.income)}
      ${kpi('Expenses', k.expense, k.delta.expense, true)}
      ${kpi('Profit', k.profit, k.delta.profit, false, true)}
      ${stat('Margin', k.margin + '%', { sub: 'Profit as a share of income' })}
      ${kpi('Cash in', k.cashIn, null)}
      ${kpi('Cash out', k.cashOut, null, true)}
      ${kpi('Net cash', k.net, k.delta.net)}
      ${stat('Days to collect', coll.avg == null ? '—' : coll.avg + ' days', { sub: coll.count ? `over ${coll.count} invoice${coll.count === 1 ? '' : 's'}` : 'No invoice has been paid yet' })}
    </div>
    <p class="small faint">Deltas compare with the period of the same length just before.</p>

    <h2>Income, expenses and profit by ${esc(F.granularity)}</h2>
    <div class="card">${groupedBars(series, [['income', ORANGE, 'Income'], ['expense', INK, 'Expenses']], 'profit', 'Profit')}</div>

    <h2>Cash moving, and the balance</h2>
    <div class="card">${groupedBars(series, [['cashIn', ORANGE, 'Cash in'], ['cashOut', INK, 'Cash out']], null, null, cashLine)}
      <p class="small muted" style="margin:8px 0 0">Bars are the movement inside each period; the line is the bank and petty-cash balance at the end of it.</p></div>

    <div class="record-split">
      <div>
        <h2>Where the income came from</h2>
        <div class="card">${hbars(inc.rows.map(r => [r.name, r.amount, r.share]), ORANGE)}
          <div class="actions" style="margin:10px 0 0"><button class="btn sm" type="button" onclick="finAn.csv('income')">CSV</button></div></div>
      </div>
      <div>
        <h2>Where the money went</h2>
        <div class="card">${hbars(exp.rows.slice(0, 12).map(r => [r.name, r.amount, r.share]), INK)}
          ${exp.rows.length > 12 ? `<p class="small faint" style="margin:8px 0 0">${exp.rows.length - 12} smaller categories not shown — in the CSV.</p>` : ''}
          <div class="actions" style="margin:10px 0 0"><button class="btn sm" type="button" onclick="finAn.csv('expense')">CSV</button></div></div>
      </div>
    </div>

    <h2>GST charged and claimed by ${esc(F.granularity)}</h2>
    <div class="card">${groupedBars(series, [['gstOut', INK, 'Output tax'], ['gstIn', ORANGE, 'Input credit']])}</div>

    <div class="record-split">
      <div>
        <h2>Paid through</h2>
        ${table(`<th>Channel</th><th class="n">In</th><th class="n">Out</th>`,
          channels.map(c => `<tr><td>${esc(c.name)}</td><td class="n">${c.in ? fmt(c.in) : '—'}</td><td class="n">${c.out ? fmt(c.out) : '—'}</td></tr>`).join(''))}
      </div>
      <div>
        <h2>Largest clients and vendors</h2>
        ${table(`<th>Clients</th><th class="n">Income</th>`, clients.length ? clients.map(p => `<tr><td>${esc(p.name)}</td><td class="n">${fmt(p.amount)}</td></tr>`).join('') : '<tr><td colspan="2" class="faint">None in this view</td></tr>')}
        ${table(`<th>Vendors</th><th class="n">Spend</th>`, vendors.length ? vendors.map(p => `<tr><td>${esc(p.name)}</td><td class="n">${fmt(p.amount)}</td></tr>`).join('') : '<tr><td colspan="2" class="faint">None in this view</td></tr>')}
      </div>
    </div>

    <h2>Deal by deal</h2>
    ${funnel.length ? `<div class="card">${dealBars(funnel)}</div>
      ${table(`<th>Deal</th><th>Status</th><th class="n">Expected</th><th class="n">Invoiced</th><th class="n">Received</th><th class="n">Costs</th><th class="n">Net</th>`,
        funnel.map(d => `<tr class="click" onclick="finDeals.open('${esc(d.id)}')">
          <td>${esc(d.name)}</td><td>${tag(d.status, d.status === 'registered' ? 'ok' : d.status === 'cancelled' ? 'rev' : '')}</td>
          <td class="n">${fmt(d.expected)}</td><td class="n">${fmt(d.invoiced)}</td><td class="n">${fmt(d.received)}</td>
          <td class="n">${d.costs ? fmt(d.costs) : '—'}</td><td class="n">${signed(d.net)}</td></tr>`).join(''))}
      <div class="actions"><button class="btn sm" type="button" onclick="finAn.csv('deals')">Deals CSV</button></div>`
      : empty('No deals in this view.')}

    <h2>Entries in view <span class="muted">(${txns.length})</span></h2>
    <div class="actions"><button class="btn sm" type="button" onclick="finAn.csv('entries')">Download these entries</button></div>
    ${table(`<th>#</th><th>Date</th><th>Description</th><th class="n">Income</th><th class="n">Expense</th><th class="n">Cash</th>`,
      txns.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50).map(t => {
        const m = measuresOf(t);
        return `<tr class="click" onclick="fin.openTxn('${esc(t.id)}')">
          <td class="eno">${t.no ? '#' + String(t.no).padStart(4, '0') : '—'}</td><td class="nowrap small">${esc(t.date)}</td><td>${esc(t.desc)}</td>
          <td class="n">${m.income ? fmt(m.income) : ''}</td><td class="n">${m.expense ? fmt(m.expense) : ''}</td><td class="n">${m.net ? signed(m.net) : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="faint">Nothing matches.</td></tr>')}
    ${txns.length > 50 ? `<p class="small faint">Showing the latest 50 — the CSV has all ${txns.length}.</p>` : ''}`;
}


function kpi(label, value, delta, invert = false, hero = false) {
  let sub = '';
  if (delta != null) {
    const good = invert ? delta <= 0 : delta >= 0;
    sub = `<span class="${good ? 'pos' : 'neg'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}%</span> vs previous`;
  }
  return stat(label, hero ? signed(value) : fmt(value), { raw: hero, hero, sub, subRaw: true });
}

// ═══════ CHARTS (inline SVG) ═══════

function groupedBars(series, keys, lineKey, lineLabel, extraLine) {
  if (!series.length) return '<p class="small faint">Nothing in this range.</p>';
  const W = phone() ? 380 : 720, H = 230, padL = phone() ? 38 : 44, padR = 12, top = 18, base = 196;
  const n = series.length;
  const slot = (W - padL - padR) / n;
  const bw = Math.max(3, Math.min(28, (slot - 8) / keys.length));
  const vals = series.flatMap(p => keys.map(([k]) => p[k]));
  if (lineKey) vals.push(...series.map(p => Math.abs(p[lineKey])));
  if (extraLine) vals.push(...extraLine.map(p => Math.abs(p.balance)));
  const peak = Math.max(1, ...vals.map(Math.abs));
  const y = v => base - (v / peak) * (base - top);

  const grid = [0.25, 0.5, 0.75, 1].map(f => `<line x1="${padL}" y1="${y(peak * f)}" x2="${W - padR}" y2="${y(peak * f)}" stroke="${LINE}" stroke-dasharray="2 3"/>
    <text x="${padL - 5}" y="${y(peak * f) + 3}" text-anchor="end" font-size="9" fill="#8A8174">${short(peak * f)}</text>`).join('');

  const bars = series.map((p, i) => keys.map(([k, color, label], j) => {
    const v = Math.max(0, p[k]);
    const x = padL + i * slot + (slot - keys.length * bw - (keys.length - 1) * 3) / 2 + j * (bw + 3);
    return `<rect x="${x}" y="${y(v)}" width="${bw}" height="${Math.max(0, base - y(v))}" rx="2" fill="${color}"><title>${esc(p.label)} — ${esc(label)}: ${esc(fmt(p[k]))}</title></rect>`;
  }).join('')).join('');

  const cx = i => padL + i * slot + slot / 2;
  const clampY = v => Math.min(base, Math.max(top, y(v)));
  const poly = (pts, color, dashed) => pts.length > 1
    ? `<polyline points="${pts.map(([px, py]) => `${px},${py}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" ${dashed ? 'stroke-dasharray="4 3"' : ''}/>` +
      pts.map(([px, py, v, lbl]) => `<circle cx="${px}" cy="${py}" r="3" fill="${color}"><title>${esc(lbl)}: ${esc(fmt(v))}</title></circle>`).join('')
    : '';

  let lines = '';
  if (lineKey) lines += poly(series.map((p, i) => [cx(i), clampY(p[lineKey]), p[lineKey], p.label + ' — ' + lineLabel]), GREEN, true);
  if (extraLine) lines += poly(extraLine.map((p, i) => [cx(i), clampY(p.balance), p.balance, p.label + ' — balance']), GREEN, false);

  // Too many periods for every label to fit: show every other one on a phone.
  const step = phone() && n > 6 ? 2 : 1;
  const labels = series.map((p, i) => i % step ? '' : `<text x="${cx(i)}" y="${base + 14}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(p.label)}</text>`).join('');

  // The legend lives outside the SVG so it wraps on a narrow screen instead of overflowing.
  const legend = [...keys.map(([, c, l]) => [c, l]),
    ...(lineKey ? [[GREEN, lineLabel + ' (line)']] : []),
    ...(extraLine ? [[GREEN, 'Balance (line)']] : [])]
    .map(([c, l]) => `<span style="white-space:nowrap"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${c};vertical-align:-1px"></span> ${esc(l)}</span>`).join(' &nbsp; ');

  return `<svg viewBox="0 0 ${W} ${H - 18}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">
    <title>${esc(keys.map(k => k[2]).join(' and '))} by period</title>
    ${grid}<line x1="${padL}" y1="${base}" x2="${W - padR}" y2="${base}" stroke="${LINE}"/>${bars}${lines}${labels}</svg>
    <p class="small muted" style="margin:6px 0 0">${legend}</p>`;
}

function hbars(rows, color) {
  if (!rows.length) return '<p class="small faint">Nothing in this view.</p>';
  const peak = Math.max(1, ...rows.map(r => Math.abs(r[1])));
  return `<div>${rows.map(([name, v, share]) => `
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0">
      <div class="small" style="flex:0 0 42%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(name)}">${esc(name)}</div>
      <div class="bar" style="flex:1;height:10px"><i style="width:${Math.max(1, Math.abs(v) / peak * 100)}%;background:${color}"></i></div>
      <div class="small n" style="flex:0 0 92px">${fmt(v)}</div>
      <div class="small faint n" style="flex:0 0 40px">${share != null ? share + '%' : ''}</div>
    </div>`).join('')}</div>`;
}

function dealBars(funnel) {
  const rows = funnel.slice(0, 10);
  const peak = Math.max(1, ...rows.flatMap(d => [d.expected, d.invoiced, d.received]));
  const w = v => Math.max(0.5, v / peak * 100);
  return `<div>${rows.map(d => `
    <div style="margin:8px 0">
      <div class="small" style="display:flex;justify-content:space-between"><span>${esc(d.name)}</span><span class="faint">${esc(d.status)}</span></div>
      <div class="bar" style="height:7px;margin:3px 0"><i style="width:${w(d.expected)}%;background:${GREY}" title="Expected ${esc(fmt(d.expected))}"></i></div>
      <div class="bar" style="height:7px;margin:3px 0"><i style="width:${w(d.invoiced)}%;background:${ORANGE}" title="Invoiced ${esc(fmt(d.invoiced))}"></i></div>
      <div class="bar" style="height:7px;margin:3px 0"><i style="width:${w(Math.max(0, d.received))}%;background:${INK}" title="Received ${esc(fmt(d.received))}"></i></div>
    </div>`).join('')}
    <p class="small muted" style="margin:8px 0 0"><span style="color:${GREY}">■</span> Expected &nbsp; <span style="color:${ORANGE}">■</span> Invoiced &nbsp; <span style="color:${INK}">■</span> Cash received</p>
  </div>`;
}

// ═══════ ACTIONS ═══════

if (typeof window !== 'undefined') {
  let wasPhone = phone();
  window.addEventListener('resize', () => {
    if (phone() === wasPhone) return;
    wasPhone = phone();
    if (location.hash === '#analytics') window.fin.repaint();
  });
  window.finAn = {
    set(k, v) { F[k] = v; window.fin.repaint(); },
    gran(v) { F.granularity = v; window.fin.repaint(); },
    reset() { const keep = { from: F.from, to: F.to, granularity: F.granularity }; F = { ...defaultFilters(), ...keep }; window.fin.repaint(); },
    csv(kind) {
      const s = getState();
      const txns = filterTxns(s.txns, F);
      const range = `${F.from}-to-${F.to}`;
      if (kind === 'income' || kind === 'expense') {
        const b = breakdown(txns, kind);
        downloadCsv(`3pin-${kind}-by-category-${range}.csv`, [['Code', 'Category', 'Amount', 'Share %'], ...b.rows.map(r => [r.code, r.name, r.amount, r.share])]);
      } else if (kind === 'deals') {
        downloadCsv(`3pin-deals-${range}.csv`, [['Deal', 'Status', 'Expected', 'Invoiced', 'Received', 'Outstanding', 'Tokens held', 'Costs', 'Net'],
          ...dealFunnel({ ...s, txns }).map(d => [d.name, d.status, d.expected, d.invoiced, d.received, d.outstanding, d.tokens, d.costs, d.net])]);
      } else {
        downloadCsv(`3pin-entries-${range}.csv`, [['Entry', 'Date', 'Type', 'Description', 'Income', 'Expense', 'Cash in', 'Cash out', 'GST out', 'GST in'],
          ...txns.map(t => { const m = measuresOf(t); return [t.no, t.date, t.event, t.desc, m.income, m.expense, m.cashIn, m.cashOut, m.gstOut, m.gstIn]; })]);
      }
    },
  };
}
