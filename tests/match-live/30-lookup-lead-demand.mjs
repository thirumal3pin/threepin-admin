// Name / phone lookup → pick list → lead mode; a seller's name; demand lists.
import { smart, read, summary, shot, errorsOf, mask, timed, settle } from './_h.mjs';

export default async function ({ S, live, admin, OUT, log }) {
  const page = admin.page;
  await page.goto(S.BASE + '/match.html');
  await page.waitForSelector('#q');
  // The toggle is remembered from the last visit: names are looked up as clients on Find properties.
  await page.check('#forSeg input[value=properties]');
  const open = l => l.stageId !== 'closed_lost';
  const buyer = live.leads.find(l => open(l) && !/seller|vendor/i.test(l.enquiryType || '') && /^[A-Za-z]{4,} [A-Za-z]{4,}$/.test((l.name || '').trim()) && (l.propertyInterest || '').length > 10 && (l.phone || '').replace(/\D/g, '').length >= 10);
  const first = buyer.name.split(' ')[0];
  const sameFirst = live.leads.filter(l => (l.name || '').toLowerCase().split(/\s+/).some(w => w.startsWith(first.toLowerCase()))).length;
  const digits = buyer.phone.replace(/\D/g, '');
  log(`buyer: ${buyer.name} (first name shared by ${sameFirst} leads) interest="${mask(buyer.propertyInterest).slice(0, 120)}" stage=${buyer.stageId}`);
  const lost = live.leads.find(l => l.stageId === 'closed_lost' && /^[A-Za-z]{4,} [A-Za-z]{3,}$/.test((l.name || '').trim()));
  const seller = live.leads.find(l => /seller/i.test(l.enquiryType || '') && open(l) && /^[A-Za-z]{4,}( [A-Za-z]{2,})?$/.test((l.name || '').trim()) && live.listings.some(x => x.leadId === l.id && x.location));
  log(`seller: ${seller && seller.name}; lost client: ${lost && lost.name}`);

  const cases = [
    ['first name', first], ['full name', buyer.name], ['lowercase full name', buyer.name.toLowerCase()], ['last 5 digits', digits.slice(-5)], ['last 4 digits', digits.slice(-4)],
    ['full phone', digits.slice(-10)], ['phone with spaces', digits.slice(-10, -5) + ' ' + digits.slice(-5)], ['nonexistent', 'Zyxwvut Qwerty'],
    ['lost client name', lost ? lost.name : 'x'], ['seller name', seller ? seller.name : 'x'], ['client: prefix', 'client ' + buyer.name],
  ];
  for (const [label, q] of cases) {
    const t = await smart(page, q);
    const r = await read(page);
    const hit = r.rows.some(x => x.pick && x.pick.includes(buyer.name));
    log(`\n▶ ${label}: mode=${t.body && t.body.mode} ${t.ms}ms rows=${r.rows.length} buyer listed=${hit}`);
    log(summary(r, 5));
  }
  await shot(page, OUT, 'p30-01-pick', true);

  // Click the buyer in the pick list → lead mode (one match goes straight there by itself)
  let t = await smart(page, buyer.name);
  if (await page.evaluate(() => leadBox.hidden)) t = await timed(page, () => page.locator('#list [data-pick-lead]').filter({ hasText: buyer.name }).first().click());
  let r = await read(page);
  const lb = await page.evaluate(() => ({ hidden: leadBox.hidden, title: leadTitle.textContent, reviewed: leadReviewed.textContent, line: leadLine.textContent, reqs: leadReqs.innerText.replace(/\s+/g, ' '), refineHidden: refine.hidden }));
  log(`\n▶ clicked buyer → ${t.ms}ms url=${page.url().includes('lead=') ? 'has ?lead' : page.url()}`);
  log('  leadBox:', mask(JSON.stringify(lb)));
  log(summary(r, 6));
  await shot(page, OUT, 'p30-02-lead-mode', true);

  // Seller → buyers for their property
  if (seller) {
    await smart(page, seller.name);
    const btn = page.locator('#list [data-pick-lead][data-seller="1"]').first();
    if (await btn.count()) {
      t = await timed(page, () => btn.click());
      r = await read(page);
      log(`\n▶ seller "${seller.name}" → buyers ${t.ms}ms`, summary(r, 5));
      const sellersAsBuyers = (t.body.rows || []).filter(x => /seller|vendor/i.test(x.enquiryType || '') || /seller/i.test(x.leadSource || ''));
      log('  rows that look like sellers:', sellersAsBuyers.length);
      await shot(page, OUT, 'p30-03-seller-buyers', true);
    } else log('  seller not shown as a seller in the pick list', summary(await read(page), 4));
  }

  // Demand
  // The examples sit on Find clients, and give way once results show: a fresh page each time.
  for (const eg of ['Seller leads with buyers', 'Shoot board with buyers']) {
    await page.goto(S.BASE + '/match.html'); await page.waitForSelector('#q');
    await page.check('#forSeg input[value=clients]');
    t = await timed(page, () => page.locator('.mt-eg [data-eg]').filter({ hasText: eg }).click());
    r = await read(page);
    log(`\n▶ demand "${eg}": ${t.ms}ms (server ${t.serverMs}) mode=${t.body && t.body.mode} scope=${t.body && t.body.scope}`);
    log(summary(r, 8));
    const srcs = (t.body.rows || []).reduce((o, x) => { o[x.property.source + ':' + x.property.status] = (o[x.property.source + ':' + x.property.status] || 0) + 1; return o; }, {});
    log('  sources/status:', JSON.stringify(srcs));
    await shot(page, OUT, 'p30-04-demand-' + eg.split(' ')[0], true);
    const sb = page.locator('#list button[data-act=demand-buyers]').first();
    if (await sb.count()) {
      const nm = await page.locator('#list > li h3').first().innerText();
      const expect = await page.locator('#list > li .mt-score b').first().innerText();
      t = await timed(page, () => sb.click());
      r = await read(page);
      log(`  See buyers for "${mask(nm)}" (card said ${expect} buyers) → ${r.count} | ${t.ms}ms`, summary(r, 3));
    }
  }
  // Typed demand queries
  for (const q of ['properties in shoot stage with matching clients', 'unprocessed seller leads that match active buyer requirements', 'seller leads in Anna Nagar', 'owners with buyers']) {
    await page.check('#forSeg input[value=properties]');
    t = await smart(page, q);
    log(`\n▶ "${q}" → mode=${t.body && t.body.mode} scope=${t.body && t.body.scope} ${t.ms}ms`, summary(await read(page), 3));
  }
  log('errors:', mask((await errorsOf(page)).filter(e => !/Listen\/channel/.test(e)).join(' | ')));
}
