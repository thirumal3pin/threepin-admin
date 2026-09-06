// Finance email reminders — ONE endpoint, ONE cron entry.
//
// The Vercel plan already spends two cron slots (api/followup-digest.js and
// api/dashboard-summary.js), so all three finance reports hang off a single
// 08:00 IST daily run that decides for itself which of them are due today:
//
//   weekly    — Mondays IST: cash, overdue clients, bills, renewals, GST/TDS,
//               and whether last month is closed and reconciled
//   renewals  — any day a subscription renewal is exactly 3 days out
//   monthly   — the 2nd IST: last month's P&L, with the journal CSV attached
//
// Nothing due means nothing sent — the response says so instead. An empty
// "here is your nothing" email is how people learn to ignore the ones that
// matter. Mirrors followup-digest.js / dashboard-summary.js exactly: GET is
// the cron (Bearer CRON_SECRET), POST is the CRM's "send now" button
// (Firebase-auth'd), and ?force=weekly|monthly|renewals on POST runs one
// report on demand regardless of the day.

import { getDb, verifyCrmUser, sendEmail } from './_bot-shared.js';
import {
  A, setState, blank, num, esc, bal, pl, cashPosition, partyBalances,
  fmt, ym, addMonths, mlabel, prepaidLeft, serviceRunRate,
} from '../finance-assets/finance-core.js';

// The finance book is single-tenant and lives under one root document so it
// never mixes with CRM data — same constant style as api/_inventory-shared.js.
const TENANT_ID = 't_3pinrealty';
const FINANCE_ROOT = `finance/${TENANT_ID}`;

const KINDS = ['weekly', 'renewals', 'monthly'];

// ── Thresholds, all in one place so the operator can find them ──────────
const CLIENT_OVERDUE_DAYS = 14;   // "overdue by more than 14 days"
const RENEWAL_ALERT_DAYS = 3;     // the same-day renewal alert
const RENEWAL_LOOKAHEAD_DAYS = 7; // the weekly digest renewal section
const BILLS_LOOKAHEAD_DAYS = 7;   // "vendor bills due this week"
const STATUTORY_WARN_DAYS = 5;    // flag GST/TDS when the date is this close
const GST_DUE_DOM = 20;           // GST payable by the 20th of the next month
const TDS_DUE_DOM = 7;            // TDS deposited by the 7th of the next month
// A bill records no due date of its own (see EV.bill in finance-events.js) —
// the vendor payment terms are the only thing that says when it is payable.
// Honour an explicit date if one is ever written, else bill date + terms.
const DEFAULT_VENDOR_TERMS_DAYS = 30;

// ── IST ────────────────────────────────────────────────────────────────
// Vercel functions run in UTC; every reader and every statutory due date here
// is Indian, so "what day is it" must be answered in IST. IST has no DST, so
// a fixed offset is exact: shift the clock, then read it with the UTC getters.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86400000;

function istToday(ts = Date.now()) {
  const shifted = new Date(ts + IST_OFFSET_MS);
  const iso = shifted.toISOString().slice(0, 10);
  return { iso, month: iso.slice(0, 7), dow: shifted.getUTCDay(), dom: shifted.getUTCDate() };
}

// Ledger dates are plain 'YYYY-MM-DD' strings, so all date maths runs on UTC
// midnights — no timezone can shift a day boundary underneath it.
const isoOf = ms => new Date(ms).toISOString().slice(0, 10);
function msOf(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}
const addDaysIso = (iso, n) => isoOf(msOf(iso) + n * DAY_MS);
const daysBetween = (fromIso, toIso) => Math.round((msOf(toIso) - msOf(fromIso)) / DAY_MS);
function endOfMonthIso(month) {
  const [y, m] = String(month).split('-').map(Number);
  return isoOf(Date.UTC(y, m, 0)); // day 0 of the next month = last day of this one
}
// Format an ISO day without letting the server timezone move it.
const fmtDate = iso => iso
  ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
  : '—';

// ── Loading the book ───────────────────────────────────────────────────
const SUBCOLLECTIONS = ['txns', 'parties', 'deals', 'subscriptions', 'loans', 'assets', 'invoices', 'monthEnds'];

async function loadFinanceState(db) {
  const root = db.doc(FINANCE_ROOT);
  const [settingsSnap, ...snaps] = await Promise.all([
    root.get(),
    ...SUBCOLLECTIONS.map(c => root.collection(c).get()),
  ]);
  const docsOf = name => snaps[SUBCOLLECTIONS.indexOf(name)].docs.map(d => ({ id: d.id, ...d.data() }));

  const base = blank();
  const settings = { ...base.settings, ...(settingsSnap.exists ? settingsSnap.data() : {}) };
  // monthEnds is a map keyed by 'YYYY-MM', not a list — that is finance-core's
  // blank() shape and exactly what "has last month been closed?" looks up.
  const monthEnds = {};
  for (const m of docsOf('monthEnds')) monthEnds[m.id] = m;

  const state = {
    ...base,
    settings,
    monthEnds,
    // A txn with no date or no lines would break every derived figure; drop it
    // here rather than let one malformed doc take the whole digest down.
    txns: docsOf('txns').filter(t => t && t.date && Array.isArray(t.lines)),
    parties: docsOf('parties'),
    deals: docsOf('deals'),
    subs: docsOf('subscriptions'),
    loans: docsOf('loans'),
    assets: docsOf('assets'),
    invoices: docsOf('invoices'),
  };
  // finance-core holds ONE module-level state. Everything derived from it is
  // therefore computed synchronously in buildReports() immediately after this
  // call and before the first await, so a warm instance serving a second
  // request cannot swap the books out from under a half-rendered email.
  setState(state);
  return state;
}

const nameMapOf = state => new Map(state.parties.map(p => [p.id, p.name || p.id]));

function recipientsOf(settings) {
  const ed = (settings && settings.emailDigest) || {};
  if (ed.enabled === false) return [];
  return (Array.isArray(ed.to) ? ed.to : []).map(x => String(x || '').trim()).filter(Boolean);
}

// ── Sections ───────────────────────────────────────────────────────────

// Clients owing us for longer than CLIENT_OVERDUE_DAYS. "Days" counts from the
// oldest still-open receivable (the invoice txn that first put them in debt),
// because a payment against 1100 names the party but not which invoice it
// clears — so the oldest open date is the honest answer to "since when".
function overdueClients(state, names, todayIso) {
  const balances = partyBalances('1100', { upto: todayIso });
  const oldest = {};
  for (const t of state.txns) {
    if (t.date > todayIso) continue;
    for (const l of t.lines) {
      if (l.acc !== '1100' || !l.party || !(num(l.dr) > 0)) continue;
      if (!oldest[l.party] || t.date < oldest[l.party]) oldest[l.party] = t.date;
    }
  }
  return Object.entries(balances)
    .filter(([pid, amt]) => amt > 0.5 && oldest[pid])
    .map(([pid, amt]) => ({
      party: names.get(pid) || pid,
      amount: amt,
      since: oldest[pid],
      days: daysBetween(oldest[pid], todayIso),
    }))
    .filter(r => r.days > CLIENT_OVERDUE_DAYS)
    .sort((a, b) => b.days - a.days);
}

function billDueDate(txn, termsDays) {
  const explicit = txn.dueDate || (txn.meta && txn.meta.dueDate) || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(explicit))) return String(explicit);
  return addDaysIso(txn.date, termsDays);
}

// Vendor bills still open and payable on or before throughIso. Anything
// already past due is included too — it does not stop being this week's work.
function vendorBillsDue(state, names, todayIso, throughIso) {
  const termsDays = num(state.settings.vendorTermsDays) || DEFAULT_VENDOR_TERMS_DAYS;
  const outstanding = partyBalances('2000', { upto: todayIso });
  const byParty = new Map();
  for (const t of state.txns) {
    if (t.date > todayIso) continue;
    for (const l of t.lines) {
      if (l.acc !== '2000' || !l.party || !(num(l.cr) > 0)) continue;
      if (!byParty.has(l.party)) byParty.set(l.party, []);
      byParty.get(l.party).push({ date: t.date, amount: num(l.cr), desc: t.desc || '', due: billDueDate(t, termsDays) });
    }
  }
  const rows = [];
  for (const [pid, bills] of byParty) {
    // EV.paybill debits 2000 for the vendor without naming a bill, so there is
    // no per-bill open flag in the data. Allocate what has already been paid
    // oldest-first — the usual FIFO assumption — and treat the unallocated
    // remainder as still open.
    bills.sort((a, b) => a.date.localeCompare(b.date));
    let paid = bills.reduce((s, b) => s + b.amount, 0) - Math.max(num(outstanding[pid]), 0);
    for (const b of bills) {
      const applied = Math.min(Math.max(paid, 0), b.amount);
      paid -= applied;
      const open = b.amount - applied;
      if (open <= 0.5 || b.due > throughIso) continue;
      rows.push({ party: names.get(pid) || pid, desc: b.desc, billed: b.date, due: b.due, amount: open, overdue: b.due < todayIso });
    }
  }
  return rows.sort((a, b) => a.due.localeCompare(b.due));
}

// A subscription end is written as a month ('YYYY-MM', see EV.subnew), so the
// renewal lands on the last day of that month. A full date is honoured as
// written, in case a later version starts storing one.
function renewalDateOf(s) {
  const e = String(s.end || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(e)) return e;
  if (/^\d{4}-\d{2}$/.test(e)) return endOfMonthIso(e);
  return null;
}

const LIVE_SUB_STATUSES = ['active', 'paused'];

function renewingSubs(state, todayIso, matchDays) {
  return state.subs
    .filter(s => LIVE_SUB_STATUSES.includes(s.status))
    .map(s => ({ s, on: renewalDateOf(s) }))
    .filter(x => x.on)
    .map(({ s, on }) => ({
      name: s.name || 'Service',
      vendor: s.vendor || '',
      on,
      days: daysBetween(todayIso, on),
      monthly: num(s.monthly),
      payMode: s.payMode || 'monthly',
      unused: s.payMode === 'upfront' && !s.closedOut ? prepaidLeft(s) : 0,
    }))
    .filter(r => matchDays(r.days))
    .sort((a, b) => a.days - b.days);
}

// Pay-monthly services with no confirmed charge recorded for this month yet.
// EV.confirmcharge writes charges['YYYY-MM'] for a skipped month too, so a
// deliberate skip does not keep nagging.
function unconfirmedCharges(state, month) {
  return state.subs
    .filter(s => (s.payMode || 'monthly') === 'monthly' && s.status === 'active')
    .filter(s => !s.start || s.start <= month)
    .filter(s => !((s.charges || {})[month]))
    .map(s => ({ name: s.name || 'Service', vendor: s.vendor || '', expected: num(s.monthly) }))
    .sort((a, b) => b.expected - a.expected);
}

// GST for a month is payable by the 20th of the next and TDS by the 7th, so
// the running balance next falls due on this month's date if it has not
// passed, otherwise next month's.
function statutoryDue(label, dom, amount, todayIso) {
  const dd = String(dom).padStart(2, '0');
  const month = todayIso.slice(0, 7);
  const thisMonths = `${month}-${dd}`;
  const on = thisMonths >= todayIso ? thisMonths : `${addMonths(month, 1)}-${dd}`;
  const days = daysBetween(todayIso, on);
  return { label, amount, on, days, soon: amount > 0.5 && days <= STATUTORY_WARN_DAYS };
}

function closeStatus(state, month) {
  const me = state.monthEnds[month] || null;
  // The reconciled flag is written onto monthEnds/{month} by the bank import
  // (Phase 5) — no doc at all means neither has happened.
  return { month, label: mlabel(month), ran: !!me, reconciled: !!(me && me.reconciled) };
}

// ── HTML / text building blocks (inline CSS, single column, ≤640px) ─────
const TD = 'padding:6px 8px;border-bottom:1px solid #eee;';
const TH = 'padding:4px 8px;';
const HEAD_ROW = 'text-align:left;color:#888;font-size:11px;text-transform:uppercase;';
const CARD = 'background:#fff;border:1px solid #eee;border-radius:10px;padding:14px 16px;';
const MUTED = 'font-family:sans-serif;color:#888;font-size:13px;';

// Cells arrive already escaped (esc()) or as fmt() output, which is digits.
function table(headers, rows, emptyText) {
  if (!rows.length) return `<p style="${MUTED}">${esc(emptyText || 'Nothing to report.')}</p>`;
  return `<div style="overflow-x:auto;"><table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;">
    <tr style="${HEAD_ROW}">${headers.map(h => `<th style="${TH}">${esc(h)}</th>`).join('')}</tr>
    ${rows.map(r => `<tr>${r.map((c, i) => `<td style="${TD}${i === 0 ? 'font-weight:600;' : ''}">${c}</td>`).join('')}</tr>`).join('')}
  </table></div>`;
}

function section(title, bodyHtml, headline) {
  return `<div style="margin:22px 0 8px;">
    <h3 style="margin:0 0 4px;font-family:sans-serif;color:#0A0A0A;font-size:16px;">${esc(title)}</h3>
    ${headline ? `<div style="font-size:20px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px;">${headline}</div>` : ''}
    ${bodyHtml}
  </div>`;
}

function statCards(stats) {
  return `<div style="display:table;width:100%;border-collapse:collapse;margin-bottom:16px;">` +
    Array.from({ length: Math.ceil(stats.length / 2) }, (_, row) => `
      <div style="display:table-row;">
        ${stats.slice(row * 2, row * 2 + 2).map(([label, val]) => `
          <div style="display:table-cell;width:50%;padding:6px;">
            <div style="${CARD}">
              <div style="font-size:22px;font-weight:700;letter-spacing:-.02em;">${val}</div>
              <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
            </div>
          </div>`).join('')}
      </div>`).join('') + `</div>`;
}

// Same masthead as the CRM digests, so finance mail reads as a sibling of the
// follow-up digest and the EOD dashboard summary rather than a stranger.
function shell(kicker, bodyHtml, footNote) {
  return `<div style="max-width:640px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;color:#1C1917;">
    <div style="text-align:center;padding:10px 0 20px;border-bottom:3px solid #FE8D00;margin-bottom:18px;">
      <div style="font-size:22px;font-weight:700;letter-spacing:-.03em;color:#0A0A0A;">3 PIN Realty</div>
      <div style="font-size:11px;color:#A85C00;font-weight:700;text-transform:uppercase;letter-spacing:.12em;margin-top:4px;">${esc(kicker)}</div>
    </div>
    ${bodyHtml}
    <p style="text-align:center;color:#aaa;font-size:11px;margin-top:24px;">${esc(footNote)}</p>
  </div>`;
}

// ── Weekly digest ──────────────────────────────────────────────────────
function buildWeekly(state, names, ist) {
  const todayIso = ist.iso;
  const cash = cashPosition(todayIso);
  const lastMonth = addMonths(ist.month, -1);
  const w = {
    cash,
    gstPayable: bal('2200', { upto: todayIso }),
    gstInput: bal('1400', { upto: todayIso }),
    overdue: overdueClients(state, names, todayIso),
    bills: vendorBillsDue(state, names, todayIso, addDaysIso(todayIso, BILLS_LOOKAHEAD_DAYS)),
    renewals: renewingSubs(state, todayIso, d => d >= 0 && d <= RENEWAL_LOOKAHEAD_DAYS),
    unconfirmed: unconfirmedCharges(state, ist.month),
    runRate: serviceRunRate(),
    gst: statutoryDue('GST', GST_DUE_DOM, cash.gstDue, todayIso),
    tds: statutoryDue('TDS', TDS_DUE_DOM, cash.tdsDue, todayIso),
    close: closeStatus(state, lastMonth),
  };

  const flag = s => s.soon ? ' ⚠️' : '';
  const yn = ok => ok ? '✅ Yes' : '❌ No';

  const body = [
    statCards([
      ['Bank', fmt(w.cash.bank)],
      ['Petty cash', fmt(w.cash.petty)],
      ['Card owed', fmt(w.cash.card)],
      ['Free to use', fmt(w.cash.free)],
    ]),
    section('💰 Cash position', table(['Line', 'Amount'], [
      [esc('Bank'), fmt(w.cash.bank)],
      [esc('Petty cash'), fmt(w.cash.petty)],
      [esc('Credit card owed'), fmt(w.cash.card)],
      [esc('Vendor dues'), fmt(w.cash.vendorDues)],
      [esc('Client tokens held'), fmt(w.cash.tokens)],
      [esc('Free to use (cash − card − vendor dues − tokens)'), `<b>${fmt(w.cash.free)}</b>`],
      [esc('Clients owe you'), fmt(w.cash.receivable)],
      [esc('Loans outstanding'), fmt(w.cash.loans)],
    ])),
    section(`⏳ Clients overdue more than ${CLIENT_OVERDUE_DAYS} days`,
      table(['Client', 'Amount', 'Days', 'Owed since'],
        w.overdue.map(r => [esc(r.party), fmt(r.amount), String(r.days), esc(fmtDate(r.since))]),
        'No client is more than 14 days late.'),
      w.overdue.length ? fmt(w.overdue.reduce((s, r) => s + r.amount, 0)) : null),
    section('🧾 Vendor bills due this week',
      table(['Vendor', 'What for', 'Billed', 'Due', 'Open'],
        w.bills.map(r => [esc(r.party), esc(r.desc || '—'), esc(fmtDate(r.billed)), esc(fmtDate(r.due)) + (r.overdue ? ' ⚠️' : ''), fmt(r.amount)]),
        'No vendor bill falls due this week.'),
      w.bills.length ? fmt(w.bills.reduce((s, r) => s + r.amount, 0)) : null),
    section(`🔁 Services renewing in the next ${RENEWAL_LOOKAHEAD_DAYS} days`,
      table(['Service', 'Vendor', 'Renews', 'In', 'Monthly'],
        w.renewals.map(r => [esc(r.name), esc(r.vendor || '—'), esc(fmtDate(r.on)), r.days === 0 ? 'today' : `${r.days}d`, fmt(r.monthly)]),
        'Nothing renews in the next 7 days.')),
    section(`❓ Pay-monthly services not yet confirmed for ${mlabel(ist.month)}`,
      table(['Service', 'Vendor', 'Expected'],
        w.unconfirmed.map(r => [esc(r.name), esc(r.vendor || '—'), fmt(r.expected)]),
        'Every monthly service is confirmed for this month.')
      + `<p style="${MUTED}">Run-rate ${fmt(w.runRate.monthly)}/month across ${w.runRate.active.length} active services${w.runRate.prepaidUnused > 0.5 ? ` · ${fmt(w.runRate.prepaidUnused)} prepaid unused` : ''}.</p>`),
    section('🏛️ GST & TDS outstanding', table(['Head', 'Amount', 'Due by', 'In'], [
      [esc(`GST (payable ${fmt(w.gstPayable)} − input credit ${fmt(w.gstInput)})`) + flag(w.gst), fmt(w.gst.amount), esc(fmtDate(w.gst.on)), `${w.gst.days}d`],
      [esc('TDS payable') + flag(w.tds), fmt(w.tds.amount), esc(fmtDate(w.tds.on)), `${w.tds.days}d`],
    ]) + `<p style="${MUTED}">Standard dates: GST by the 20th, TDS by the 7th. Flagged when within ${STATUTORY_WARN_DAYS} days.</p>`),
    section(`📕 Books — ${esc(w.close.label)}`, table(['Check', 'Status'], [
      [esc('Month-end run'), yn(w.close.ran)],
      [esc('Bank reconciled'), yn(w.close.reconciled)],
    ])),
  ].join('');

  const lines = [
    `3 PIN Realty Finance — weekly digest — ${fmtDate(todayIso)}`, '',
    `Bank ${fmt(w.cash.bank)} | Petty ${fmt(w.cash.petty)} | Card owed ${fmt(w.cash.card)} | Free to use ${fmt(w.cash.free)}`,
    `Clients owe ${fmt(w.cash.receivable)} | Vendor dues ${fmt(w.cash.vendorDues)} | Tokens held ${fmt(w.cash.tokens)}`, '',
  ];
  const list = (title, rows, render, empty) => {
    lines.push(rows.length ? `${title} (${rows.length}):` : `${title}: ${empty}`);
    rows.forEach(r => lines.push(`- ${render(r)}`));
    lines.push('');
  };
  list(`CLIENTS OVERDUE >${CLIENT_OVERDUE_DAYS}d`, w.overdue, r => `${r.party} — ${fmt(r.amount)} — ${r.days} days (since ${fmtDate(r.since)})`, 'none');
  list('VENDOR BILLS DUE THIS WEEK', w.bills, r => `${r.party} — ${r.desc || '—'} — ${fmt(r.amount)} due ${fmtDate(r.due)}${r.overdue ? ' (OVERDUE)' : ''}`, 'none');
  list(`SERVICES RENEWING IN ${RENEWAL_LOOKAHEAD_DAYS}d`, w.renewals, r => `${r.name} — renews ${fmtDate(r.on)} (${r.days}d) — ${fmt(r.monthly)}/mo`, 'none');
  list(`NOT CONFIRMED FOR ${mlabel(ist.month)}`, w.unconfirmed, r => `${r.name} — expected ${fmt(r.expected)}`, 'all confirmed');
  lines.push(`GST outstanding ${fmt(w.gst.amount)} due ${fmtDate(w.gst.on)} (${w.gst.days}d)${w.gst.soon ? ' — DUE SOON' : ''}`);
  lines.push(`TDS outstanding ${fmt(w.tds.amount)} due ${fmtDate(w.tds.on)} (${w.tds.days}d)${w.tds.soon ? ' — DUE SOON' : ''}`);
  lines.push('');
  lines.push(`${w.close.label}: month-end ${w.close.ran ? 'run' : 'NOT run'}, ${w.close.reconciled ? 'reconciled' : 'NOT reconciled'}.`);

  return {
    kind: 'weekly',
    subject: `3 PIN Realty Finance — Weekly digest — ${fmtDate(todayIso)}`,
    text: lines.join('\n').trim(),
    html: shell(`Weekly digest — ${fmtDate(todayIso)}`, body, `Generated 08:00 IST · figures derived from the ledger, never typed twice`),
    counts: {
      overdueClients: w.overdue.length, billsDue: w.bills.length,
      renewals: w.renewals.length, unconfirmed: w.unconfirmed.length,
      monthEndRun: w.close.ran, reconciled: w.close.reconciled,
    },
  };
}

// ── Renewal alert (any day) ────────────────────────────────────────────
function buildRenewals(state, ist) {
  const due = renewingSubs(state, ist.iso, d => d === RENEWAL_ALERT_DAYS);
  if (!due.length) return null;

  const body = section(`🔔 Renewing in ${RENEWAL_ALERT_DAYS} days`,
    table(['Service', 'Vendor', 'Renews', 'Plan', 'Amount'],
      due.map(r => [
        esc(r.name), esc(r.vendor || '—'), esc(fmtDate(r.on)),
        esc(r.payMode === 'upfront' ? 'Paid upfront' : 'Charged monthly'),
        fmt(r.payMode === 'upfront' ? r.unused : r.monthly),
      ]))
    + `<p style="${MUTED}">Cancel before the renewal date if it is no longer needed — for an upfront plan the figure shown is the prepaid balance still unused.</p>`);

  const text = [`Renewing in ${RENEWAL_ALERT_DAYS} days:`, '']
    .concat(due.map(r => `- ${r.name}${r.vendor ? ` (${r.vendor})` : ''} renews ${fmtDate(r.on)} — ${fmt(r.payMode === 'upfront' ? r.unused : r.monthly)}`))
    .join('\n');

  return {
    kind: 'renewals',
    subject: `3 PIN Realty Finance — ${due.length} service${due.length > 1 ? 's' : ''} renewing in ${RENEWAL_ALERT_DAYS} days`,
    text,
    html: shell(`Renewal alert — ${fmtDate(ist.iso)}`, body, 'Sent once, three days before the renewal date'),
    counts: { renewals: due.length },
  };
}

// ── Monthly P&L + journal CSV ──────────────────────────────────────────
const csvCell = v => {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function journalCsv(journal, names) {
  const header = ['Date', 'Txn ID', 'Event', 'Description', 'Account', 'Account name', 'Debit', 'Credit', 'Party', 'Deal'];
  const rows = [header.join(',')];
  for (const t of journal) {
    for (const l of t.lines) {
      rows.push([
        t.date, t.id, t.event || '', t.desc || '',
        l.acc, (A[l.acc] || {}).name || '',
        num(l.dr) || '', num(l.cr) || '',
        l.party ? (names.get(l.party) || l.party) : '', l.deal || '',
      ].map(csvCell).join(','));
    }
  }
  // BOM + CRLF so Excel opens Indian party names correctly on a double-click.
  return '﻿' + rows.join('\r\n');
}

function buildMonthly(state, names, ist) {
  const month = addMonths(ist.month, -1);
  const journal = state.txns
    .filter(t => ym(t.date) === month)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  // A month with no entries has no story to tell — and a P&L of all zeroes is
  // exactly the kind of mail that teaches people to stop opening these.
  if (!journal.length) return null;

  const p = pl(month);
  const rowsOf = map => Object.entries(map)
    .filter(([, amt]) => Math.abs(amt) > 0.5)
    .map(([code, amt]) => [esc((A[code] || {}).name || code), fmt(amt)])
    .sort((a, b) => a[0].localeCompare(b[0]));

  const close = closeStatus(state, month);
  const body = [
    statCards([
      ['Income', fmt(p.ti)],
      ['Expenses', fmt(p.te)],
      ['Profit', fmt(p.profit)],
      ['Journal entries', String(journal.length)],
    ]),
    section('📈 Income', table(['Account', 'Amount'], rowsOf(p.inc), 'No income recorded.')),
    section('📉 Expenses', table(['Account', 'Amount'], rowsOf(p.exp), 'No expenses recorded.')),
    section('🧮 Result', table(['Line', 'Amount'], [
      [esc('Total income'), fmt(p.ti)],
      [esc('Total expenses'), fmt(p.te)],
      [esc(p.profit >= 0 ? 'Profit' : 'Loss'), `<b>${fmt(p.profit)}</b>`],
    ])),
    section('📕 Books', table(['Check', 'Status'], [
      [esc('Month-end run'), close.ran ? '✅ Yes' : '❌ No'],
      [esc('Bank reconciled'), close.reconciled ? '✅ Yes' : '❌ No'],
    ]) + `<p style="${MUTED}">The full journal for the month is attached as CSV.</p>`),
  ].join('');

  const text = [
    `3 PIN Realty Finance — P&L for ${mlabel(month)}`, '',
    `Income   ${fmt(p.ti)}`,
    `Expenses ${fmt(p.te)}`,
    `${p.profit >= 0 ? 'Profit' : 'Loss'}   ${fmt(p.profit)}`, '',
    `${journal.length} journal entries. Month-end ${close.ran ? 'run' : 'NOT run'}, ${close.reconciled ? 'reconciled' : 'NOT reconciled'}.`,
    'The full journal is attached as CSV.',
  ].join('\n');

  return {
    kind: 'monthly',
    subject: `3 PIN Realty Finance — P&L ${mlabel(month)}`,
    text,
    html: shell(`Monthly P&L — ${mlabel(month)}`, body, `Covers ${month} in full · attached CSV is the complete journal`),
    attachments: [{
      filename: `3pin-journal-${month}.csv`,
      content: journalCsv(journal, names),
      contentType: 'text/csv',
    }],
    counts: { txns: journal.length, profit: Math.round(p.profit) },
  };
}

// ── Which reports are due on this run ──────────────────────────────────
function decideKinds(ist, force) {
  if (force) return [force];
  const kinds = [];
  if (ist.dow === 1) kinds.push('weekly');   // Monday IST
  kinds.push('renewals');                    // every day; yields nothing unless one is 3 days out
  if (ist.dom === 2) kinds.push('monthly');  // the 2nd IST, for the month just ended
  return kinds;
}

function buildReport(kind, state, names, ist) {
  if (kind === 'weekly') return buildWeekly(state, names, ist);
  if (kind === 'renewals') return buildRenewals(state, ist);
  if (kind === 'monthly') return buildMonthly(state, names, ist);
  return null;
}

async function runFinanceDigest(db, opts) {
  const { source, force = null, respectAlreadySent = false } = opts || {};
  const ist = istToday();
  const state = await loadFinanceState(db);
  const names = nameMapOf(state);
  const settings = state.settings;
  const sentDates = (settings.digestSentDates && typeof settings.digestSentDates === 'object') ? settings.digestSentDates : {};

  let kinds = decideKinds(ist, force);
  const skipped = [];
  if (respectAlreadySent) {
    kinds = kinds.filter(k => {
      if (sentDates[k] === ist.iso) { skipped.push({ kind: k, reason: 'already-sent-today' }); return false; }
      return true;
    });
  }

  const to = recipientsOf(settings);
  if (!to.length) {
    return { ranAt: Date.now(), date: ist.iso, source, due: kinds, sent: [], skipped, note: 'emailDigest disabled or no recipients — nothing sent' };
  }

  // Every figure is derived here, synchronously, straight after loadFinanceState
  // set finance-core's module state — see the note there. Nothing below this
  // line reads the ledger again.
  const reports = kinds.map(k => buildReport(k, state, names, ist)).filter(Boolean);
  kinds.forEach(k => { if (!reports.some(r => r.kind === k)) skipped.push({ kind: k, reason: 'nothing-to-report' }); });

  if (!reports.length) {
    return { ranAt: Date.now(), date: ist.iso, source, due: kinds, sent: [], skipped, note: 'nothing to report — no email sent' };
  }

  const sent = [];
  for (const r of reports) {
    for (const addr of to) {
      const res = await sendEmail(addr, r.subject, r.text, r.html, r.attachments);
      sent.push({ kind: r.kind, to: addr, ...res });
    }
  }

  // Mark the day AFTER a successful send, per report kind, so a failed run can
  // be retried by a later trigger the same day while a success blocks a
  // duplicate — the same rule followup-digest.js and dashboard-summary.js use.
  // A manual/forced send deliberately records nothing: it must neither
  // suppress the cron nor be suppressed by it.
  if (source === 'cron') {
    const dates = {};
    for (const r of reports) {
      if (sent.some(s => s.kind === r.kind && s.ok)) dates[r.kind] = ist.iso;
    }
    if (Object.keys(dates).length) {
      await db.doc(FINANCE_ROOT).set({ digestSentDates: dates }, { merge: true }).catch(() => {});
    }
  }
  await db.doc(FINANCE_ROOT).set({
    lastDigestRun: { at: Date.now(), source, date: ist.iso, kinds: reports.map(r => r.kind), results: sent },
  }, { merge: true }).catch(() => {});

  return {
    ranAt: Date.now(), date: ist.iso, source,
    due: kinds, skipped,
    sent,
    reports: reports.map(r => ({ kind: r.kind, subject: r.subject, counts: r.counts })),
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Triggered by Vercel Cron (see vercel.json) at 02:30 UTC = 08:00 IST daily.
export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  try {
    const db = getDb();
    return json(await runFinanceDigest(db, { source: 'cron', respectAlreadySent: true }));
  } catch (e) {
    console.error('finance-digest: run failed:', e);
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

// Manual "Send now" from the finance page. ?force=weekly|monthly|renewals runs
// one report on demand whatever day it is, so each can be tested end to end.
export async function POST(request) {
  try {
    const user = await verifyCrmUser(request);
    if (!user || user.tenantId !== TENANT_ID) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const force = new URL(request.url).searchParams.get('force');
    if (force && !KINDS.includes(force)) {
      return json({ error: `force must be one of ${KINDS.join('|')}` }, 400);
    }
    const db = getDb();
    return json(await runFinanceDigest(db, { source: 'manual', force, respectAlreadySent: false }));
  } catch (e) {
    console.error('finance-digest: manual run failed:', e);
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
