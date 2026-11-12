// "Add a deal", reworked: the property links its sellers (and the people who enquired about it),
// the seller / buyer pickers search the CRM's leads next to your clients, the sale price is
// captured, brokerage is a % of the sale or an amount (each fills the other), GST is optional with
// a rate, and the total with GST is worked out. A deal whose side came from the CRM opens that
// lead in a new tab. Needs the repo root served on :5199 (python3 -m http.server 5199).
//
//   node tests/finance-deal-crm-preview.mjs

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
  // python's http.server now and then drops one of the page's many module requests: load again.
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

  await p.evaluate(() => window.fin.record('newdeal'));
  await p.waitForSelector('#pick_seller input');
  const order = await p.$$eval('#evForm > .field', els => els.map(e => e.dataset.field));
  ok('The form, in order: nickname, property, seller, buyer, sale price, brokerage %/amount each side, GST, total',
    order.slice(0, 12).join() === 'nickname,property,seller,buyer,salePrice,sellerPct,expSeller,buyerPct,expBuyer,gst,gstRate,totalWithGst', order);

  // ── The CRM in the seller picker ──
  await p.fill('#pick_seller input', 'ak');
  await p.waitForSelector('#pick_seller .picker-head');
  const rows = await p.$$eval('#pick_seller .picker-results > *', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  ok('Typing "ak": the client Akash once (marked In the CRM), then "From the CRM" with the seller lead Akshaya', rows.filter(r => /Akash Kumar/.test(r)).length === 1 && rows.some(r => /Akash Kumar/.test(r) && /in the crm/i.test(r)) && rows.some(r => /from the crm/i.test(r)) && rows.some(r => /Akshaya Raman/.test(r) && /seller lead/i.test(r) && /Adyar/.test(r)), rows);
  ok('A lead linked by a property id shows no raw id', !rows.some(r => /prop_anr/.test(r)), rows);
  ok('...and "Add" a new name is still there', rows.some(r => /\+ Add "ak"/.test(r)), rows);
  if (name === 'desk') await p.screenshot({ path: 'tests/out/look-deal-crm-picker.png' });
  await p.keyboard.press('Escape');
  await p.fill('#pick_seller input', '');
  await p.click('#f_nickname');
  await p.waitForTimeout(250);

  // ── Link the property: its sellers and enquirers are offered ──
  await p.fill('#pick_property input', 'ANR');
  await p.waitForSelector('#pick_property .picker-results button');
  await p.click('#pick_property .picker-results button:has-text("ANR003")');
  await p.waitForSelector('#sugg_seller .pk-sugg-b');
  ok('Linking the property fills an empty nickname', (await val('#f_nickname')) === 'ANR003 — Anna Nagar 3BHK', await val('#f_nickname'));
  const ss = await p.$$eval('#sugg_seller .pk-sugg-b', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  ok('Sellers of ANR003: the board\'s owner (with her CRM lead) once, and the property\'s contact', ss.length === 2 && /Meenakshi Sundaram/.test(ss[0]) && /Property & Media/.test(ss[0]) && /Swaminathan/.test(ss[1]) && /Contact on the property/.test(ss[1]), ss);
  const bs = await p.$$eval('#sugg_buyer .pk-sugg-b', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  ok('Buyers: the people who enquired about it (Akash — already a client — and Divya)', bs.length === 2 && bs.some(x => /Akash Kumar/.test(x) && /Your client/.test(x)) && bs.some(x => /Divya/.test(x) && /Enquired/.test(x)), bs);
  ok('The sale price hint shows the listed price', /Listed at 1\.85 Cr/.test(await p.innerText('[data-field="salePrice"]')));
  if (name === 'desk') await p.screenshot({ path: 'tests/out/look-deal-property-sellers.png' });
  await p.click('#sugg_seller .pk-sugg-b:has-text("Meenakshi")');
  await p.waitForTimeout(200);
  ok('One click: Meenakshi is the seller, from the CRM; the suggestions go', /Meenakshi Sundaram · 9840066666 · from the CRM/.test(norm(await p.innerText('#pick_seller'))) && await p.$eval('#sugg_seller', e => e.hidden), norm(await p.innerText('#pick_seller')));
  await p.click('#sugg_buyer .pk-sugg-b:has-text("Divya")');
  await p.waitForTimeout(200);

  // ── Sale price, brokerage as % or amount, GST ──
  await type('#f_salePrice', 18000000);
  await type('#f_sellerPct', 1);
  ok('Seller 1% of 1,80,00,000 → 1,80,000', (await val('#f_expSeller')) === '180000', await val('#f_expSeller'));
  await type('#f_expBuyer', 90000);
  ok('Buyer amount 90,000 → 0.5%', (await val('#f_buyerPct')) === '0.5', await val('#f_buyerPct'));
  ok('Total with GST (18%, the default): 2,70,000 + 48,600 = 3,18,600', (await val('#f_totalWithGst')) === '3,18,600', await val('#f_totalWithGst'));
  await type('#f_salePrice', 20000000);
  ok('A new sale price moves the seller\'s % fee to 2,00,000; the buyer\'s typed 90,000 stays (now 0.45%)', (await val('#f_expSeller')) === '200000' && (await val('#f_expBuyer')) === '90000' && (await val('#f_buyerPct')) === '0.45', [await val('#f_expSeller'), await val('#f_expBuyer'), await val('#f_buyerPct')]);
  await p.selectOption('#f_gst', 'no');
  await p.waitForTimeout(200);
  ok('GST off: no GST % asked, the total is the brokerage', !(await p.$('#f_gstRate')) && (await val('#f_totalWithGst')) === '2,90,000', await val('#f_totalWithGst'));
  await p.selectOption('#f_gst', 'yes');
  await p.waitForTimeout(200);
  await type('#f_gstRate', 18);
  ok('GST back on: 2,90,000 + 52,200 = 3,42,200', (await val('#f_totalWithGst')) === '3,42,200', await val('#f_totalWithGst'));
  ok('Total is worked out, not typed', await p.$eval('#f_totalWithGst', e => e.readOnly));
  await p.waitForTimeout(300);
  const fx = norm(await p.innerText('#pvEffects').catch(() => ''));
  ok('The preview: both sides with their %, the sale price, GST and the total', /seller ₹2,00,000 \(1% of the sale\)/.test(fx) && /buyer ₹90,000 \(0\.45% of the sale\)/.test(fx) && /Sale price ₹2,00,00,000/.test(fx) && /₹3,42,200/.test(fx), fx.slice(0, 400));
  await p.screenshot({ path: `tests/out/look-deal-form-${name}.png`, fullPage: true });

  // ── The deal panel ──
  await p.evaluate(() => { window.fin.go('deals'); });
  await p.waitForTimeout(300);
  await p.evaluate(() => window.finDeals.open(window.__st().deals.find(d => d.nickname === 'Akash — ANR003').id));
  await p.waitForSelector('a.crm-open');
  const a = await p.$eval('a.crm-open', x => ({ href: x.getAttribute('href'), t: x.target }));
  ok('Deal panel: "Open in CRM" for the side from the CRM, in a new tab', a.href === '/crm.html?lead=tt_t_preview_1' && a.t === '_blank', a);
  const card = norm(await p.innerText('.deal-sides'));
  ok('...sale price, the buyer\'s %, and brokerage + GST = total', /Sale price ₹1,80,00,000/.test(card) && /1% of the sale/.test(card) && /₹1,80,000 \+ 18% GST ₹32,400 = ₹2,12,400/.test(card), card);
  await type('#dl_sale', 20000000);
  ok('Editing the sale price in the panel moves the % fee', (await val('#dl_expb')) === '200000' && /₹2,36,000/.test(await p.innerText('#dl_total')), [await val('#dl_expb'), await p.innerText('#dl_total')]);
  await p.screenshot({ path: `tests/out/look-deal-panel-${name}.png`, fullPage: true });
  await p.evaluate(() => window.fin.closeModal());

  // ── Registered: the closed price is asked, and a % fee follows it ──
  await p.evaluate(() => window.fin.record('register', { deal: window.__st().deals.find(d => d.nickname === 'Akash — ANR003').id }));
  await p.waitForSelector('#f_salePrice');
  ok('Mark registered asks for the closed sale price, starting from the deal\'s', (await val('#f_salePrice')) === '18000000', await val('#f_salePrice'));
  await type('#f_salePrice', 19000000);
  await p.waitForTimeout(300);
  const rfx = norm(await p.innerText('#pvEffects'));
  ok('...and says the buyer\'s 1% is now ₹1,90,000', /Closed at ₹1,90,00,000/.test(rfx) && /buyer brokerage now ₹1,90,000/.test(rfx), rfx.slice(0, 400));

  // ── The invoice starts from the deal's GST ──
  await p.evaluate(() => window.fin.record('invoice', { deal: window.__st().deals.find(d => d.nickname === 'Karthik — Nungambakkam 2BHK').id }));
  await p.waitForTimeout(300);
  ok('No page errors', !errs.length, errs);
  await p.close();
}
await b.close();
console.log(bad ? `\n${bad} failed.` : '\nAll good.');
process.exit(bad ? 1 : 0);
