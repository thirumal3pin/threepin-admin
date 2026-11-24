// Re-checks for the page fixes, a touch phone pass (390×844, hasTouch) and the Shoot card's Match link.
import { smart, read, summary, shot, errorsOf, mask, timed, settle, hscroll } from './_h.mjs';

export default async function ({ S, live, seeded, admin, OUT, open, log }) {
  const page = admin.page;
  await page.goto(S.BASE + '/match.html');
  await page.waitForSelector('#q');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  // 1. "my client …" on the Properties tab → note + redo button
  let t = await smart(page, 'need a 3 BHK for my client in Anna Nagar 3 Cr');
  let r = await read(page);
  log('1. mode', t.body.mode, '| note:', r.note);
  const redo = page.locator('#resNote [data-redo]');
  if (await redo.count()) { t = await timed(page, () => redo.click()); r = await read(page); log('   after redo: mode', t.body.mode, r.tab, r.count, '| chips:', r.chips); }
  await shot(page, OUT, 'p70-01-redo', true);

  // 2. Tab parking: results come back
  await smart(page, '3 BHK Anna Nagar 3 Cr');
  const c1 = (await read(page)).count;
  // The toggle re-runs the same words the other way round (and back again).
  await page.check('#forSeg input[value=clients]'); await settle(page);
  const hid = await page.evaluate(() => results.hidden);
  await page.check('#forSeg input[value=properties]'); await settle(page);
  log('2. hidden on clients tab:', hid, '| back on props: hidden=', await page.evaluate(() => results.hidden), 'count same=', (await read(page)).count === c1);

  // 3. Show ruled out now shows them
  await page.click('#filterBtn');
  await page.check('#fOut');
  await page.waitForTimeout(500); await settle(page);
  r = await read(page);
  const outs = r.rows.filter(x => x.out);
  log('3. ruled out shown:', outs.length, '| note:', r.note, '| first:', mask(outs.slice(0, 3).map(x => x.name + ' — ' + x.why.filter(w => /Ruled out/i.test(w)).join(' / ')).join(' || ')));
  await outs.length && page.locator('#list > li.out').first().scrollIntoViewIfNeeded();
  await shot(page, OUT, 'p70-03-ruled-out');
  await page.uncheck('#fOut');
  await page.waitForTimeout(500); await settle(page);

  // 4. Share text
  await page.locator('#list button[data-act=share]').first().click();
  await page.waitForTimeout(300);
  log('4. share:', mask(await page.evaluate(() => navigator.clipboard.readText())).replace(/\n/g, ' ⏎ '));

  // 5. Rent "25" in the describe form
  await page.check('#forSeg input[value=clients]');
  await page.evaluate(() => { refine.open = true; });
  await page.selectOption('#dType', 'Apartment'); await page.selectOption('#dBhk', '2'); await page.fill('#dLoc', 'Velachery'); await page.fill('#dPrice', '25'); await page.selectOption('#dDeal', 'rent');
  t = await timed(page, () => page.click('#detailsForm button[type=submit]'));
  log('5. rent 25 →', JSON.stringify(t.body.about));

  // 6. Bad code / deep links messages
  await page.fill('#q', 'ZZZ999');
  await timed(page, () => page.click('#qGo'));
  log('6. bad code:', (await read(page)).count);
  for (const qs of ['?listing=lst_nope', '?seller=nope']) {
    await page.goto(S.BASE + '/match.html' + qs); await page.waitForTimeout(300); await settle(page);
    log('   ', qs, '→', (await read(page)).count);
  }

  // 7. Pick after a properties search: no stale "Check what I understood"
  await page.goto(S.BASE + '/match.html');
  await page.waitForSelector('#q');
  await smart(page, '3 BHK Anna Nagar 3 Cr');
  await smart(page, 'Zyxwvut Qwerty');
  log('7. after a pick: refine title=', await page.textContent('#readAs'), '| readBox hidden=', await page.evaluate(() => readBox.hidden));

  // 8. #requirements opens the editor
  const lead = live.leads.find(l => l.id === seeded.rameezLeads[1]);
  await page.goto(S.BASE + '/match.html?lead=' + encodeURIComponent(lead.id) + '#requirements');
  await page.waitForTimeout(500); await settle(page); await page.waitForTimeout(800);
  log('8. #requirements → editor open:', await page.evaluate(() => !reqEditor.hidden));
  await shot(page, OUT, 'p70-08-requirements-hash', true);
  log('   errors:', mask((await errorsOf(page)).filter(e => !/Listen\/channel/.test(e)).join(' | ')));

  // 9. A touch phone (agent): every tab, targets, overflow
  const { ctx, page: ph } = await S.as('rameez', { viewport: { width: 390, height: 844 }, touch: true });
  await ph.goto(S.BASE + '/match.html');
  await ph.waitForSelector('#q');
  const small = async label => {
    const s = await ph.$$eval('#main button, #main a, #main select, #main input, #main summary, #main label.chk', els => els.filter(e => e.offsetParent && getComputedStyle(e).visibility !== 'hidden').map(e => {
      const b = e.getBoundingClientRect(); const lab = e.closest('label');
      const lb = lab ? lab.getBoundingClientRect() : b;
      return { t: (e.textContent || e.value || e.getAttribute('aria-label') || e.type || '').trim().replace(/\s+/g, ' ').slice(0, 22), h: Math.round(Math.max(b.height, lb.height)), w: Math.round(Math.max(b.width, lb.width)), tag: e.tagName };
    }).filter(x => x.h < 44 && !(x.tag === 'INPUT' && x.h >= 18 && x.w >= 18 && false)));
    log(`9. [${label}] targets under 44px tall: ${s.length} ${JSON.stringify(s.slice(0, 10))} | hscroll=${await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)}`);
  };
  await small('start');
  await ph.fill('#q', '3 BHK in Anna Nagar under 3 Cr');
  await ph.tap('#qGo');
  await settle(ph);
  await ph.tap('#refine > summary');
  await ph.tap('#filterBtn');
  await small('props results + refine + filters open');
  await shot(ph, OUT, 'p70-09-touch-props', true);
  await ph.evaluate(() => document.getElementById('filters').close());   // the drawer is modal: close it first
  await ph.check('#forSeg input[value=clients]');
  await small('clients tab');
  await ph.fill('#q', 'ANR003');
  await ph.tap('#qGo');
  await settle(ph);
  await small('clients results');
  await shot(ph, OUT, 'p70-09-touch-clients', true);
  // Long names / no overflow on narrow cards
  const wide = await ph.$$eval('#list *', els => els.filter(e => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible' && e.clientWidth > 0).slice(0, 5).map(e => e.className + ':' + e.textContent.slice(0, 40)));
  log('   overflowing elements in cards:', mask(JSON.stringify(wide)));
  await ctx.close();

  // 10. Shoot card buyers panel → Open in Match
  const p2 = await page.context().newPage();
  const lst = live.listings.find(x => x.location && x.askingPrice && x.stageId === 'new_listing' && /anna nagar|adyar|porur/i.test(x.location));
  await p2.goto(S.BASE + '/propertytrack.html?listing=' + encodeURIComponent(lst.id));
  await p2.waitForTimeout(9000);
  const link = await p2.evaluate(() => { const a = [...document.querySelectorAll('a[href^="match.html?listing="]')][0]; if (a) a.scrollIntoView(); return a ? a.textContent.trim() + ' → ' + a.getAttribute('href').replace(/=.*/, '=…') : 'none'; });
  log('10. propertytrack card Open in Match:', link);
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: OUT + '/p70-10-track-open-in-match.png' });
  await p2.close();
}
