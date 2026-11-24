// Properties tab: the "Check what I understood" form, Read with AI, filters, sort, ruled out,
// breakdown, Share, Open, Matching clients.
import { smart, read, summary, shot, errorsOf, mask, timed, settle } from './_h.mjs';

export default async function ({ S, admin, OUT, log }) {
  const page = admin.page;
  await page.goto(S.BASE + '/match.html');
  await page.waitForSelector('#q');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  // The same words on the Properties tab must stay a properties search.
  for (const q of ['plot in Kundrathur under 50 L', '2 BHK for rent Alwarpet 45000', 'need a 3 BHK for my client in Anna Nagar 3 Cr', 'Client wants 2 BHK in Porur under 1 Cr']) {
    await page.check('#forSeg input[value=properties]');
    const t = await smart(page, q);
    const r = await read(page);
    log(`\n▶ [props tab] "${q}" → mode=${t.body && t.body.mode} tab after=${r.tab} ${t.ms}ms`);
    log(summary(r, 4));
  }

  // Tab follows a result: search on the props tab, get switched to clients; next search's meaning changes.
  await page.check('#forSeg input[value=properties]');
  await smart(page, '2 BHK in Anna Nagar under 2 Cr');
  log('\n▶ baseline', summary(await read(page), 3));

  // ── The form ──
  const open = await page.evaluate(() => document.getElementById('refine').open);
  log('refine open by default:', open);
  await page.click('#refine > summary');
  const form = await page.evaluate(() => ({ deal: iDeal.value, loc: iLoc.value, ex: iEx.value, bmin: iBMin.value, bmax: iBMax.value, unit: iBUnit.value, flex: iBFlex.value,
    bhk: [...document.querySelectorAll('input[name=bhk]:checked')].map(i => i.value), types: [...document.querySelectorAll('input[name=types]:checked')].map(i => i.value) }));
  log('form after search:', JSON.stringify(form));
  await shot(page, OUT, 'p20-01-form');
  // Change budget to 1.5 Cr, add Kilpauk, exclude Mogappair, tick Apartment.
  await page.fill('#iBMax', '1.5 Cr');
  await page.fill('#iLoc', 'Anna Nagar, Kilpauk');
  await page.fill('#iEx', 'Mogappair');
  await page.check('input[name=types][value=apartment]');
  let t = await timed(page, () => page.click('#itemForm button[type=submit]'));
  let r = await read(page);
  log(`\n▶ form search (1.5 Cr, Anna Nagar+Kilpauk, not Mogappair, apartment) ${t.ms}ms sent item=${JSON.stringify(t.body && t.body.reading)}`.slice(0, 900));
  log(summary(r, 8));
  log('form after form-search:', JSON.stringify(await page.evaluate(() => ({ loc: iLoc.value, ex: iEx.value, bmax: iBMax.value }))));
  log('url:', page.url().replace(/^.*match\.html/, 'match.html'));
  const overBudget = (t.body.rows || []).filter(x => x.priceLo && x.priceLo > 15000000 * 1.3).map(x => `${x.pct}% ${x.name} ${x.price}`);
  log('rows priced >1.95 Cr:', mask(overBudget.slice(0, 8).join(' | ')));
  const mog = (t.body.rows || []).filter(x => /mogappair/i.test(x.location || '')).map(x => x.name + ' ' + x.pct + (x.vetoed ? ' vetoed' : ''));
  log('Mogappair rows (should be none):', mask(mog.join(' | ')));
  const nonApt = (t.body.rows || []).filter(x => x.type && !/apart/i.test(x.type)).map(x => `${x.pct}% ${x.type} ${x.name}`);
  log('non-apartment rows:', mask(nonApt.slice(0, 8).join(' | ')));
  await shot(page, OUT, 'p20-02-form-search', true);

  // Money edge cases in the form: "45" as rent, "80" as total, "1,20,000"
  await page.selectOption('#iDeal', 'rent');
  await page.selectOption('#iBUnit', 'per_month');
  await page.fill('#iBMax', '45');
  await page.fill('#iLoc', 'Alwarpet');
  await page.fill('#iEx', '');
  t = await timed(page, () => page.click('#itemForm button[type=submit]'));
  log(`\n▶ form rent 45 per month Alwarpet → chips: ${(await read(page)).chips}`);
  log(summary(await read(page), 4));

  // Clear, then submit empty
  await page.click('#itemClear');
  await page.click('#itemForm button[type=submit]');
  await page.waitForTimeout(300);
  log('empty form submit note:', await page.textContent('#aiNote'));

  // ── Read with AI (no AI key here) ──
  await page.fill('#q', '3 BHK in Adyar or Besant Nagar, 4 Cr, ready to move, not OMR');
  t = await timed(page, () => page.click('#aiRead'));
  log('\n▶ Read with AI: status', t.status, 'note:', await page.textContent('#aiNote'), '| aiError:', t.body && t.body.aiError);
  log('  form after AI:', JSON.stringify(await page.evaluate(() => ({ loc: iLoc.value, ex: iEx.value, bmax: iBMax.value, flex: iBFlex.value, poss: iPoss.value, bhk: [...document.querySelectorAll('input[name=bhk]:checked')].map(i => i.value) }))));
  log('  ai took', t.ms, 'ms');
  await shot(page, OUT, 'p20-03-ai');

  // ── Filters on a broad search ──
  await smart(page, '3 BHK Anna Nagar 3 Cr');
  const base = await read(page);
  log('\n▶ filters base:', base.count);
  await page.click('#filterBtn');
  const F = async (label, fn, undo) => {
    await fn();
    await page.waitForTimeout(450);
    await settle(page);
    const rr = await read(page);
    const sn = S.calls.filter(c => c.path === '/api/match').slice(-1)[0];
    log(`  filter ${label}: ${rr.count} | badge=${await page.evaluate(() => filterN.hidden ? '-' : filterN.textContent)} | top: ${mask(rr.rows.slice(0, 3).map(x => x.name + ' ' + x.score + ' ' + (x.src || '')).join(' || '))}`);
    if (undo) { await undo(); await page.waitForTimeout(450); await settle(page); }
    return rr;
  };
  for (const v of ['Apartment', 'Villa', 'House', 'Plot', 'Commercial']) await F('type=' + v, () => page.check(`input[name=fType][value=${v}]`), () => page.uncheck(`input[name=fType][value=${v}]`));
  for (const v of ['onboarded', 'listing', 'seller', 'submission']) {
    const rr = await F('src=' + v, () => page.check(`input[name=fSrc][value=${v}]`), () => page.uncheck(`input[name=fSrc][value=${v}]`));
    const bad = rr.rows.filter(x => x.src && v === 'onboarded' && !/Onboarded/.test(x.src));
    if (bad.length) log('    WRONG source rows:', bad.length);
  }
  for (const v of ['sale', 'rent', 'jv']) await F('deal=' + v, () => page.check(`input[name=fDeal][value=${v}]`), () => page.uncheck(`input[name=fDeal][value=${v}]`));
  for (const v of ['2', '3', '4', '5']) await F('bhk=' + v, () => page.check(`input[name=fBhk][value="${v}"]`), () => page.uncheck(`input[name=fBhk][value="${v}"]`));
  await F('location=Shenoy', () => page.fill('#fLoc', 'Shenoy'), () => page.fill('#fLoc', ''));
  await F('location=anna nagar west', () => page.fill('#fLoc', 'anna nagar west'), () => page.fill('#fLoc', ''));
  await F('price 2 Cr–3 Cr', async () => { await page.fill('#fBMin', '2 Cr'); await page.fill('#fBMax', '3 Cr'); }, async () => { await page.fill('#fBMin', ''); await page.fill('#fBMax', ''); });
  await F('price "50" (bare)', () => page.fill('#fBMax', '50'), () => page.fill('#fBMax', ''));
  await F('size 1200–1600', async () => { await page.fill('#fAMin', '1200'); await page.fill('#fAMax', '1600'); }, async () => { await page.fill('#fAMin', ''); await page.fill('#fAMax', ''); });
  for (const v of ['70', '85']) await F('min=' + v, () => page.selectOption('#fMin', v), () => page.selectOption('#fMin', ''));
  await F('combo apartment+onboarded+3bhk+min70', async () => { await page.check('input[name=fType][value=Apartment]'); await page.check('input[name=fSrc][value=onboarded]'); await page.check('input[name=fBhk][value="3"]'); await page.selectOption('#fMin', '70'); });
  await shot(page, OUT, 'p20-04-filters-combo', true);
  await page.click('#fClear');
  await page.waitForTimeout(500); await settle(page);
  log('  after Clear filters:', (await read(page)).count, 'badge hidden:', await page.evaluate(() => filterN.hidden));

  // Show ruled out
  await page.check('#fOut');
  await page.waitForTimeout(500); await settle(page);
  r = await read(page);
  const outs = r.rows.filter(x => x.out);
  log(`\n▶ show ruled out: ${r.count}, ${outs.length} ruled-out rows shown; first ruled-out: ${mask(outs.slice(0, 4).map(x => x.name + ' | ' + x.score + ' | ' + x.why.filter(w => /Ruled out/.test(w)).join(' / ')).join(' || '))}`);
  const lastNonOut = r.rows.map((x, i) => x.out ? -1 : i).filter(i => i >= 0).pop();
  const firstOut = r.rows.findIndex(x => x.out);
  log('  ruled-out rows come after all others:', firstOut === -1 || firstOut > lastNonOut);
  await shot(page, OUT, 'p20-05-ruled-out', true);
  await page.uncheck('#fOut');
  await page.waitForTimeout(500); await settle(page);

  // Sort
  for (const v of ['score', 'location', 'budget', 'recent', 'newest', 'confidence']) {
    await page.selectOption('#sort', v);
    await page.waitForTimeout(450); await settle(page);
    const rr = await read(page);
    const pcts = rr.rows.slice(0, 12).map(x => parseInt(x.score));
    log(`  sort ${v}: ${pcts.join(',')} | ${mask(rr.rows.slice(0, 4).map(x => x.name.slice(0, 30) + ' ' + (x.fits || '').slice(0, 60)).join(' || '))}`);
  }
  await page.selectOption('#sort', 'score');
  await page.waitForTimeout(450); await settle(page);

  // Breakdown open/close
  const first = page.locator('#list > li').first();
  await first.locator('details.mt-more > summary').click();
  log('\n▶ breakdown open:', mask((await first.locator('details.mt-more').innerText()).replace(/\s+/g, ' ').slice(0, 900)));
  await shot(page, OUT, 'p20-06-breakdown');
  await first.locator('details.mt-more > summary').click();
  log('  breakdown closed:', !(await first.locator('details.mt-more').evaluate(d => d.open)));

  // Share
  await first.locator('button[data-act=share]').click();
  await page.waitForTimeout(300);
  log('  share copied:', mask(await page.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e.message))));

  // Open links
  const links = await page.$$eval('#list .mt-acts a', as => as.map(a => a.textContent.trim() + ' → ' + a.getAttribute('href')));
  log('  open links sample:', mask([...new Set(links.map(l => l.replace(/=.*/, '=…')))].join(' | ')));
  // Follow one property link and one Shoot card link: does the target page open that record?
  for (const sel of ['a[href^="dashboard.html?property="]', 'a[href^="propertytrack.html?listing="]', 'a[href^="crm.html?lead="]']) {
    const href = await page.$eval('#list ' + sel, a => a.getAttribute('href')).catch(() => null);
    if (!href) { log('  no link', sel); continue; }
    const p2 = await page.context().newPage();
    p2.__errors = [];
    p2.on('pageerror', e => p2.__errors.push(e.message));
    await p2.goto(S.BASE + '/' + href);
    await p2.waitForTimeout(6000);
    const vis = await p2.evaluate(() => {
      const t = s => [...document.querySelectorAll(s)].filter(e => e.offsetParent).map(e => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 120));
      return { title: document.title, dialogs: t('[role=dialog], .modal.open, .detail-panel.open, #detailPanel, .dp, .lead-panel, aside.open').slice(0, 3) };
    });
    log(`  follow ${href.replace(/=.*/, '=…')}: ${mask(JSON.stringify(vis)).slice(0, 400)} errors=${p2.__errors.slice(0, 2).join(' | ')}`);
    await p2.screenshot({ path: OUT + '/p20-07-follow-' + href.split('.')[0] + '.png' });
    await p2.close();
  }

  // Matching clients button on a property row
  const mb = page.locator('#list button[data-act=buyers]').first();
  const pname = await page.locator('#list > li').first().locator('h3').innerText();
  t = await timed(page, () => mb.click());
  r = await read(page);
  log(`\n▶ Matching clients for "${mask(pname)}": ${t.ms}ms tab=${r.tab}`, summary(r, 5));
  log('  url:', page.url().replace(/^.*match\.html/, 'match.html').replace(/\d{6,}/g, '#'));
  // Back to Properties tab — what is on screen?
  await page.check('#forSeg input[value=properties]');
  r = await read(page);
  log('  after clicking Properties tab: results hidden=', r.resultsHidden, 'readAs shown=', await page.evaluate(() => !readAs.hidden));
  log('errors:', mask((await errorsOf(page)).join(' | ')));
}
