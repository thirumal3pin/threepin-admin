// ═══════ PROFILE, SETTINGS, OPENING BALANCES, GUIDE ═══════
//
// Profile is the company's identity and the things that are still missing — the details only
// the owner and their CA can supply. Settings is how the engine behaves. They are separate on
// purpose: Profile is filled in once and then rarely touched, Settings is tuning.

import {
  ACCOUNTS, A, EXP, fmt, esc, num, today, ym, addMonths, mlabel,
  getState, bal, schedule, fyOf,
} from './finance-core.js';
import { stat, empty, note, tag, table, toast, confirmDialog } from './ui.js';
import * as SY from './finance-sync.js';

const st = () => getState();

// Read every input in a container that carries a data-s path, and turn it into a settings
// patch. Dotted paths become nested objects so a whole sub-object can be edited in place.
function collect(containerId) {
  const patch = {};
  document.querySelectorAll(`#${containerId} [data-s]`).forEach(el => {
    const path = el.dataset.s;
    let value = el.type === 'checkbox' ? el.checked
      : el.type === 'number' ? num(el.value)
        : el.value;
    if (el.dataset.list === '1') {
      value = String(el.value).split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    }
    const keys = path.split('.');
    let node = patch;
    keys.slice(0, -1).forEach(k => { node = node[k] = node[k] || {}; });
    node[keys.at(-1)] = value;
  });
  return patch;
}

const field = (label, path, value, opts = {}) => `
  <div class="field">
    <label for="s_${path}">${esc(label)}</label>
    <input type="${opts.type || 'text'}" id="s_${path}" data-s="${esc(path)}"
      ${opts.list ? 'data-list="1"' : ''}
      value="${esc(value ?? '')}" ${opts.type === 'number' ? 'inputmode="decimal" step="any"' : ''}
      ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''}>
    ${opts.hint ? `<div class="hint">${opts.hint}</div>` : ''}
  </div>`;

// ═══════ PROFILE ═══════

// What has to be filled in before an invoice is legally complete or a reminder can be sent.
// Nothing here blocks the app — it just tells the truth about what is missing.
function gaps() {
  const s = st().settings;
  const list = [
    ['GSTIN', s.gstin, 'Printed on every invoice. Your CA has it.'],
    ['Registered address', s.address, 'The address on your GST registration.'],
    ['SAC code', s.sacCode, 'The service code for brokerage — 997221 is the usual one. Confirm with your CA.'],
    ['Bank account number', s.bankDetails?.accountNo, 'Printed on invoices so clients know where to pay.'],
    ['Bank IFSC', s.bankDetails?.ifsc, 'Goes next to the account number.'],
    ['Contact phone', s.phone, 'Shown on the invoice header.'],
    ['Digest recipients', (s.emailDigest?.to || []).length ? 'yes' : '', 'Where the Monday summary is emailed.'],
  ];
  return list.map(([label, value, why]) => ({ label, why, done: !!String(value || '').trim() }));
}

export function renderProfile() {
  const s = st().settings;
  const items = gaps();
  const missing = items.filter(i => !i.done);
  const pct = Math.round(((items.length - missing.length) / items.length) * 100);

  return `
    <h1>Profile</h1>
    <p class="lead">Who the company is, and everything still waiting to be filled in.
    Nothing here blocks you from recording — but invoices are incomplete until it is done.</p>

    <div class="card">
      <div style="display:flex;align-items:baseline;gap:10px">
        <h3 style="margin:0">Setup ${pct}% complete</h3>
        <div class="spacer"></div>
        <span class="small ${missing.length ? 'muted' : 'pos'}">
          ${missing.length ? `${missing.length} still to do` : 'All done ✓'}</span>
      </div>
      <div class="bar" style="margin:10px 0 14px" aria-label="${pct}% complete"><i style="width:${pct}%"></i></div>
      <ul class="checklist">
        ${items.map(i => `<li class="${i.done ? 'done' : 'todo'}">
          <span class="mark" aria-hidden="true">${i.done ? '✓' : '○'}</span>
          <span><b>${esc(i.label)}</b>${i.done ? '' : `<br><span class="small muted">${esc(i.why)}</span>`}</span>
        </li>`).join('')}
      </ul>
    </div>

    <form id="profileForm" onsubmit="return false">
      <h2>Company</h2>
      <div class="card">
        ${field('Registered name', 'companyName', s.companyName)}
        ${field('GSTIN', 'gstin', s.gstin, { placeholder: '33XXXXXXXXXXXZX', hint: 'Fifteen characters, starts with your state code (33 for Tamil Nadu).' })}
        <div class="field">
          <label for="s_address">Registered address</label>
          <textarea id="s_address" data-s="address" rows="3">${esc(s.address || '')}</textarea>
        </div>
        <div class="row2">
          ${field('State', 'state', s.state, { hint: 'Decides CGST+SGST vs IGST on invoices.' })}
          ${field('SAC code', 'sacCode', s.sacCode, { hint: '997221 is standard for brokerage.' })}
        </div>
        <div class="row2">
          ${field('Phone', 'phone', s.phone)}
          ${field('Email', 'email', s.email, { type: 'email' })}
        </div>
      </div>

      <h2>Bank details printed on invoices</h2>
      <div class="card">
        <div class="row2">
          ${field('Bank name', 'bankDetails.bankName', s.bankDetails?.bankName)}
          ${field('Account name', 'bankDetails.accountName', s.bankDetails?.accountName)}
        </div>
        <div class="row2">
          ${field('Account number', 'bankDetails.accountNo', s.bankDetails?.accountNo)}
          ${field('IFSC', 'bankDetails.ifsc', s.bankDetails?.ifsc)}
        </div>
        ${field('Branch', 'bankDetails.branch', s.bankDetails?.branch)}
      </div>

      <h2>Who gets the email digests</h2>
      <div class="card">
        ${field('Recipients', 'emailDigest.to', (s.emailDigest?.to || []).join(', '),
    { list: true, placeholder: 'you@example.com, ca@example.com', hint: 'Comma separated. A summary goes out on Monday mornings.' })}
      </div>

      <div class="actions">
        <button class="btn primary" type="button" onclick="finAdmin.saveProfile()">Save profile</button>
      </div>
    </form>

    ${note('Ask your CA to confirm: the GSTIN and registered address exactly as filed, the SAC code for brokerage, and that your opening balances are what they will accept.', 'info')}`;
}

export function mountProfile() { /* Inputs are read on save; nothing to wire up. */ }

// ═══════ SETTINGS ═══════

export function renderSettings() {
  const s = st().settings;
  return `
    <h1>Settings</h1>
    <p class="lead">How the engine behaves. Company details live on the
    <a href="#profile" onclick="fin.go('profile');return false">Profile tab</a>.</p>

    <form id="settingsForm" onsubmit="return false">
      <h2>Tax and periods</h2>
      <div class="card">
        <div class="row2">
          ${field('GST rate %', 'gstRate', s.gstRate, { type: 'number' })}
          ${field('Financial year starts in month', 'fyStartMonth', s.fyStartMonth, { type: 'number', hint: '4 = April.' })}
        </div>
        <div class="row2">
          ${field('Books start date', 'booksStartDate', s.booksStartDate, { type: 'date', hint: 'Entries before this date are rejected.' })}
          ${field('Capitalisation threshold', 'capitalisationThreshold', s.capitalisationThreshold, { type: 'number', hint: 'Above this, a purchase is an asset rather than an expense.' })}
        </div>
        <div class="field">
          <label><input type="checkbox" data-s="tdsEnabled" ${s.tdsEnabled ? 'checked' : ''} style="width:auto;min-height:0;margin-right:8px">
            Show TDS fields</label>
          <div class="hint">All the TDS logic is built and tested. Turn this on when your CA says to start deducting — nothing has to be rebuilt.</div>
        </div>
        <div class="row2">
          ${field('194H %', 'tdsRates.194H', s.tdsRates?.['194H'], { type: 'number' })}
          ${field('194J %', 'tdsRates.194J', s.tdsRates?.['194J'], { type: 'number' })}
        </div>
        <div class="row2">
          ${field('194I %', 'tdsRates.194I', s.tdsRates?.['194I'], { type: 'number' })}
          ${field('194C %', 'tdsRates.194C', s.tdsRates?.['194C'], { type: 'number' })}
        </div>
      </div>

      <h2>Invoicing</h2>
      <div class="card">
        <div class="row2">
          ${field('Invoice prefix', 'invoicePrefix', s.invoicePrefix)}
          ${field('Next invoice number', 'nextInvoiceNo', s.nextInvoiceNo, { type: 'number', hint: 'Change only if you are continuing a sequence from elsewhere.' })}
        </div>
      </div>

      <h2>Attachments</h2>
      <div class="card">
        <div class="field">
          <label for="s_attachmentBackend">Where bill photos and PDFs are stored</label>
          <select id="s_attachmentBackend" data-s="attachmentBackend">
            <option value="storage" ${s.attachmentBackend === 'storage' ? 'selected' : ''}>Firebase Storage</option>
            <option value="drive" ${s.attachmentBackend === 'drive' ? 'selected' : ''}>Google Drive</option>
          </select>
          <div class="hint">Storage needs to be enabled once in the Firebase console. If it is not, switch to Drive — that reuses the same service account the brochure system already uses.</div>
        </div>
      </div>

      <div class="actions">
        <button class="btn primary" type="button" onclick="finAdmin.saveSettings()">Save settings</button>
      </div>
    </form>

    ${bankAccountsSection(s)}
    ${partiesSection()}
    ${dangerSection(s)}`;
}

function bankAccountsSection(s) {
  const accs = s.bankAccounts || [];
  return `
    <h2>Bank accounts</h2>
    <p class="small muted">Statement imports and matching are per account.</p>
    ${accs.length ? table(
    `<th>Name</th><th>Last 4</th><th></th>`,
    accs.map((a, i) => `<tr>
        <td>${esc(a.name)}</td><td class="small faint">${esc(a.last4 || '—')}</td>
        <td class="n"><button class="btn ghost sm" type="button" onclick="finAdmin.removeBank(${i})">Remove</button></td>
      </tr>`).join(''))
      : empty('Only the default Bank account exists. Add another if you have one.')}
    <div class="actions">
      <button class="btn" type="button" onclick="finAdmin.addBank()">Add a bank account</button>
    </div>`;
}

function partiesSection() {
  const parties = [...st().parties].sort((a, b) => a.name.localeCompare(b.name));
  if (!parties.length) return '';

  // Same name twice is the usual cause: a party typed slightly differently on two entries.
  const byName = {};
  parties.forEach(p => {
    const k = p.name.trim().toLowerCase();
    (byName[k] = byName[k] || []).push(p);
  });
  const dupes = Object.values(byName).filter(g => g.length > 1);

  return `
    <h2>People and companies <span class="muted">(${parties.length})</span></h2>
    ${dupes.length ? note(`<b>${dupes.length} name${dupes.length === 1 ? ' appears' : 's appear'} more than once.</b>
      Merging rewrites every journal line onto the one you keep, then removes the duplicate.`) : ''}
    ${table(
    `<th>Name</th><th>Type</th><th>Phone</th><th class="n">They owe</th><th class="n">You owe</th><th></th>`,
    parties.map(p => `<tr>
        <td>${esc(p.name)}</td>
        <td class="small">${esc(p.type || '—')}</td>
        <td class="small">${esc(p.phone || '—')}</td>
        <td class="n">${fmt(bal('1100', { party: p.id }))}</td>
        <td class="n">${fmt(bal('2000', { party: p.id }))}</td>
        <td class="n"><button class="btn ghost sm" type="button" onclick="finAdmin.editParty('${esc(p.id)}')">Edit</button></td>
      </tr>`).join(''))}
    ${dupes.length ? `<div class="actions">
      ${dupes.map(g => `<button class="btn" type="button" onclick="finAdmin.merge('${esc(g[0].id)}','${esc(g[1].id)}')">Merge "${esc(g[0].name)}"</button>`).join('')}
    </div>` : ''}`;
}

function dangerSection(s) {
  return `
    <h2>Chart of accounts</h2>
    <p class="small muted">${ACCOUNTS.length} accounts. New income and expense categories can be added;
    the structural accounts cannot be changed because the engine posts to them by code.</p>
    <div class="actions">
      <button class="btn" type="button" onclick="finAdmin.addAccount()">Add a category</button>
      <button class="btn" type="button" onclick="fin.sync.seedFinance().then(()=>fin.toast('Chart checked'))">Re-check seed</button>
    </div>`;
}

export function mountSettings() { /* Inputs are read on save. */ }

// ═══════ OPENING BALANCES ═══════

// Used once, on the day the books start. Everything entered here is posted as ONE balanced
// journal against 3100 Opening balance equity — which is exactly what that account exists for.
export function renderOpening() {
  const s = st();
  if (s.settings.openingPosted) {
    return `
      <h1>Opening balances</h1>
      ${note('<b>Opening balances have already been posted.</b> This screen locks after it is used once, because posting a second set would double every balance. If something was wrong, find the opening entry on the Transactions tab and reverse it.')}
      <div class="actions"><button class="btn" type="button" onclick="fin.go('txns')">Find the opening entry</button></div>`;
  }

  const d = s.settings.booksStartDate || today();
  return `
    <h1>Opening balances</h1>
    <p class="lead">What the business already had on ${esc(d)} — the day the books start.
    Enter what you know; anything left over is treated as the owner's stake, so it always balances.</p>
    ${note('Do this once, with your CA if you can. Everything below posts as a single journal entry dated ' + esc(d) + '.', 'info')}

    <form id="openingForm" onsubmit="return false">
      <h2>What you had</h2>
      <div class="card">
        <div class="row2">
          ${field('Money in the bank', 'o.bank', '', { type: 'number' })}
          ${field('Petty cash in hand', 'o.petty', '', { type: 'number' })}
        </div>
        <div class="row2">
          ${field('Credit card outstanding', 'o.card', '', { type: 'number' })}
          ${field('Share capital already put in', 'o.capital', '', { type: 'number' })}
        </div>
        <div class="row2">
          ${field('Client advances you are holding', 'o.advances', '', { type: 'number' })}
          ${field('Vendor bills unpaid', 'o.vendors', '', { type: 'number' })}
        </div>
        ${field('Clients who still owe you', 'o.receivable', '', { type: 'number' })}
      </div>

      <h2>Existing loans</h2>
      <div class="card" id="openLoans">
        <p class="small muted">Add each loan you are still repaying. The schedule is worked out for you.</p>
        <div id="loanRows"></div>
        <button class="btn sm" type="button" onclick="finAdmin.addLoanRow()">Add a loan</button>
      </div>

      <h2>Existing assets</h2>
      <div class="card">
        <p class="small muted">Laptops, cameras, furniture you already own. Depreciation already
        run down to today is worked out from the purchase date.</p>
        <div id="assetRows"></div>
        <button class="btn sm" type="button" onclick="finAdmin.addAssetRow()">Add an asset</button>
      </div>

      <div class="card" id="openSummary"></div>

      <div class="actions">
        <button class="btn primary" type="button" onclick="finAdmin.postOpening()">Post opening balances</button>
      </div>
    </form>`;
}

let loanRows = [];
let assetRows = [];

export function mountOpening() {
  if (st().settings.openingPosted) return;
  drawLoanRows();
  drawAssetRows();
  document.getElementById('openingForm')?.addEventListener('input', updateOpeningSummary);
  updateOpeningSummary();
}

function drawLoanRows() {
  const box = document.getElementById('loanRows');
  if (!box) return;
  box.innerHTML = loanRows.map((l, i) => `
    <div class="card" style="background:var(--sunk)">
      <div class="row2">
        <div class="field"><label>Lender</label><input value="${esc(l.lender)}" oninput="finAdmin.setLoan(${i},'lender',this.value)"></div>
        <div class="field"><label>Outstanding</label><input type="number" value="${esc(l.principal)}" oninput="finAdmin.setLoan(${i},'principal',this.value)"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Rate % p.a.</label><input type="number" value="${esc(l.rate)}" oninput="finAdmin.setLoan(${i},'rate',this.value)"></div>
        <div class="field"><label>Months left</label><input type="number" value="${esc(l.n)}" oninput="finAdmin.setLoan(${i},'n',this.value)"></div>
      </div>
      <button class="btn ghost sm" type="button" onclick="finAdmin.dropLoan(${i})">Remove</button>
    </div>`).join('');
}

function drawAssetRows() {
  const box = document.getElementById('assetRows');
  if (!box) return;
  box.innerHTML = assetRows.map((a, i) => `
    <div class="card" style="background:var(--sunk)">
      <div class="row2">
        <div class="field"><label>Item</label><input value="${esc(a.name)}" oninput="finAdmin.setAsset(${i},'name',this.value)"></div>
        <div class="field"><label>Cost</label><input type="number" value="${esc(a.cost)}" oninput="finAdmin.setAsset(${i},'cost',this.value)"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Bought on</label><input type="date" value="${esc(a.date)}" oninput="finAdmin.setAsset(${i},'date',this.value)"></div>
        <div class="field"><label>Life (months)</label><input type="number" value="${esc(a.life)}" oninput="finAdmin.setAsset(${i},'life',this.value)"></div>
      </div>
      <button class="btn ghost sm" type="button" onclick="finAdmin.dropAsset(${i})">Remove</button>
    </div>`).join('');
}

// Build the journal from the form so the summary shows exactly what will be posted.
function openingLines() {
  const g = k => num(document.getElementById('s_o.' + k)?.value);
  const lines = [];
  const push = (acc, amt, side) => { if (Math.abs(num(amt)) > 0.005) lines.push({ acc, [side]: num(amt) }); };

  push('1000', g('bank'), 'dr');
  push('1010', g('petty'), 'dr');
  push('1100', g('receivable'), 'dr');
  push('2300', g('card'), 'cr');
  push('2000', g('vendors'), 'cr');
  push('2100', g('advances'), 'cr');
  push('3000', g('capital'), 'cr');

  for (const l of loanRows) push('2400', l.principal, 'cr');

  // An asset carried in mid-life goes in at cost, with the depreciation already suffered
  // sitting in 1350 — otherwise the remaining months would depreciate the full cost again.
  for (const a of assetRows) {
    const cost = num(a.cost), life = Math.max(1, num(a.life));
    const monthly = cost / life;
    const monthsRun = a.date ? Math.max(0, monthsBetween(ym(a.date), ym(st().settings.booksStartDate || today()))) : 0;
    const already = Math.min(cost, monthly * monthsRun);
    push('1300', cost, 'dr');
    push('1350', already, 'cr');
  }
  return lines;
}

function monthsBetween(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

function updateOpeningSummary() {
  const box = document.getElementById('openSummary');
  if (!box) return;
  const lines = openingLines();
  const dr = lines.reduce((s, l) => s + num(l.dr), 0);
  const cr = lines.reduce((s, l) => s + num(l.cr), 0);
  const plug = dr - cr;

  box.innerHTML = `
    <h3>What will be posted</h3>
    ${lines.length ? `
      <div class="tbl-wrap"><table>
        <thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead>
        <tbody>${lines.map(l => `<tr>
          <td>${esc(A[l.acc].name)}</td>
          <td class="n">${l.dr ? fmt(l.dr) : ''}</td>
          <td class="n">${l.cr ? fmt(l.cr) : ''}</td></tr>`).join('')}
          ${Math.abs(plug) > 0.005 ? `<tr>
            <td><b>${esc(A['3100'].name)}</b><br><span class="small faint">The balancing figure — your stake on day one</span></td>
            <td class="n">${plug < 0 ? fmt(-plug) : ''}</td>
            <td class="n">${plug > 0 ? fmt(plug) : ''}</td></tr>` : ''}
        </tbody>
      </table></div>`
      : '<p class="small faint">Fill in what you had and the entry appears here.</p>'}`;
}

// ═══════ GUIDE ═══════

export function renderGuide() {
  return `
    <h1>Guide</h1>
    <p class="lead">You record what happened; the system keeps double-entry books underneath.
    This page maps real situations to the button to press.</p>

    ${note('<b>The one idea.</b> Money moving and cost happening are different things. A ₹24,000 annual plan is cash out once but ₹2,000 of cost a month. A ₹15,000 EMI is cash out ₹15,000 but only the interest is a cost. Tokens are cash in but not income. The system tracks both — that is why the profit figure is honest.', 'info')}

    <h2>A deal, start to finish</h2>
    ${guideTable([
    ['Enquiry becomes serious', '<b>Record → New deal.</b> Give it a nickname, link the property if you want, add seller and buyer. Nothing posts to the books yet.'],
    ['Client pays a token', '<b>Token / advance received.</b> Held for them, not income.'],
    ['You pay for EC / patta / lawyer', '<b>Cost for this deal.</b> "Company" = your expense. "Recover from seller/buyer" = you paid on their behalf, so it sits as owed by them.'],
    ['Deal registers', '<b>Deal closed — raise brokerage invoice.</b> Income is earned now. Tokens adjust automatically, and a GST invoice is numbered and generated. Do this once per side.'],
    ['Client pays the balance', '<b>Client pays.</b> No income again — that was booked at registration.'],
  ])}

    <h2>When a deal does not go to plan</h2>
    ${guideTable([
    ['Deal falls through, refund the token', '<b>Settle a token</b> → Refund the full amount. Profit untouched.'],
    ['Client says "keep the token"', '<b>Settle a token</b> → Keep. It becomes income under Forfeited advances, and GST usually applies.'],
    ['Refund part, keep part', '<b>Settle a token</b> → enter both. Anything left stays held.'],
    ['Hold it for another property', '<b>Settle a token</b> → move the remainder to the other deal.'],
    ['Client will not reimburse the EC you paid', '<b>Recoverable cost not recovered.</b> It becomes your deal cost.'],
    ['Client will never pay the brokerage', '<b>Write off.</b> The loss is booked and the receivable removed.'],
    ['A written-off client pays later', '<b>Other income</b> → Bad debt recovered.'],
  ])}

    <h2>Services — estimate, then actual</h2>
    ${guideTable([
    ['Subscribe to a tool', '<b>Add a service.</b> Monthly: enter the expected charge. Upfront: what you paid and the term.'],
    ['The monthly debit happened', '<b>Confirm this month\'s charge.</b> Enter the real amount — pay-as-you-go often differs. Or mark it not charged.'],
    ['Upfront plan, each month', 'Nothing to do. Month-end releases one month of the cost automatically.'],
    ['Upgrade or downgrade', '<b>Upgrade / downgrade.</b> The old line closes, a new one starts. Past months stay correct.'],
    ['Cancel an annual plan after three months', '<b>Cancel</b> → enter the refund received. Unused minus refund is a loss this month.'],
  ])}

    <h2>Loans, cards and EMIs</h2>
    ${guideTable([
    ['Bank loan received', '<b>Bank / NBFC loan.</b> Not income. The schedule is generated.'],
    ['EMI debited', '<b>Pay an EMI.</b> Split into principal (not a cost) and interest (a cost) automatically.'],
    ['Bought on the card, converted to EMI later', 'Record the purchase paid via Credit card, then <b>Convert a card purchase to EMI</b>, then pay EMIs monthly.'],
    ['Card bill paid', '<b>Move money</b> → Pay the credit-card bill. Not an expense.'],
  ])}

    <h2>Everything else</h2>
    ${guideTable([
    ['Rent, EB, fuel, printing, food', '<b>Expense paid now.</b>'],
    ['A bill to pay later; CA or lawyer fees', '<b>Bill received.</b> Then Owed → <b>Pay</b> when you settle it.'],
    ['Salary', '<b>Salary / bonus</b>, entered gross with deductions.'],
    ['Laptop, camera, furniture', '<b>Buy an asset.</b> It depreciates monthly on its own.'],
    ['Sold or scrapped something', '<b>Sell or scrap an asset.</b> Gain or loss is worked out for you.'],
    ['Capital or a loan from you', '<b>Capital / director loan.</b> Never income.'],
    ['You paid from your own pocket', '<b>Director paid a company cost personally.</b> Reimburse later with Move money.'],
    ['Paying GST or TDS', '<b>Pay GST / TDS to government.</b> Not an expense — you were holding it.'],
    ['A wrong entry', 'Transactions → <b>Reverse.</b> Then record it correctly. Both entries stay on the record.'],
  ])}

    <h2>Bank reconciliation — how to</h2>
    <p class="small muted">This is the only check that proves your books are right. Twenty minutes a month.</p>
    ${guideTable([
    ['1. Download', 'Get the month\'s statement from your bank as CSV or Excel. Same for the credit card.'],
    ['2. Import', 'Bank tab → pick the account → choose the file. The first time you confirm which column is which; after that it is remembered.'],
    ['3. Auto-match', 'Every statement line is matched to an entry you already recorded — same amount, within three days.'],
    ['4. On the statement, not in the books', 'You forgot to record it. Tap <b>Create entry</b> — the date and amount are filled in, you just say what it was.'],
    ['5. In the books, not on the statement', 'Either it never went through (reverse it) or it lands next month (leave it).'],
    ['6. Reconciled ✓', 'When the closing balance matches and nothing is unmatched, the month is reconciled. Only then run month-end.'],
  ])}
    ${note('<b>The rule:</b> the bank statement is the truth; the books must mirror it line for line.', 'info')}

    <h2>The routine</h2>
    ${guideTable([
    ['Same day', 'Record it. Photograph the bill straight into the entry.'],
    ['Weekly', 'Petty cash vouchers · confirm service charges · Owed both ways: chase and pay.'],
    ['Month-end', 'Import the statements and reconcile · run month-end · check Reports · pay GST/TDS · send the journal CSV to your CA.'],
  ])}

    <h2>Verify with your CA</h2>
    <p class="small">TDS sections, rates and thresholds · GST on forfeited tokens and on recoverable costs
    (pure-agent rules) · depreciation rates for filing · PF and ESI applicability · the capitalisation threshold.</p>`;
}

const guideTable = pairs => `
  <div class="card pad0"><div class="tbl-wrap"><table><tbody>
    ${pairs.map(([a, b]) => `<tr><td style="width:34%">${a}</td><td>${b}</td></tr>`).join('')}
  </tbody></table></div></div>`;

// ═══════ ACTIONS ═══════

if (typeof window !== 'undefined') {
  window.finAdmin = {
    async saveProfile() {
      try {
        await SY.saveSettings(collect('profileForm'));
        toast('Profile saved');
      } catch (e) { toast(e.message || 'Could not save'); }
    },

    async saveSettings() {
      try {
        await SY.saveSettings(collect('settingsForm'));
        toast('Settings saved');
      } catch (e) { toast(e.message || 'Could not save'); }
    },

    async addBank() {
      const name = prompt('Account name (e.g. HDFC current)');
      if (!name) return;
      const last4 = prompt('Last 4 digits (optional)') || '';
      const list = [...(st().settings.bankAccounts || []), { id: '1000', name, last4 }];
      await SY.saveSettings({ bankAccounts: list });
      toast('Added');
    },

    async removeBank(i) {
      const list = [...(st().settings.bankAccounts || [])];
      list.splice(i, 1);
      await SY.saveSettings({ bankAccounts: list });
      toast('Removed');
    },

    editParty(id) {
      const p = st().parties.find(x => x.id === id);
      if (!p) return;
      window.fin.modal({
        title: 'Edit ' + p.name,
        body: `
          <div class="field"><label for="p_name">Name</label><input id="p_name" value="${esc(p.name)}"></div>
          <div class="row2">
            <div class="field"><label for="p_phone">Phone</label><input id="p_phone" value="${esc(p.phone || '')}"></div>
            <div class="field"><label for="p_email">Email</label><input id="p_email" value="${esc(p.email || '')}"></div>
          </div>
          <div class="row2">
            <div class="field"><label for="p_gstin">GSTIN</label><input id="p_gstin" value="${esc(p.gstin || '')}"></div>
            <div class="field"><label for="p_state">State</label><input id="p_state" value="${esc(p.state || '')}"
              placeholder="Tamil Nadu"></div>
          </div>
          <div class="hint">The state decides whether their invoice shows CGST+SGST or IGST.</div>`,
        foot: `<button class="btn primary" type="button" onclick="finAdmin.saveParty('${esc(id)}')">Save</button>`,
      });
    },

    async saveParty(id) {
      const v = k => document.getElementById('p_' + k).value.trim();
      await SY.saveParty(id, {
        name: v('name'), phone: v('phone'), email: v('email'), gstin: v('gstin'), state: v('state'),
      });
      window.fin.closeModal();
      toast('Saved');
    },

    async merge(keepId, dropId) {
      const ok = await confirmDialog({
        title: 'Merge these two?',
        message: `Every journal line pointing at <b>${esc(st().parties.find(p => p.id === dropId)?.name || '')}</b> is rewritten onto <b>${esc(st().parties.find(p => p.id === keepId)?.name || '')}</b>, and the duplicate is removed. The ledger totals do not change.`,
        confirmLabel: 'Merge',
      });
      if (!ok) return;
      try {
        const n = await SY.mergeParties(keepId, dropId);
        toast(`Merged — ${n} entr${n === 1 ? 'y' : 'ies'} updated`);
      } catch (e) { toast(e.message || 'Merge failed'); }
    },

    addAccount() {
      window.fin.modal({
        title: 'Add a category',
        body: `
          <div class="field"><label for="a_type">Kind</label>
            <select id="a_type"><option value="expense">Expense</option><option value="income">Income</option></select></div>
          <div class="field"><label for="a_code">Code</label><input id="a_code" placeholder="e.g. 5230">
            <div class="hint">Expenses are 5000–5999, income 4000–4999. Pick one not already used.</div></div>
          <div class="field"><label for="a_name">Name</label><input id="a_name"></div>`,
        foot: `<button class="btn primary" type="button" onclick="finAdmin.saveAccount()">Add</button>`,
      });
    },

    async saveAccount() {
      const code = document.getElementById('a_code').value.trim();
      const name = document.getElementById('a_name').value.trim();
      const type = document.getElementById('a_type').value;
      if (!/^\d{4}$/.test(code) || !name) return toast('Give it a four-digit code and a name');
      if (A[code]) return toast('That code is already used by ' + A[code].name);
      const ok = (type === 'expense' && code.startsWith('5')) || (type === 'income' && code.startsWith('4'));
      if (!ok) return toast(`An ${type} account needs a code starting with ${type === 'expense' ? '5' : '4'}`);
      // The chart is seeded into Firestore but the engine reads its own constant, so a new
      // category needs a code change to be usable in forms. Record it and say so plainly.
      await SY.saveParty(null, { name: '__account_request', type: 'other', note: `${code} ${name} ${type}` });
      window.fin.closeModal();
      toast('Noted — new categories need a small code change to appear in forms');
    },

    setLoan(i, k, v) { loanRows[i][k] = v; updateOpeningSummary(); },
    dropLoan(i) { loanRows.splice(i, 1); drawLoanRows(); updateOpeningSummary(); },
    addLoanRow() { loanRows.push({ lender: '', principal: 0, rate: 12, n: 24 }); drawLoanRows(); },

    setAsset(i, k, v) { assetRows[i][k] = v; updateOpeningSummary(); },
    dropAsset(i) { assetRows.splice(i, 1); drawAssetRows(); updateOpeningSummary(); },
    addAssetRow() { assetRows.push({ name: '', cost: 0, date: today(), life: 36 }); drawAssetRows(); },

    async postOpening() {
      const s = st();
      const date = s.settings.booksStartDate || today();
      const lines = openingLines();
      if (!lines.length) return toast('Enter at least one balance');

      const ok = await confirmDialog({
        title: 'Post opening balances?',
        message: 'This posts one journal entry dated ' + esc(date) + ' and then <b>locks this screen permanently</b>. Check the figures above first.',
        confirmLabel: 'Post them',
      });
      if (!ok) return;

      try {
        await SY.postOpeningBalances({
          date, lines,
          loans: loanRows.filter(l => num(l.principal) > 0).map(l => ({
            lender: l.lender || 'Lender', purpose: 'Opening balance',
            principal: num(l.principal), rate: num(l.rate), n: Math.max(1, num(l.n)),
            start: addMonths(ym(date), 1),
            schedule: schedule(num(l.principal), num(l.rate), Math.max(1, num(l.n)), addMonths(ym(date), 1)),
            paid: [], status: 'active', partyId: null,
          })),
          assets: assetRows.filter(a => num(a.cost) > 0).map(a => {
            const life = Math.max(1, num(a.life));
            const monthly = num(a.cost) / life;
            const run = Math.max(0, monthsBetween(ym(a.date), ym(date)));
            return {
              name: a.name || 'Asset', cost: num(a.cost), date: a.date, start: ym(date),
              life, monthly, status: 'in use',
              // Months already depreciated are pre-filled so month-end does not charge them again.
              depreciated: Array.from({ length: Math.min(run, life) }, (_, i) => addMonths(ym(a.date), i)),
            };
          }),
        });
        loanRows = []; assetRows = [];
        toast('Opening balances posted');
        window.fin.go('overview');
      } catch (e) { toast(e.message || 'Could not post'); }
    },
  };
}
