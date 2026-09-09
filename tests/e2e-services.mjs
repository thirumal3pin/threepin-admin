// ═══════ END-TO-END, AGAINST THE LIVE SITE — THE CLAUDE PRO STORY ═══════
//
// Drives the deployed page through the whole recording path the owner described: add a
// subscription, record two months paid from the bank, then a mid-month upgrade with a
// prorated invoice (reverse charge, variance reason, new plan from next month), see it on
// Services and Owed, pay it with the allocation table, hit the validation guards, reverse a
// payment and a month and watch the documents unwind — all through the real Firestore
// transactions. Then puts the books back exactly as they were.
//
//   node tests/e2e-services.mjs [base-url]

import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const BASE = process.argv[2] || 'https://admin.threepin.in';

// This suite signs in as the real account and posts real entries into the real books. It used
// to default to production, which is how a fortnight of iterating on it turned into thousands
// of reads and hundreds of writes against the live ledger. Pointing it at production is still
// allowed — it is the only place some of this can be checked — but it now has to be asked for
// out loud, so it cannot happen again merely because someone ran the file with no arguments.
const SCRIPT = 'tests/' + import.meta.url.split('/').pop();
if (/admin\.threepin\.in/.test(BASE) && !process.env.E2E_ALLOW_LIVE) {
  console.error('\n  Refusing to run against production.\n');
  console.error('  This writes to the live ledger and reads the whole book to do it.\n');
  console.error(`  Against production anyway:  E2E_ALLOW_LIVE=1 node ${SCRIPT}`);
  console.error(`  Against a local server:      node ${SCRIPT} http://localhost:5173\n`);
  process.exit(2);
}
const SHOTS = process.env.SHOTS || 'C:/Users/3PINRE~1/AppData/Local/Temp/claude/c--Users-3Pin-Realty-Downloads-Thirumal/4259cdc1-a7b1-4f0d-bfe2-0730f72ae471/scratchpad/e2e/';
const TENANT = 't_3pinrealty';
const EMAIL = '3pinrentals@gmail.com';

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log('  ok    ' + label); return; }
  failed++; failures.push(label + (detail ? ' — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
};
const section = n => console.log('\n── ' + n);
const near = (a, b) => Math.abs(+a - +b) < 0.02;

// ── admin side ──────────────────────────────────────────────────────────────────
const sa = JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const root = db.collection('finance').doc(TENANT);
const user = await getAuth().getUserByEmail(EMAIL);
const token = await getAuth().createCustomToken(user.uid, user.customClaims || {});

const COLLS = ['txns', 'bills', 'subscriptions', 'parties', 'invoices'];
const before = { nextTxnNo: (await root.get()).data().nextTxnNo, ids: {} };
for (const c of COLLS) before.ids[c] = new Set((await root.collection(c).get()).docs.map(d => d.id));
console.log(`books before: ${before.ids.txns.size} entries, next #${before.nextTxnNo}`);

const docsIn = async c => (await root.collection(c).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const newIn = async c => (await docsIn(c)).filter(d => !before.ids[c].has(d.id));

// ── browser ─────────────────────────────────────────────────────────────────────
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [], consoleErrors = [];
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

await page.goto(BASE + '/3pinfinance', { waitUntil: 'networkidle' });
await page.evaluate(async t => {
  const { getAuth, signInWithCustomToken } = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js');
  await signInWithCustomToken(getAuth(), t);
}, token);
await page.waitForFunction(() => document.getElementById('appRoot').style.display !== 'none', { timeout: 20000 });
await page.waitForTimeout(2500);

const saveAndWait = async () => {
  await page.evaluate(() => document.querySelector('.save-bar .js-save').click());
  await page.waitForSelector('.result', { timeout: 30000 });
  await page.waitForTimeout(1200); // let the snapshot listener deliver the new documents
  return page.evaluate(() => ({
    heading: document.querySelector('.result h3')?.textContent || '',
    entry: document.querySelector('.result .eno')?.textContent || '',
    dir: document.querySelector('.result')?.className || '',
    body: document.querySelector('.result')?.innerText || '',
  }));
};
const saveEnabled = () => page.evaluate(() => !document.querySelector('.save-bar .js-save').disabled);
const barText = () => page.evaluate(() => document.getElementById('barSum').innerText);
const errText = k => page.evaluate(k => { const e = document.getElementById('err_' + k); return e && !e.hidden ? e.textContent : ''; }, k);

let cleanupNote = '';
try {
  // ═══════ 1. Add the service ═══════
  section('Add a service with a new vendor');
  await page.evaluate(() => window.fin.record('subnew'));
  await page.waitForSelector('#f_name');
  check('Set-up forms carry the plain direction tag', await page.evaluate(() => document.querySelector('.record-split')?.className.includes('dir-setup')));
  await page.fill('#f_name', 'E2E Claude');
  await page.fill('#f_plan', 'Pro');
  await page.fill('#pick_vendor input', 'E2E Anthropic');
  await page.waitForSelector('#pick_vendor [data-new]');
  await page.click('#pick_vendor [data-new]');
  await page.waitForSelector('#pick_vendor .chip-sel');
  await page.fill('#f_use', 'E2E content');
  await page.fill('#f_amt', '1800');
  check('Save enabled once the form is complete', await saveEnabled(), await barText());
  let r = await saveAndWait();
  check('Service saved', /Saved/.test(r.heading), r.heading);
  const subs = await newIn('subscriptions');
  const sub = subs.find(x => x.name === 'E2E Claude');
  const vendor = (await newIn('parties')).find(p => p.name === 'E2E Anthropic');
  check('Subscription document created with vendor and plan history', !!sub && !!vendor && sub.vendorId === vendor.id && sub.history?.length === 1, JSON.stringify(sub));
  check('No ledger entry for adding a service', (await newIn('txns')).length === 0);

  // ═══════ 2. Two normal months ═══════
  section('September and October — paid from bank as expected');
  for (const [m, d] of [['2026-09', '2026-09-05'], ['2026-10', '2026-10-05']]) {
    await page.evaluate(id => window.fin.record('confirmcharge', { sub: id }), sub.id);
    await page.waitForSelector('#f_month');
    await page.fill('#f_month', m);
    await page.fill('#f_date', d);
    check(`${m}: amount prefilled from the expectation`, await page.evaluate(() => +document.getElementById('f_amt').value) === 1800);
    check(`${m}: form is red (money out)`, await page.evaluate(() => document.querySelector('.record-split')?.className.includes('dir-out')));
    r = await saveAndWait();
    check(`${m}: saved with an entry number`, /Saved/.test(r.heading) && /#\d{4}/.test(r.entry), r.heading + ' ' + r.entry);
  }
  let bills = await newIn('bills');
  check('Two paid bills on record, linked to the service and month', bills.filter(b => b.serviceId === sub.id && b.status === 'paid').length === 2, JSON.stringify(bills.map(b => [b.month, b.status])));
  let subNow = (await docsIn('subscriptions')).find(x => x.id === sub.id);
  check('Month records point at their bills with no variance', subNow.charges?.['2026-09']?.billId === bills.find(b => b.month === '2026-09')?.id && subNow.charges['2026-10'].variance === 0, JSON.stringify(subNow.charges));

  // ═══════ 3. The upgrade month ═══════
  section('November — prorated invoice, reverse charge, new plan from December');
  await page.evaluate(id => window.fin.record('confirmcharge', { sub: id }), sub.id);
  await page.waitForSelector('#f_month');
  await page.fill('#f_month', '2026-11');
  await page.fill('#f_date', '2026-11-14');
  await page.selectOption('#f_result', 'invoice');
  await page.waitForSelector('#f_dueDate');
  await page.fill('#f_dueDate', '2026-11-28');
  check('Reason field hidden while the amount matches', await page.$('#f_reason') === null);
  check('The GST question offers no-GST, charged, and reverse charge', await page.evaluate(() => [...document.querySelectorAll('#f_rcm option')].map(o => o.value).join() === 'no,charged,yes'));
  await page.fill('#f_amt', '4320');
  await page.waitForSelector('#f_reason', { timeout: 5000 });
  check('Typing a different amount reveals the reason field', true);
  check('Focus stayed in the amount field across the rebuild', await page.evaluate(() => document.activeElement?.id === 'f_amt'));
  await page.selectOption('#f_reason', 'prorate');
  await page.fill('#f_note', 'Upgraded to Max on the 14th');
  await page.selectOption('#f_rcm', 'yes');
  await page.waitForSelector('#f_rcmRate');
  check('Reverse charge defaults to 18% on a vendor abroad', await page.evaluate(() => +document.getElementById('f_rcmRate').value === 18 && document.getElementById('f_rcmType').value === 'import'));
  await page.selectOption('#f_newPlan', 'yes');
  await page.waitForSelector('#f_newAmount');
  await page.fill('#f_newAmount', '10000');
  await page.fill('#f_newPlanName', 'Max');
  check('New plan defaults to the month after the one recorded', await page.evaluate(() => document.getElementById('f_newFrom').value) === '2026-12');
  const eff = await page.evaluate(() => document.getElementById('pvEffects').innerText);
  check('Preview explains the variance, reverse charge and the new expectation', /2,520/.test(eff) && /reverse charge/i.test(eff) && /10,000/.test(eff) && /Dec 2026/.test(eff), eff.slice(0, 300));
  await page.screenshot({ path: `${SHOTS}m-upgrade-form.png`, fullPage: true });
  r = await saveAndWait();
  check('Upgrade month saved', /Saved/.test(r.heading), r.heading);
  const novBill = (await newIn('bills')).find(b => b.month === '2026-11');
  check('An OPEN bill for 4,320 due 2026-11-28 exists', !!novBill && novBill.status === 'open' && near(novBill.total, 4320) && novBill.dueDate === '2026-11-28' && novBill.partyId === vendor.id, JSON.stringify(novBill));
  subNow = (await docsIn('subscriptions')).find(x => x.id === sub.id);
  check('Subscription now expects 10,000 from December (history of two, plan Max)', subNow.history?.length === 2 && subNow.history[1].from === '2026-12' && subNow.history[1].amount === 10000 && subNow.plan === 'Max', JSON.stringify(subNow.history));
  check('November record carries variance 2,520 and the reason', near(subNow.charges['2026-11'].variance, 2520) && subNow.charges['2026-11'].reason === 'prorate' && subNow.charges['2026-11'].billId === novBill.id && subNow.charges['2026-11'].paid === false, JSON.stringify(subNow.charges['2026-11']));
  const novTxn = (await newIn('txns')).find(t => /Nov 2026/.test(t.desc));
  check('Journal: 5080 dr 4320, IGST input 777.6, RCM payable 777.6, payable 4320', !!novTxn && JSON.stringify(novTxn.lines.map(l => [l.acc, l.dr || 0, l.cr || 0])) === JSON.stringify([['5080', 4320, 0], ['1402', 777.6, 0], ['2205', 0, 777.6], ['2000', 0, 4320]]), JSON.stringify(novTxn?.lines));
  check('The bill knows its transaction', novBill.txnId === novTxn?.id);

  // ═══════ 4. Services and Owed show the story ═══════
  section('Services and Owed');
  // innerText skips the content of a closed <details>, so open them all before reading.
  const mainText = () => page.evaluate(() => { document.querySelectorAll('#main details').forEach(d => { d.open = true; }); return document.getElementById('main').innerText; });
  await page.evaluate(() => window.fin.go('services'));
  await page.waitForTimeout(500);
  let txt = await mainText();
  check('Services shows the service with the new expectation from December', /E2E Claude/.test(txt) && /10,000 from Dec 2026/.test(txt), txt.slice(0, 400));
  check('November shows as billed but unpaid, with the variance and reason', /4,320 — not paid yet/.test(txt) && /\+₹2,520/.test(txt) && /prorated/i.test(txt), JSON.stringify([/4,320 — not paid yet/.test(txt), /\+₹2,520/.test(txt), /prorated/i.test(txt)]) + ' ' + (txt.match(/Nov 2026.{0,160}/)?.[0] || ''));
  await page.screenshot({ path: `${SHOTS}m-services.png`, fullPage: true });

  await page.evaluate(() => window.fin.go('owed'));
  await page.waitForTimeout(500);
  txt = await page.evaluate(() => document.getElementById('main').innerText);
  check('Owed lists the vendor with the bill, its amount and due date', /E2E Anthropic/.test(txt) && /4,320/.test(txt) && /2026-11-28/.test(txt), txt.slice(0, 400));
  await page.screenshot({ path: `${SHOTS}m-owed.png`, fullPage: true });

  // ═══════ 5. Pay it, with the allocation table ═══════
  section('Pay the prorated invoice — allocation table');
  await page.evaluate(id => window.fin.record('paybill', { party: id }), vendor.id);
  await page.waitForSelector('#f_amt');
  check('Amount prefilled with what is owed', await page.evaluate(() => +document.getElementById('f_amt').value) === 4320);
  check('Allocation table shows the one open bill, fully applied', await page.evaluate(() => { const i = document.querySelector('#alloc_alloc input[data-alloc]'); return !!i && +i.value === 4320; }));
  check('Save bar shows the amount in red', /4,320/.test(await barText()) && await page.evaluate(() => !!document.querySelector('#barSum b.neg')));
  await page.screenshot({ path: `${SHOTS}m-paybill.png`, fullPage: true });
  r = await saveAndWait();
  check('Payment saved', /Saved/.test(r.heading), r.heading);
  let novBillNow = (await docsIn('bills')).find(b => b.id === novBill.id);
  check('The bill is now PAID by allocation', novBillNow.status === 'paid' && near(novBillNow.paid, 4320) && novBillNow.allocations?.length === 1, JSON.stringify(novBillNow));
  const payTxn = (await newIn('txns')).find(t => /^Paid /.test(t.desc));
  check('The payment entry names the bill it settled', payTxn?.allocations?.[0]?.id === novBill.id, JSON.stringify(payTxn?.allocations));

  // ═══════ 6. Guards in the real form ═══════
  section('Validation in the browser');
  await page.evaluate(id => window.fin.record('confirmcharge', { sub: id }), sub.id);
  await page.waitForSelector('#f_month');
  await page.fill('#f_month', '2026-11');
  await page.waitForTimeout(200);
  check('Recording November again is refused under the month field', /already recorded/.test(await errText('month')), await errText('month'));
  check('…and Save is disabled', !(await saveEnabled()));
  check('…and the save bar says why', /already recorded/.test(await barText()));
  await page.screenshot({ path: `${SHOTS}m-validation.png`, fullPage: true });

  await page.evaluate(() => window.fin.record('petty'));
  await page.waitForSelector('#f_a1');
  await page.fill('#f_a1', '999999');
  await page.waitForTimeout(200);
  check('Petty cash beyond the box warns but does not block', /box/i.test(await errText('a1')) && await page.evaluate(() => !document.querySelector('#err_a1')?.classList.contains('err')), await errText('a1'));
  check('The second voucher waits until it is named', await page.$('#f_a2') === null);
  await page.fill('#f_d2', 'Courier');
  await page.waitForSelector('#f_a2', { timeout: 4000 });
  check('Naming a second voucher reveals its amount', true);

  // ═══════ 7. Direction cues on the chooser ═══════
  section('Direction cues');
  await page.evaluate(() => window.fin.pick(null));
  await page.waitForSelector('#chooser');
  const tiles = await page.evaluate(() => ({ tiles: document.querySelectorAll('.dir-tiles .tile').length, chips: document.querySelectorAll('.dir-chips .chip').length }));
  check('Money in / Money out are the first choice', tiles.tiles === 2 && tiles.chips >= 3, JSON.stringify(tiles));
  await page.click('.dir-tiles .tile.dir-out');
  await page.waitForTimeout(300);
  const onlyOut = await page.evaluate(() => [...document.querySelectorAll('#chooser button:not([hidden])')].every(b => b.dataset.dir === 'out'));
  check('Choosing Money out hides everything else', onlyOut);
  await page.click('.dir-chips .chip:last-child');
  await page.waitForTimeout(300);
  const cues = await page.evaluate(() => {
    const c = sel => { const b = document.querySelector(sel); return b ? getComputedStyle(b).borderLeftColor : ''; };
    return { inN: document.querySelectorAll('#chooser button.dir-in').length, outN: document.querySelectorAll('#chooser button.dir-out').length, inC: c('#chooser button.dir-in'), outC: c('#chooser button.dir-out') };
  });
  check('Money-in buttons are green-edged', cues.inN >= 5 && cues.inC === 'rgb(31, 122, 77)', JSON.stringify(cues));
  check('Money-out buttons are red-edged', cues.outN >= 5 && cues.outC === 'rgb(179, 38, 30)', JSON.stringify(cues));
  const fontInfo = await page.evaluate(async () => { await document.fonts.ready; return { family: getComputedStyle(document.querySelector('#main h1')).fontFamily, loaded: [...document.fonts].filter(f => /Fraunces/.test(f.family)).map(f => f.family + ' ' + f.weight + ' ' + f.status), check: document.fonts.check('600 20px Fraunces') }; });
  check('Headings use the heavier serif (Fraunces loaded)', /Fraunces/.test(fontInfo.family) && fontInfo.loaded.some(x => /loaded/.test(x)), JSON.stringify(fontInfo));
  await page.screenshot({ path: `${SHOTS}m-chooser.png`, fullPage: true });

  // ═══════ 8. Reverse — documents unwind through the live transaction ═══════
  section('Reversal unwinds the documents');
  await page.evaluate(id => window.fin.reverse(id, true), payTxn.id);
  await page.waitForTimeout(2500);
  novBillNow = (await docsIn('bills')).find(b => b.id === novBill.id);
  check('Reversing the payment reopens the bill', novBillNow.status === 'open' && near(novBillNow.paid, 0), JSON.stringify(novBillNow));
  await page.evaluate(id => window.fin.reverse(id, true), novTxn.id);
  await page.waitForTimeout(2500);
  novBillNow = (await docsIn('bills')).find(b => b.id === novBill.id);
  subNow = (await docsIn('subscriptions')).find(x => x.id === sub.id);
  check('Reversing the month voids its bill and flags the month', novBillNow.status === 'void' && subNow.charges['2026-11']?.reversed === true, JSON.stringify([novBillNow.status, subNow.charges['2026-11']]));
  await page.evaluate(() => window.fin.go('services'));
  await page.waitForTimeout(500);
  txt = await mainText();
  check('Services now shows November as not recorded', /Nov 2026[\s\S]{0,120}(missing|upcoming)/.test(txt), txt.match(/Nov 2026[\s\S]{0,120}/)?.[0]);

  // ═══════ 8b. Reading a table on a phone ═══════
  section('Tables are readable at 390px');
  await page.evaluate(() => window.fin.go('txns'));
  await page.waitForTimeout(600);
  check('Transactions can show only money that moved', await page.evaluate(() => { const b = [...document.querySelectorAll('#main .seg button')].find(x => /Money moved/.test(x.textContent)); if (!b) return false; b.click(); return true; }));
  await page.waitForTimeout(400);
  check('Every row shown then moved money', await page.evaluate(() => [...document.querySelectorAll('#main table tbody tr')].every(r => !/not yet paid/i.test(r.innerText))));
  await page.evaluate(() => window.fin.filterMoved('all'));
  await page.waitForTimeout(400);
  const tbl = await page.evaluate(() => {
    const t = document.querySelector('#main table');
    if (!t) return { none: true };
    const wrap = t.closest('.tbl-wrap');
    const head = getComputedStyle(t.querySelector('thead'));
    const firstCell = t.querySelector('tbody td.lead');
    const labelled = [...t.querySelectorAll('tbody td[data-label]')];
    const shown = labelled.map(td => getComputedStyle(td, '::before').content).filter(c => c && c !== 'none' && c !== '""');
    const row = t.querySelector('tbody tr');
    return {
      stacks: t.classList.contains('stack'),
      headHidden: head.position === 'absolute' || head.clipPath !== 'none' || head.clip !== 'auto',
      leadIsBlock: firstCell ? getComputedStyle(firstCell).display === 'block' : false,
      labelCount: labelled.length,
      labelsRendered: shown.length,
      overflows: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : false,
      banded: row ? getComputedStyle(t.querySelectorAll('tbody tr')[1] || row).backgroundColor : '',
    };
  });
  check('The transactions table stacks instead of scrolling sideways', tbl.stacks && !tbl.overflows, JSON.stringify(tbl));
  check('Column headings are repeated beside each value', tbl.labelCount > 0 && tbl.labelsRendered === tbl.labelCount, JSON.stringify(tbl));
  check('The description leads each row as its title', tbl.leadIsBlock, JSON.stringify(tbl));
  const flush = await page.evaluate(() => {
    const lead = document.querySelector('#main table tbody td.lead');
    const lbl = document.querySelector('#main table tbody td[data-label]');
    const r = document.createRange(); r.selectNodeContents(lead);
    return { title: Math.round(r.getBoundingClientRect().left), label: Math.round(lbl.getBoundingClientRect().left) };
  });
  check('The title lines up with the values under it', Math.abs(flush.title - flush.label) <= 1, JSON.stringify(flush));
  await page.screenshot({ path: `${SHOTS}m-txns-stacked.png`, fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.fin.go('txns'));
  await page.waitForTimeout(500);
  const wide = await page.evaluate(() => {
    const t = document.querySelector('#main table');
    const th = t.querySelector('thead th');
    const rows = t.querySelectorAll('tbody tr');
    const cell = t.querySelector('tbody td + td');
    return {
      headerSticky: getComputedStyle(th).position === 'sticky',
      headerShaded: getComputedStyle(th).backgroundColor,
      columnRule: getComputedStyle(cell).borderLeftWidth,
      banded: rows.length > 1 ? getComputedStyle(rows[1]).backgroundColor !== getComputedStyle(rows[0]).backgroundColor : true,
    };
  });
  check('On a wide screen the header is shaded and stays put', wide.headerSticky && wide.headerShaded !== 'rgba(0, 0, 0, 0)', JSON.stringify(wide));
  check('Columns are separated by a rule', wide.columnRule !== '0px', JSON.stringify(wide));
  check('Rows are banded so one can be tracked across', wide.banded, JSON.stringify(wide));
  await page.screenshot({ path: `${SHOTS}d-txns-table.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  // 8c. Petty cash scope and the new screens
  section('Petty cash scope');
  await page.evaluate(() => window.fin.setScope('only'));
  await page.evaluate(() => window.fin.go('txns'));
  await page.waitForTimeout(500);
  const scopedTxt = await mainText();
  check('The switch is loud: a banner says the view is filtered', /Petty cash only/i.test(scopedTxt) && !!(await page.$('.scope-banner')));
  check('Only entries through the box remain', !/E2E Claude \(Pro\) — Sept 2026/.test(scopedTxt));
  await page.evaluate(() => window.fin.setScope('without'));
  await page.waitForTimeout(400);
  check('Without: the bank-paid months are back', /E2E Claude \(Pro\) — Sept 2026/.test(await mainText()));
  await page.evaluate(() => window.fin.go('books'));
  await page.waitForTimeout(500);
  check('Books says the statements ignore the switch', /always show everything/.test(await mainText()));
  await page.evaluate(() => window.fin.setScope('with'));
  await page.evaluate(() => window.fin.go('petty'));
  await page.waitForTimeout(500);
  check('Petty cash page renders its four numbers', /In the box now/i.test(await mainText()) && /Last top-up/i.test(await mainText()));
  await page.evaluate(() => window.fin.go('budget'));
  await page.waitForTimeout(500);
  const bud = await mainText();
  check('Budget shows expected against actual from the recurring cost', /E2E Claude/i.test(bud) && /Expected income/i.test(bud), bud.replace(/\s+/g, ' ').slice(0, 300));
  await page.screenshot({ path: `${SHOTS}m-budget.png`, fullPage: true });

  // ═══════ 8b. This month, and the books an accountant reads ═══════
  section('This month');
  await page.evaluate(() => window.fin.go('month'));
  await page.waitForTimeout(600);
  const mth = await mainText();
  check('The page leads with the decision, not the ledger', /can i spend/i.test(mth), mth.replace(/\s+/g, ' ').slice(0, 200));
  check('All five states of a commitment are on the page',
    /paid/i.test(mth) && /invoiced/i.test(mth) && /due this month/i.test(mth) && /already late/i.test(mth) && /still a guess/i.test(mth));
  check('The spendable figure is the one with documents behind it', /left if the invoices land/i.test(mth) && /coming in on invoices/i.test(mth), mth.replace(/\s+/g, ' ').slice(0, 300));
  check('It warns that the buckets overlap', /these boxes overlap on purpose/i.test(mth));
  check('Three months ahead are shown', /if nothing changes/i.test(mth) && /left at month end/i.test(mth));
  check('Money out and money in are separate, then together',
    /money out/i.test(mth) && /money in/i.test(mth) && /together/i.test(mth));
  check('It says plainly that it changes nothing', /nothing here changes your books/i.test(mth));
  check('A bucket opens to show what is inside', await page.evaluate(() => {
    const d = document.querySelector('#main details.bucket');
    if (!d) return false;
    d.open = true;
    return d.querySelector('table, .empty') !== null;
  }));
  check('The month can be stepped back and forth', await page.evaluate(() => {
    const before = document.querySelector('#main h2')?.textContent?.trim();
    window.finMoney.monthShift(-1);
    return before !== null;
  }));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.finMoney.thisMonth());
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}m-month.png`, fullPage: true });

  section('Books');
  await page.evaluate(() => window.fin.go('books'));
  await page.waitForTimeout(700);
  const bk = await mainText();
  for (const [label, re] of [['the check', /the check/i], ['trial balance', /trial balance/i],
    ['profit and loss', /profit and loss/i], ['balance sheet', /balance sheet/i],
    ['ledger', /ledger/i], ['registers', /registers/i], ['general journal', /general journal/i]]) {
    check(`Books has ${label}`, re.test(bk));
  }
  check('The trial balance shows movement as well as position', /opening dr/i.test(bk) && /closing cr/i.test(bk));
  check('The profit statement runs to profit after tax', /gross profit/i.test(bk) && /profit after tax/i.test(bk));
  check('The balance sheet is grouped', /fixed assets/i.test(bk) && /current liabilities/i.test(bk));
  check('The ledger starts from a balance brought forward', /opening balance/i.test(bk));
  check('The trial balance states whether it balances', /balanced|does not balance/i.test(bk));
  check('The period buttons move the whole page', await page.evaluate(() => {
    const from = document.getElementById('bkFrom')?.value;
    window.finReports.period('month');
    return !!from;
  }));
  await page.waitForTimeout(400);
  check('This month narrows the range to the 1st', await page.evaluate(() => /-01$/.test(document.getElementById('bkFrom')?.value || '')));
  await page.evaluate(() => window.finReports.period('fy'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}m-books.png`, fullPage: true });

  // ═══════ 9. Guide ═══════
  section('Guide');
  await page.evaluate(() => { window.fin.go('guide'); window.finGuide.setTab('screens'); });
  await page.waitForTimeout(600);
  const scr = await mainText();
  check('The guide explains every screen', /this month/i.test(scr) && /what to do here/i.test(scr) && /where the figures come from/i.test(scr));
  await page.evaluate(() => window.finGuide.setTab('accounting'));
  await page.waitForTimeout(600);
  const acc = await mainText();
  check('The guide carries a full accounting reference', /chart of accounts/i.test(acc) && /reverse charge/i.test(acc) && /trial balance/i.test(acc));
  check('…with the rule behind each decision', /s.16\(2\)/.test(acc) || /16\(2\)/.test(acc));
  check('…and what the app refuses to do', /will not let you do/i.test(acc));
  await page.evaluate(() => { window.fin.go('guide'); window.finGuide.setTab('scenarios'); });
  await page.waitForTimeout(600);
  txt = await mainText();
  check('Worked examples include the upgrade story and build cleanly', /prorated/.test(txt) && !/could not be built/.test(txt) && !/would refuse this/.test(txt),
    JSON.stringify({ prorated: /prorated/.test(txt), notBuilt: (txt.match(/could not be built[^\n]*/g) || []).slice(0, 3), refuse: (txt.match(/would refuse this[^\n]*/g) || []).slice(0, 5) }) + ' ' + txt.slice(0, 200).replace(/\s+/g, ' '));
  await page.evaluate(() => window.finGuide.find('upgrade'));
  await page.waitForTimeout(400);
  txt = await page.evaluate(() => document.getElementById('main').innerText);
  check('Search narrows the guide', /Worked examples/.test(txt) && /FAQ/.test(txt) && /upgrade/i.test(txt));
  check('Search box keeps focus after rendering', await page.evaluate(() => document.activeElement?.id === 'guideFind'));
  await page.screenshot({ path: `${SHOTS}m-guide.png`, fullPage: true });

  section('Errors');
  check('No page errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('No console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  failed++; failures.push('Uncaught: ' + e.message);
  console.log('  FAIL  uncaught — ' + e.message);
  await page.screenshot({ path: `${SHOTS}m-crash.png`, fullPage: true }).catch(() => {});
}
await browser.close();

// ── put the books back ──────────────────────────────────────────────────────────
section('Cleanup');
let removed = 0;
for (const c of COLLS) {
  for (const d of await newIn(c)) { await root.collection(c).doc(d.id).delete(); removed++; }
}
await root.set({ nextTxnNo: before.nextTxnNo }, { merge: true });
console.log(`  ${removed} test documents removed, counter back to #${before.nextTxnNo}${cleanupNote}`);
const after = (await root.collection('txns').get()).size;
check('Books are exactly as they were', after === before.ids.txns.size, `${after} vs ${before.ids.txns.size}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { failures.forEach(f => console.log('  · ' + f)); process.exit(1); }
process.exit(0);
