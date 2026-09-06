// ═══════ BANK & CARD RECONCILIATION ═══════
//
// The bank statement is the only external check on the books. Reconciling is not extra work:
// it is the one thing that proves the numbers are right. The rule the whole view is built
// around is "the statement is the truth; the books must mirror it line for line".
//
// Flow: pick an account -> upload CSV/XLSX -> confirm the column mapping (remembered per
// account afterwards) -> auto-match -> work through what is left.

import {
  fmt, esc, num, today, ym, mlabel, getState, bal, pname,
} from './finance-core.js';
import { stat, signed, empty, note, tag, table, toast, confirmDialog } from './ui.js';
import * as B from './finance-bank.js';
import * as SY from './finance-sync.js';

// Wizard state. Deliberately module-level and reset on leaving: a half-finished import is
// never worth restoring, and stale parsed rows would be dangerous to reconcile against.
let stage = 'list';
let account = '1000';
let parsed = null;
let mapping = null;
let rows = [];
let fileName = '';
let closingBalance = 0;
let activeStatementId = null;

const st = () => getState();

const accountName = code => code === '2300' ? 'Credit card' : (
  st().settings.bankAccounts?.find(a => a.id === code)?.name || 'Bank');

function accountOptions() {
  const banks = (st().settings.bankAccounts || []).map(a => [a.id || '1000', a.name + (a.last4 ? ' ••••' + a.last4 : '')]);
  return [...(banks.length ? banks : [['1000', 'Bank']]), ['2300', 'Credit card']];
}

// ═══════ ENTRY POINT ═══════

export function renderBank() {
  if (stage === 'map') return renderMapping();
  if (stage === 'reconcile') return renderReconcile();
  return renderList();
}

// ═══════ 1. IMPORT ═══════

function renderList() {
  const s = st();
  const past = [...s.bankStatements].sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));

  return `
    <h1>Bank</h1>
    <p class="lead">Import the month's statement and make sure every line on it exists in your books,
    and nothing in your books is missing from it.</p>

    ${note('Download the statement from your bank as CSV or Excel. The first time you import from an account you confirm which column is which; after that it is one tap.', 'info')}

    <div class="card">
      <h3>Import a statement</h3>
      <div class="field">
        <label for="bankAcc">Account</label>
        <select id="bankAcc" onchange="finBank.setAccount(this.value)">
          ${accountOptions().map(([v, l]) =>
      `<option value="${esc(v)}" ${v === account ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
      </div>
      <label class="btn primary" style="cursor:pointer">
        Choose file
        <input type="file" id="stmtFile" accept=".csv,.tsv,.txt,.xlsx" hidden>
      </label>
      <span class="small faint" style="margin-left:10px">CSV or XLSX</span>
    </div>

    ${past.length ? `
      <h2>Previously imported</h2>
      ${table(
      `<th>Account</th><th>File</th><th>Imported</th><th class="n">Rows</th><th class="n">Unmatched</th><th></th>`,
      past.map(x => {
        const un = (x.rows || []).filter(r => r.status === 'unmatched').length;
        return `<tr>
            <td>${esc(accountName(x.account))}</td>
            <td class="small">${esc(x.fileName || '—')}</td>
            <td class="small nowrap">${x.importedAt ? new Date(x.importedAt).toLocaleDateString('en-IN') : '—'}</td>
            <td class="n">${(x.rows || []).length}</td>
            <td class="n">${un ? `<span class="neg">${un}</span>` : '<span class="pos">0</span>'}</td>
            <td class="n"><button class="btn ghost sm" type="button" onclick="finBank.reopen('${esc(x.id)}')">Open</button></td>
          </tr>`;
      }).join(''))}` : ''}`;
}

export function mountBank() {
  const input = document.getElementById('stmtFile');
  if (input) {
    input.onchange = async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      await loadFile(file);
    };
  }
  const cb = document.getElementById('closingBal');
  if (cb) cb.oninput = () => { closingBalance = num(cb.value); refreshHeader(); };
}

async function loadFile(file) {
  fileName = file.name;
  toast('Reading ' + file.name + '…');
  try {
    if (/\.xlsx$/i.test(file.name)) {
      parsed = await B.parseWorkbook(await file.arrayBuffer());
    } else {
      parsed = B.parseDelimited(await file.text());
    }
  } catch (e) {
    toast(e.message || 'Could not read that file');
    return;
  }
  if (!parsed.rows.length) { toast('That file has no data rows'); return; }

  // A mapping confirmed once for this account is reused, so the routine monthly import is a
  // single tap rather than the same six dropdowns every time.
  const saved = st().settings.columnMappings?.[account];
  mapping = saved || B.detectMapping(parsed.headers, parsed.rows);
  stage = 'map';
  window.fin.repaint();
}

// ═══════ 2. COLUMN MAPPING ═══════

function renderMapping() {
  const cols = parsed.headers.map((h, i) => [String(i), h || `Column ${i + 1}`]);
  const sel = (key, label) => `
    <div class="field">
      <label for="map_${key}">${esc(label)}</label>
      <select id="map_${key}" onchange="finBank.setMap('${key}',this.value)">
        <option value="">— none —</option>
        ${cols.map(([v, l]) =>
    `<option value="${v}" ${String(mapping[key]) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
    </div>`;

  const preview = parsed.rows.slice(0, 5);

  return `
    <div class="actions"><button class="btn ghost sm" type="button" onclick="finBank.cancel()">← Back</button></div>
    <h1>Which column is which?</h1>
    <p class="lead">${esc(fileName)} — ${parsed.rows.length} rows.
    ${mapping.confidence === 'high'
      ? 'Detected from the column headings; check it looks right.'
      : 'The headings were not recognisable, so these are guesses — please check each one.'}</p>

    <div class="card">
      <div class="row2">${sel('date', 'Date')}${sel('desc', 'Description')}</div>
      <div class="row2">${sel('debit', 'Money out (debit)')}${sel('credit', 'Money in (credit)')}</div>
      <div class="row2">${sel('balance', 'Balance')}${sel('amount', 'Single amount column')}</div>
      ${sel('drcr', 'Dr/Cr indicator (only if there is one amount column)')}
    </div>

    <h2>First five rows, as they will be read</h2>
    ${table(
      `<th>Date</th><th>Description</th><th class="n">Out</th><th class="n">In</th><th class="n">Balance</th>`,
      B.buildRows({ headers: parsed.headers, rows: preview }, mapping).map(r => `<tr>
          <td class="nowrap small">${esc(r.date)}</td>
          <td class="small">${esc(r.desc)}</td>
          <td class="n">${r.debit ? fmt(r.debit) : ''}</td>
          <td class="n">${r.credit ? fmt(r.credit) : ''}</td>
          <td class="n">${r.balance ? fmt(r.balance) : ''}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No row here parsed as a date — check the date column.</td></tr>')}

    <div class="actions">
      <button class="btn primary" type="button" onclick="finBank.confirmMapping()">Looks right — import</button>
      <button class="btn" type="button" onclick="finBank.cancel()">Cancel</button>
    </div>`;
}

// ═══════ 3. RECONCILE ═══════

function bookBalance() {
  const asOf = rows.map(r => r.date).sort().slice(-1)[0] || today();
  return bal(account, { upto: asOf });
}

function refreshHeader() {
  const el = document.getElementById('reconHead');
  if (el) el.innerHTML = headerStats();
}

function headerStats() {
  const book = bookBalance();
  const diff = num(closingBalance) - book;
  const unmatched = rows.filter(r => r.status === 'unmatched').length;
  const done = Math.abs(diff) < 1 && unmatched === 0;
  return `
    <div class="grid g3">
      ${stat('Statement closing', fmt(closingBalance))}
      ${stat('Your books say', fmt(book))}
      ${stat('Difference', fmt(diff), { cls: Math.abs(diff) < 1 ? 'pos' : 'neg', hero: true })}
      ${stat('Still unmatched', String(unmatched), { cls: unmatched ? 'neg' : 'pos' })}
    </div>
    ${done
      ? note('<b>Reconciled ✓</b> — the statement and the books agree, and nothing is left over. You can run month-end for this period.', 'info')
      : ''}`;
}

function renderReconcile() {
  const matched = rows.filter(r => r.status === 'matched');
  const unmatched = rows.filter(r => r.status === 'unmatched');
  const ignored = rows.filter(r => r.status === 'ignored');
  const from = rows.map(r => r.date).sort()[0];
  const upto = rows.map(r => r.date).sort().slice(-1)[0];
  const orphans = B.bookEntriesWithoutStatement(st().txns, rows, account, from, upto);
  const month = ym(upto || today());

  return `
    <div class="actions"><button class="btn ghost sm" type="button" onclick="finBank.cancel()">← Bank</button></div>
    <h1>Reconcile ${esc(accountName(account))}</h1>
    <p class="lead">${esc(fileName)} · ${rows.length} rows · ${esc(from || '')} to ${esc(upto || '')}</p>

    <div class="field" style="max-width:280px">
      <label for="closingBal">Statement closing balance</label>
      <input type="number" id="closingBal" inputmode="decimal" step="0.01" value="${closingBalance || ''}"
        placeholder="Type it off the statement">
    </div>

    <div id="reconHead">${headerStats()}</div>

    <div class="actions">
      <button class="btn primary" type="button" onclick="finBank.saveStatement('${esc(month)}')">Save reconciliation</button>
    </div>

    <h2>On the statement but not in your books <span class="muted">(${unmatched.length})</span></h2>
    ${unmatched.length ? `
      <p class="small muted">These are the ones to act on. Each is either something you forgot to record, or something that is not yours.</p>
      ${table(
      `<th>Date</th><th>Description</th><th class="n">Out</th><th class="n">In</th><th></th>`,
      unmatched.map(r => `<tr>
          <td class="nowrap small">${esc(r.date)}</td>
          <td class="small">${esc(r.desc)}</td>
          <td class="n">${r.debit ? fmt(r.debit) : ''}</td>
          <td class="n">${r.credit ? fmt(r.credit) : ''}</td>
          <td class="n nowrap">
            <button class="btn ghost sm" type="button" onclick="finBank.create('${esc(r.id)}')">Create entry</button>
            <button class="btn ghost sm" type="button" onclick="finBank.matchTo('${esc(r.id)}')">Match to…</button>
            <button class="btn ghost sm" type="button" onclick="finBank.ignore('${esc(r.id)}')">Ignore</button>
          </td></tr>`).join(''))}`
      : `<div class="card"><p class="pos" style="margin:0">Every statement line is accounted for.</p></div>`}

    <h2>In your books but not on the statement <span class="muted">(${orphans.length})</span></h2>
    ${orphans.length ? `
      <p class="small muted">Either it never actually went through — reverse it — or it will land on next month's statement, in which case leave it.</p>
      ${table(
        `<th>Date</th><th>Description</th><th class="n">Cash</th><th></th>`,
        orphans.map(t => `<tr>
          <td class="nowrap small">${esc(t.date)}</td>
          <td class="small">${esc(t.desc)}</td>
          <td class="n">${signed(t.lines.reduce((s, l) => l.acc === account ? s + num(l.dr) - num(l.cr) : s, 0))}</td>
          <td class="n nowrap">
            <button class="btn ghost sm" type="button" onclick="fin.openTxn('${esc(t.id)}')">Open</button>
            <button class="btn ghost sm" type="button" onclick="fin.reverse('${esc(t.id)}')">Reverse</button>
          </td></tr>`).join(''))}`
      : `<div class="card"><p class="pos" style="margin:0">Nothing in the books is missing from the statement.</p></div>`}

    <details class="journal" style="margin-top:18px">
      <summary>Matched automatically (${matched.length})${ignored.length ? ` · ignored (${ignored.length})` : ''}</summary>
      ${table(
        `<th>Date</th><th>Description</th><th class="n">Amount</th><th>Matched</th>`,
        [...matched, ...ignored].map(r => `<tr>
          <td class="nowrap small">${esc(r.date)}</td>
          <td class="small">${esc(r.desc)}</td>
          <td class="n">${fmt(r.debit || r.credit)}</td>
          <td class="small">${r.status === 'ignored'
          ? tag('ignored') + (r.ignoreReason ? ` <span class="faint">${esc(r.ignoreReason)}</span>` : '')
          : tag(r.confidence === 'exact' ? 'exact date' : '±3 days', r.confidence === 'exact' ? 'ok' : 'warn')}</td>
        </tr>`).join(''))}
    </details>`;
}

// ═══════ ACTIONS ═══════

if (typeof window !== 'undefined') {
  window.finBank = {
    setAccount(v) { account = v; },

    setMap(key, v) {
      mapping[key] = v === '' ? null : Number(v);
      window.fin.repaint();
    },

    confirmMapping() {
      rows = B.buildRows(parsed, mapping);
      if (!rows.length) { toast('No rows parsed — check the date column'); return; }
      const res = B.autoMatch(rows, st().txns, account);
      rows = res.rows;
      // The last balance on the statement is almost always the closing balance, so offer it
      // rather than making the user retype it — they can still correct it.
      closingBalance = rows.filter(r => r.balance).slice(-1)[0]?.balance || 0;
      stage = 'reconcile';
      SY.saveSettings({ [`columnMappings.${account}`]: mapping }).catch(() => { });
      // autoMatch returns the matched and unmatched ROWS, not counts.
      toast(`${res.matched.length} of ${rows.length} matched automatically`);
      window.fin.repaint();
    },

    cancel() {
      stage = 'list'; parsed = null; mapping = null; rows = []; activeStatementId = null;
      window.fin.repaint();
    },

    // Opens the Record screen with the date and amount already filled from the statement line,
    // so the only thing left to decide is what the payment actually was.
    create(rowId) {
      const r = rows.find(x => x.id === rowId);
      if (!r) return;
      const isOut = r.debit > 0;
      const amount = r.debit || r.credit;
      if (account === '2300') {
        window.fin.record(isOut ? 'expense' : 'vendorrefund',
          { date: r.date, amt: amount, via: '2300', desc: r.desc });
      } else {
        window.fin.record(isOut ? 'expense' : 'otherinc',
          { date: r.date, amt: amount, via: '1000', desc: r.desc });
      }
    },

    matchTo(rowId) {
      const r = rows.find(x => x.id === rowId);
      if (!r) return;
      const amount = r.debit || r.credit;
      // Offer the nearest candidates by amount first — an exact amount match is nearly always
      // the right entry even when the date is well off.
      const candidates = st().txns
        .filter(t => t.lines.some(l => l.acc === account))
        .filter(t => !rows.some(x => x.matchedTxnId === t.id))
        .map(t => ({
          t, gap: Math.abs(Math.abs(t.lines.reduce((s, l) =>
            l.acc === account ? s + num(l.dr) - num(l.cr) : s, 0)) - amount),
        }))
        .sort((a, b) => a.gap - b.gap)
        .slice(0, 15);

      window.fin.modal({
        title: 'Match to an existing entry',
        body: candidates.length ? `
          <p class="small muted">${esc(r.date)} · ${esc(r.desc)} · <b>${fmt(amount)}</b></p>
          <div class="tbl-wrap"><table><tbody>
          ${candidates.map(c => `<tr class="click" onclick="finBank.doMatch('${esc(rowId)}','${esc(c.t.id)}')">
              <td class="nowrap small">${esc(c.t.date)}</td>
              <td>${esc(c.t.desc)}</td>
              <td class="n">${fmt(Math.abs(c.t.lines.reduce((s, l) => l.acc === account ? s + num(l.dr) - num(l.cr) : s, 0)))}</td>
            </tr>`).join('')}
          </tbody></table></div>`
          : '<p>There is no unmatched entry on this account to match against.</p>',
      });
    },

    doMatch(rowId, txnId) {
      const r = rows.find(x => x.id === rowId);
      if (r) { r.matchedTxnId = txnId; r.status = 'matched'; r.confidence = 'manual'; }
      window.fin.closeModal();
      window.fin.repaint();
    },

    async ignore(rowId) {
      const r = rows.find(x => x.id === rowId);
      if (!r) return;
      const reason = prompt('Why is this being ignored?\n(e.g. bank interest already recorded, transfer between own accounts)');
      if (reason === null) return;
      r.status = 'ignored';
      r.ignoreReason = reason;
      window.fin.repaint();
    },

    async saveStatement(month) {
      const unmatched = rows.filter(r => r.status === 'unmatched').length;
      const diff = num(closingBalance) - bookBalance();
      const reconciled = Math.abs(diff) < 1 && unmatched === 0;

      if (!reconciled) {
        const ok = await confirmDialog({
          title: 'Save as not yet reconciled?',
          message: `There ${unmatched === 1 ? 'is' : 'are'} still <b>${unmatched}</b> unmatched line${unmatched === 1 ? '' : 's'} and a difference of <b>${fmt(diff)}</b>. You can save your progress and come back, but this month will not count as reconciled and month-end will warn you.`,
          confirmLabel: 'Save progress',
        });
        if (!ok) return;
      }

      try {
        const payload = {
          account, fileName, mapping, closingBalance: num(closingBalance),
          rows: rows.map(r => ({ ...r })), reconciled,
        };
        if (activeStatementId) await SY.updateBankStatement(activeStatementId, payload);
        else activeStatementId = await SY.saveBankStatement(payload);

        // The reconciled flag lives on the month-end record because that is what gates
        // month-end; the statement itself is just the evidence.
        if (reconciled) await SY.markReconciled(month, true).catch(() => { });
        toast(reconciled ? `Reconciled ✓ for ${mlabel(month)}` : 'Progress saved');
      } catch (e) {
        toast(e.message || 'Could not save');
      }
    },

    reopen(id) {
      const x = st().bankStatements.find(s => s.id === id);
      if (!x) return;
      account = x.account;
      fileName = x.fileName || '';
      mapping = x.mapping || null;
      rows = (x.rows || []).map(r => ({ ...r }));
      closingBalance = num(x.closingBalance);
      activeStatementId = x.id;
      stage = 'reconcile';
      window.fin.repaint();
    },
  };
}
