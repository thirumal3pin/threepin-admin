// Builders, in the browser: the Builders tab (per builder and project, the closed bookings not
// yet invoiced), a deal recorded against a builder's project from a tagged property code, closed
// and invoiced in one go, and the builder's deal panel. Desktop and phone.
// Needs the repo root served on :5199 (python3 -m http.server 5199).
//
//   node tests/finance-builders-preview.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/out', { recursive: true });
let bad = 0;
const ok = (label, cond, detail) => { console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || detail === undefined ? '' : ' — ' + JSON.stringify(detail))); if (!cond) bad++; };
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

const b = await chromium.launch({ channel: 'chrome' });
for (const [name, width] of [['desk', 1280], ['phone', 390]]) {
  const p = await b.newPage({ viewport: { width, height: 1000 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  for (let attempt = 1; ; attempt++) {
    await p.goto('http://127.0.0.1:5199/tests/app-preview.html', { waitUntil: 'networkidle' });
    const ready = await p.waitForFunction(() => window.__ready === true, { timeout: 15000 }).then(() => true, () => false);
    if (ready) break;
    if (attempt === 3) throw new Error('The preview page did not load: ' + errs.join(' | '));
    errs.length = 0;
  }
  console.log('── ' + name);
  const val = sel => p.$eval(sel, e => e.value);
  const type = async (sel, v) => { await p.fill(sel, ''); await p.type(sel, String(v)); await p.waitForTimeout(80); };
  ok('The sample books load without errors', !(await p.evaluate(() => window.__seedErrors || [])).length, await p.evaluate(() => window.__seedErrors));

  // ── The Builders tab ──
  await p.evaluate(() => { window.fin.go('deals'); });
  await p.waitForTimeout(200);
  // Everything but Record sits behind the passcode, as on the real page.
  if (await p.$('#pinInput')) { await p.fill('#pinInput', '1313'); await p.press('#pinInput', 'Enter'); await p.waitForTimeout(200); }
  await p.evaluate(() => window.finDeals.tab('builders'));
  await p.waitForSelector('.bld');
  const page = norm(await p.innerText('body'));
  ok('Stats: 3 builder deals, 2 closed', /Builder deals\s*3/i.test(page) && /2 closed · 1 open/.test(page), page.slice(0, 400));
  ok('Closed, not invoiced: Venkat\'s Somerset booking, with its commission (3% of 95 L)', /Closed, not invoiced \(1\)/i.test(page) && /Venkat — Somerset B-402/.test(page) && /₹2,85,000/.test(page), page.slice(0, 900));
  const cards = await p.$$eval('.bld', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const pur = cards.find(c => /Purvankara/.test(c)) || '';
  const shr = cards.find(c => /Shriram/.test(c)) || '';
  ok('Purvankara: no GSTIN warned; Somerset 1 closed, Windermere 1 closed and invoiced', /No GSTIN on file/.test(pur) && /Somerset/.test(pur) && /Windermere/.test(pur) && /invoiced ₹2,70,000/.test(pur), pur);
  ok('Shriram: Kinglife with its code KOY0003 and 1 open deal', /Kinglife/.test(shr) && /KOY0003/.test(shr) && /0 closed · 1 open/.test(shr) && !/No GSTIN/.test(shr), shr);
  await p.screenshot({ path: `tests/out/look-builders-${name}.png`, fullPage: true });

  // ── Invoice straight from the list ──
  await p.click('button:has-text("Invoice Purvankara")');
  await p.waitForSelector('#f_amt');
  ok('"Invoice Purvankara" opens the invoice at the commission, GST on', rawNum(await val('#f_amt')) === 285000 && (await val('#f_gst')) === 'yes', await val('#f_amt'));
  await p.waitForTimeout(300);

  // ── The builder and project forms ──
  await p.evaluate(() => window.fin.pick());   // leave the invoice form unsaved
  await p.waitForTimeout(150);
  await p.evaluate(() => { window.fin.go('deals'); });
  await p.waitForTimeout(150);
  await p.evaluate(() => window.finDeals.editProject('b_shriram', 'pj_kinglife'));
  await p.waitForSelector('#pj_codes');
  ok('A project keeps its property codes and its %', (await val('#pj_codes')) === 'KOY0003' && (await val('#pj_pct')) === '2.5');
  await p.evaluate(() => window.fin.closeModal());
  await p.evaluate(() => window.finDeals.editBuilder());
  await p.waitForSelector('#b_gstin');
  ok('Add a builder: GSTIN, billing address, PAN, default commission — and "Already one of your clients?"', !!(await p.$('#b_address')) && !!(await p.$('#b_pan')) && !!(await p.$('#b_commission')) && !!(await p.$('#b_existing')));
  if (name === 'desk') await p.screenshot({ path: 'tests/out/look-builder-form.png' });
  await p.evaluate(() => window.fin.closeModal());

  // ── A deal from a property tagged to a project ──
  await p.evaluate(() => window.fin.record('newdeal'));
  await p.waitForSelector('#pick_property input');
  ok('Who is selling: an owner by default (the seller picker shows)', (await val('#f_sellerKind')) === 'owner' && !!(await p.$('#pick_seller')));
  await p.fill('#pick_property input', 'KOY');
  await p.waitForSelector('#pick_property .picker-results button');
  await p.click('#pick_property .picker-results button:has-text("KOY0003")');
  await p.waitForSelector('#f_builder');
  ok('Linking KOY0003: a builder deal — Shriram, Kinglife, 2.5% — and no owner picker', (await val('#f_sellerKind')) === 'builder' && (await val('#f_builder')) === 'b_shriram' && (await val('#f_project')) === 'pj_kinglife' && (await val('#f_sellerPct')) === '2.5' && !(await p.$('#pick_seller')));
  await type('#f_unit', 'C-905');
  await type('#f_salePrice', 12000000);
  ok('Agreement value 1.2 Cr → commission 3,00,000', (await val('#f_expSeller')) === '300000', await val('#f_expSeller'));
  ok('The nickname fills itself from the project and unit', (await val('#f_nickname')) === 'Kinglife C-905', await val('#f_nickname'));
  const labels = norm(await p.innerText('#evForm'));
  ok('Builder wording: "Agreement value", "Builder commission"', /Agreement value/.test(labels) && /Builder commission — % of agreement value/.test(labels));
  await p.selectOption('#f_stage', 'invoice');
  await p.waitForSelector('#f_dueDate');
  await p.waitForTimeout(300);
  const fx = norm(await p.innerText('#pvEffects').catch(() => ''));
  ok('Closed and invoiced now: the preview shows the deal closed and the builder\'s income and GST', /recorded as closed/.test(fx) && /Builder deal: Shriram Properties · Kinglife · unit C-905/.test(fx) && /₹3,00,000/.test(fx) && /GST/.test(fx), fx.slice(0, 500));
  await p.screenshot({ path: `tests/out/look-builder-deal-form-${name}.png`, fullPage: true });

  // ── A builder deal's panel ──
  await p.evaluate(() => window.fin.go('deals'));
  await p.waitForTimeout(200);
  await p.evaluate(() => { window.finDeals.tab('pipeline'); window.finDeals.open(window.__st().deals.find(d => d.nickname === 'Venkat — Somerset B-402').id); });
  await p.waitForSelector('.deal-sides');
  const card = norm(await p.innerText('.deal-sides'));
  ok('Deal panel: "Builder", the project and unit, the buyer\'s invoice optional', /Builder Purvankara/.test(card) && /Somerset · Unit B-402/.test(card) && /invoice optional/i.test(card), card);
  ok('…"Invoice the builder", and the project and unit editable', !!(await p.$('button:has-text("Invoice the builder")')) && (await val('#dl_proj')) === 'pj_somerset' && (await val('#dl_unit')) === 'B-402');
  await p.screenshot({ path: `tests/out/look-builder-panel-${name}.png`, fullPage: true });
  await p.evaluate(() => window.fin.closeModal());

  ok('No page errors', !errs.length, errs);
  await p.close();
}
function rawNum(s) { return Number(String(s).replace(/,/g, '')); }
await b.close();
console.log(bad ? `\n${bad} failed.` : '\nAll good.');
process.exit(bad ? 1 : 0);
