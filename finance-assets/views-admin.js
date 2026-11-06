// ═══════ PROFILE, SETTINGS, OPENING BALANCES, GUIDE ═══════
//
// Profile is the company's identity and the things that are still missing — the details only
// the owner and their CA can supply. Settings is how the engine behaves. They are separate on
// purpose: Profile is filled in once and then rarely touched, Settings is tuning.

import {
  ACCOUNTS, A, EXP, fmt, esc, num, today, ym, addMonths, mlabel,
  getState, bal, schedule, fyOf, lastIssued, seriesPrefix, COUNTERS, counterPatch, issueNumber, invoiceServices, presetPatch, knownClientsTodo,
} from './finance-core.js';
import { stat, empty, note, tag, table, toast, confirmDialog } from './ui.js';
import * as SY from './finance-sync.js';
import { INVOICE_ACCS } from './finance-events.js';

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

    ${presetOffer() ? note(`<b>Fill in from your invoice 056?</b> ${esc(presetOffer())} — exactly as your hand-made invoices
      print them. Only empty fields are filled; nothing you have typed is changed.
      <div class="actions" style="margin:10px 0 0"><button class="btn primary" type="button" onclick="finAdmin.fillPreset()">Fill them in</button></div>`) : ''}

    <form id="profileForm" onsubmit="return false">
      <h2>Company</h2>
      <div class="card">
        ${field('Registered name', 'companyName', s.companyName)}
        <div class="row2">
          ${field('GSTIN', 'gstin', s.gstin, { placeholder: '33XXXXXXXXXXXZX', hint: 'Fifteen characters, starts with your state code (33 for Tamil Nadu).' })}
          ${field('PAN', 'pan', s.pan, { placeholder: 'ABCDE1234F', hint: 'Printed on invoices next to the GSTIN.' })}
        </div>
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
        <div class="row2">
          ${field('Branch', 'bankDetails.branch', s.bankDetails?.branch)}
          ${field('Cheques / DDs in favour of', 'chequeFavour', s.chequeFavour, { placeholder: s.bankDetails?.accountName || s.companyName || '', hint: 'Leave blank to use the account name.' })}
        </div>
      </div>

      <h2>Signature on invoices</h2>
      <div class="card">
        <div class="sigbox">${s.signature ? `<img src="${esc(s.signature)}" alt="Your signature">`
    : '<span class="small faint">No signature yet — invoices print a blank line to sign by hand.</span>'}</div>
        <div class="actions">
          <button class="btn" type="button" onclick="finAdmin.uploadSignature()">Upload an image</button>
          <button class="btn" type="button" onclick="finAdmin.drawSignature()">Draw it</button>
          ${s.signature ? '<button class="btn ghost" type="button" onclick="finAdmin.removeSignature()">Remove</button>' : ''}
        </div>
        <div class="hint">A photo of your signature on white paper works — the paper is made see-through and the edges trimmed.
          It prints above "Authorised signatory" on every invoice PDF generated from now on.</div>
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
          ${field('Invoice prefix', 'invoicePrefix', seriesPrefix(s, 'invoice'), { hint: `{MM} {YY} {YYYY} {FY} take the invoice's month and year. Next invoice: <b>${esc(issueNumber(s, 'invoice').no)}</b>.` })}
          ${field('Next invoice number', 'nextInvoiceNo', s.nextInvoiceNo, { type: 'number', hint: `Change only if you are continuing a sequence from elsewhere. It cannot go back to a number already issued${lastIssued(seriesPrefix(s, 'invoice')).no ? ` — ${esc(lastIssued(seriesPrefix(s, 'invoice')).no)} is the last one` : ''}.` })}
        </div>
        <div class="row2">
          ${field('Credit note prefix', 'creditNotePrefix', s.creditNotePrefix)}
          ${field('Next credit note number', 'nextCreditNoteNo', s.nextCreditNoteNo, { type: 'number' })}
        </div>
        <div class="row2">
          ${field('SAC — brokerage', 'sacCodes.brokerage', s.sacCodes?.brokerage, { hint: '997221 is real-estate agency services.' })}
          ${field('SAC — consultancy', 'sacCodes.consultancy', s.sacCodes?.consultancy, { hint: '998311 is management consulting.' })}
        </div>
      </div>

      <h2>Services you invoice</h2>
      <div class="card">
        <p class="small muted" style="margin-top:0">Pick one on an invoice line and it fills the description, SAC and price, and books
          the invoice to its income head — so the profit and loss shows what each service earns. Ask your CA to confirm each SAC.</p>
        <div id="svcRows">${svcRowsHtml()}</div>
        <div class="actions">
          <button class="btn ghost" type="button" onclick="finAdmin.addSvc()">+ Add a service</button>
          <button class="btn" type="button" onclick="finAdmin.saveSvcs()">Save services</button>
        </div>
      </div>

      <h2>Income tax and TDS thresholds</h2>
      <div class="card">
        ${field('Income-tax rate % (for the estimate on Reports)', 'incomeTaxRate', s.incomeTaxRate, { type: 'number', hint: '26% is 25% plus 4% cess — the rate without any election. The lower 25.168% under s.115BAA applies only if the company has filed Form 10-IC; ask your CA before setting it.' })}
        <p class="small muted">Annual amount paid to one vendor above which TDS applies. The bill form shows how much you have paid each vendor this year against these.</p>
        <div class="row2">
          ${field('194H commission', 'tdsThresholds.194H', s.tdsThresholds?.['194H'], { type: 'number' })}
          ${field('194J professional fees', 'tdsThresholds.194J', s.tdsThresholds?.['194J'], { type: 'number' })}
        </div>
        <div class="row2">
          ${field('194I rent', 'tdsThresholds.194I', s.tdsThresholds?.['194I'], { type: 'number' })}
          ${field('194C contractor (aggregate)', 'tdsThresholds.194C', s.tdsThresholds?.['194C'], { type: 'number' })}
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
          <div class="hint">Drive reuses the same service account the brochure system already uses, so nothing extra has to be enabled. Firebase Storage has to be switched on once in the Firebase console before it will work.</div>
        </div>
        ${field('Drive folder id', 'driveFolderId', s.driveFolderId,
          { placeholder: '1OuHgdyLyQCD…', hint: 'The folder attachments are filed into, as {financial year}/{entry}. Take it from the folder URL: drive.google.com/drive/folders/<b>THIS PART</b>.' })}
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
  const add = '<div class="actions"><button class="btn" type="button" onclick="finAdmin.editParty()">Add a client</button></div>';
  if (!parties.length) return `<h2>People and companies</h2>${add}`;

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
    ${add}
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
    </div>

    <h2>Offline copy</h2>
    <p class="small muted">This device keeps its own copy of the books so the page opens instantly
    and only asks Firestore for what has changed since last time. The copy checks itself against
    the server once a day and re-reads anything that disagrees — but if a figure ever looks wrong,
    check it now rather than wondering.</p>
    <div class="actions">
      <button class="btn" type="button" onclick="finAdmin.verifyCache()">Check against the server</button>
      <button class="btn" type="button" onclick="finAdmin.rebuildCache()">Re-read everything</button>
    </div>`;
}

// Compares what this device holds against Firestore's own count of each collection and
// re-reads any that disagree. Costs about a dozen reads — count() is an aggregation, billed
// per thousand documents rather than per document.
export async function verifyCache() {
  toast('Checking…');
  try {
    const repaired = await SY.verifyNow();
    if (repaired === null) toast('This browser keeps no offline copy — nothing to check');
    else if (repaired.length) toast(`Repaired: ${repaired.join(', ')}`);
    else toast('Everything on this device matches the server');
  } catch (e) {
    toast(e.message || 'Could not check');
  }
}

// The escape hatch: throw the local copy away and read the books again from scratch. Costs a
// full read, which is what every page load used to cost, so it is a button and not automatic.
export async function rebuildCache() {
  const ok = await confirmDialog(
    'Re-read the whole ledger from Firestore? Nothing is lost — this only rebuilds this device\'s copy.');
  if (!ok) return;
  await SY.resetCache();
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

// What one click would fill from 3 PIN's own invoice, as a list for the offer — or '' when the
// Profile has it all, or belongs to some other company.
export function presetOffer(settings = st().settings) {
  const name = String(settings?.companyName || '');
  if (name && !/3\s*pin/i.test(name)) return '';
  const p = presetPatch(settings);
  const names = { companyName: 'name', pan: 'PAN', gstin: 'GSTIN', address: 'address', state: 'state', phone: 'phone', email: 'email', chequeFavour: 'cheque name', bankDetails: 'bank details' };
  const clients = knownClientsTodo().map(c => `${c.name || c.add.name}'s address and GSTIN`);
  return [...Object.keys(p).map(k => names[k] || k), ...clients].join(', ');
}

// ═══════ SERVICES YOU INVOICE ═══════
//
// Edited as rows in place and saved as one list on the settings document. The rows are read
// afresh each time Settings is drawn, so an unsaved edit is simply dropped on leaving.

let svcRows = [];

function svcRowsHtml() {
  svcRows = invoiceServices(st().settings).map(x => ({ ...x }));
  return drawSvcRows();
}

function drawSvcRows() {
  const html = `<div class="tbl-wrap invlines"><table>
    <thead><tr><th>Service</th><th>Description it starts the line with</th><th>SAC</th><th class="n">Price</th><th>Income head</th><th></th></tr></thead>
    <tbody>${svcRows.map((r, i) => `<tr>
      <td><input type="text" value="${esc(r.name)}" oninput="finAdmin.setSvc(${i},'name',this.value)" aria-label="Service name"></td>
      <td><input type="text" value="${esc(r.desc)}" oninput="finAdmin.setSvc(${i},'desc',this.value)" aria-label="${esc(r.name)} description"></td>
      <td><input type="text" value="${esc(r.sac)}" oninput="finAdmin.setSvc(${i},'sac',this.value)" style="width:90px" aria-label="${esc(r.name)} SAC"></td>
      <td><input type="text" inputmode="decimal" value="${num(r.price) || ''}" placeholder="—" oninput="finAdmin.setSvc(${i},'price',this.value)" style="text-align:right" aria-label="${esc(r.name)} price"></td>
      <td><select onchange="finAdmin.setSvc(${i},'acc',this.value)" aria-label="${esc(r.name)} income head">
        ${INVOICE_ACCS.map(c => `<option value="${c}" ${r.acc === c ? 'selected' : ''}>${c} · ${esc(A[c]?.name || c)}</option>`).join('')}</select></td>
      <td><button class="btn ghost sm" type="button" onclick="finAdmin.dropSvc(${i})" aria-label="Remove ${esc(r.name)}">✕</button></td>
    </tr>`).join('')}</tbody></table></div>`;
  const box = typeof document !== 'undefined' && document.getElementById('svcRows');
  if (box) box.innerHTML = html;
  return html;
}

// ═══════ SIGNATURE ═══════
//
// Kept on the settings document as a small transparent PNG data URL, so the invoice PDF can
// draw it without fetching anything (Drive links are not readable from the page). A photo is
// cleaned up first: near-white becomes transparent, the ink is trimmed to its edges and the
// result is scaled to at most 600 × 200 — a few kilobytes.

function cleanSignature(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(source, 0, 0, w, h);
  const img = x.getImageData(0, 0, w, h);
  const d = img.data;
  let top = h, left = w, right = -1, bottom = -1;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (d[i + 3] < 10 || lum > 190) { d[i + 3] = 0; continue; }
    const p = i / 4, px = p % w, py = (p - px) / w;
    if (px < left) left = px; if (px > right) right = px;
    if (py < top) top = py; if (py > bottom) bottom = py;
  }
  if (right < 0) throw new Error('No signature found in that image — try a darker pen on white paper.');
  x.putImageData(img, 0, 0);
  const pad = 6;
  left = Math.max(0, left - pad); top = Math.max(0, top - pad);
  right = Math.min(w - 1, right + pad); bottom = Math.min(h - 1, bottom + pad);
  const cw = right - left + 1, chh = bottom - top + 1;
  const k = Math.min(1, 600 / cw, 200 / chh);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cw * k)); out.height = Math.max(1, Math.round(chh * k));
  out.getContext('2d').drawImage(c, left, top, cw, chh, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

async function saveSignature(dataUrl) {
  await SY.saveSettings({ signature: dataUrl });
  toast(dataUrl ? 'Signature saved — it prints on invoices from now on' : 'Signature removed');
  window.fin.go('profile');
}

// ═══════ ACTIONS ═══════

if (typeof window !== 'undefined') {
  window.finAdmin = {
    verifyCache,
    rebuildCache,

    setSvc(i, k, v) { svcRows[i][k] = k === 'price' ? num(v) : v; },
    addSvc() { svcRows.push({ name: '', desc: '', sac: '', price: 0, acc: '4020' }); drawSvcRows(); },
    dropSvc(i) { svcRows.splice(i, 1); drawSvcRows(); },
    async saveSvcs() {
      const list = svcRows.map(r => ({ name: String(r.name || '').trim(), desc: String(r.desc || '').trim(), sac: String(r.sac || '').trim(), price: num(r.price), acc: r.acc || '4020' }))
        .filter(r => r.name);
      try {
        await SY.saveSettings({ invoiceServices: list });
        toast(`${list.length} service${list.length === 1 ? '' : 's'} saved`);
      } catch (e) { toast(e.message || 'Could not save'); }
    },

    async fillPreset() {
      const patch = presetPatch(st().settings);
      const clients = knownClientsTodo();
      if (!Object.keys(patch).length && !clients.length) return toast('Already filled in');
      try {
        if (Object.keys(patch).length) await SY.saveSettings(patch);
        for (const c of clients) await SY.saveParty(c.id || null, c.patch || c.add);
        toast('Filled in from invoice 056');
        window.fin.repaint ? window.fin.repaint() : window.fin.go('profile');
      } catch (e) { toast(e.message || 'Could not save'); }
    },

    uploadSignature() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
          const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
          const url = cleanSignature(bmp, Math.round(bmp.width * k), Math.round(bmp.height * k));
          bmp.close?.();
          await saveSignature(url);
        } catch (e) { toast(e.message || 'Could not read that image'); }
      };
      input.click();
    },

    drawSignature() {
      window.fin.modal({
        title: 'Draw your signature',
        body: `<canvas id="sigPad" class="sigpad" width="1120" height="360" aria-label="Signature pad"></canvas>
          <div class="hint">Sign with a finger, a stylus or the mouse.</div>`,
        foot: `<button class="btn ghost" type="button" id="sigClear">Clear</button>
          <div class="spacer"></div>
          <button class="btn primary" type="button" id="sigSave">Use this signature</button>`,
      });
      const pad = document.getElementById('sigPad');
      const x = pad.getContext('2d');
      x.lineWidth = 5; x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#1a2a6c';
      let drawing = false, inked = false;
      const at = e => {
        const r = pad.getBoundingClientRect();
        return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height];
      };
      pad.onpointerdown = e => { drawing = true; pad.setPointerCapture(e.pointerId); x.beginPath(); x.moveTo(...at(e)); };
      pad.onpointermove = e => { if (!drawing) return; x.lineTo(...at(e)); x.stroke(); inked = true; };
      pad.onpointerup = pad.onpointercancel = () => { drawing = false; };
      document.getElementById('sigClear').onclick = () => { x.clearRect(0, 0, pad.width, pad.height); inked = false; };
      document.getElementById('sigSave').onclick = async () => {
        if (!inked) { toast('Sign in the box first'); return; }
        try {
          const url = cleanSignature(pad, pad.width, pad.height);
          window.fin.closeModal();
          await saveSignature(url);
        } catch (e) { toast(e.message || 'Could not save the signature'); }
      };
    },

    async removeSignature() {
      const ok = await confirmDialog({ title: 'Remove the signature?', message: 'Invoices will print a blank line to sign by hand.', confirmLabel: 'Remove' });
      if (ok) await saveSignature('');
    },

    async saveProfile() {
      try {
        await SY.saveSettings(collect('profileForm'));
        toast('Profile saved');
      } catch (e) { toast(e.message || 'Could not save'); }
    },

    async saveSettings() {
      try {
        const edited = new Set(COUNTERS.map(c => c.key)
          .filter(k => { const el = document.getElementById('s_' + k); return el && el.value !== el.defaultValue; }));
        await SY.saveSettings(counterPatch(collect('settingsForm'), edited));
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

    // With no id, a new client: added with their billing details so an invoice to them can be
    // previewed complete before anything is issued.
    editParty(id) {
      const p = id ? st().parties.find(x => x.id === id) : { name: '', type: 'client' };
      if (!p) return;
      window.fin.modal({
        title: id ? 'Edit ' + p.name : 'Add a client',
        body: `
          <div class="field"><label for="p_name">Name</label><input type="text" id="p_name" value="${esc(p.name)}"></div>
          <div class="row2">
            <div class="field"><label for="p_phone">Phone</label><input type="text" id="p_phone" value="${esc(p.phone || '')}"></div>
            <div class="field"><label for="p_email">Email</label><input type="email" id="p_email" value="${esc(p.email || '')}"></div>
          </div>
          <div class="row2">
            <div class="field"><label for="p_gstin">GSTIN</label><input type="text" id="p_gstin" value="${esc(p.gstin || '')}"></div>
            <div class="field"><label for="p_state">State</label><input type="text" id="p_state" value="${esc(p.state || '')}"
              placeholder="Tamil Nadu"></div>
          </div>
          <div class="field"><label for="p_address">Billing address</label>
            <textarea id="p_address" rows="2">${esc(p.address || '')}</textarea></div>
          <div class="row2">
            <div class="field"><label for="p_pan">PAN</label><input type="text" id="p_pan" value="${esc(p.pan || '')}"></div>
            <div class="field"><label for="p_contact">Contact person</label><input type="text" id="p_contact" value="${esc(p.contact || '')}"></div>
          </div>
          <div class="hint">These print on their invoices. The state decides whether an invoice shows CGST+SGST or IGST.</div>`,
        foot: `<button class="btn primary" type="button" onclick="finAdmin.saveParty('${esc(id || '')}')">${id ? 'Save' : 'Add client'}</button>`,
      });
    },

    async saveParty(id) {
      const v = k => document.getElementById('p_' + k).value.trim();
      const name = v('name');
      if (!name) return toast('Give the client a name');
      if (!id && st().parties.some(p => p.name.trim().toLowerCase() === name.toLowerCase())) return toast(`${name} is already a client — edit that one`);
      try {
        await SY.saveParty(id || null, {
          name, phone: v('phone'), email: v('email'), gstin: v('gstin'), state: v('state'),
          address: v('address'), pan: v('pan'), contact: v('contact'), ...(id ? {} : { type: 'client' }),
        });
        window.fin.closeModal();
        toast(id ? 'Saved' : `${name} added — pick them on New invoice`);
      } catch (e) { toast(e.message || 'Could not save'); }
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
