// Clients tab: plain words, the top box on this tab, property codes, the describe form, client rows.
import { read, summary, shot, errorsOf, mask, timed } from './_h.mjs';

export default async function ({ S, live, admin, OUT, log }) {
  const page = admin.page;
  await page.goto(S.BASE + '/match.html');
  await page.waitForSelector('#q');
  const byId = new Map(live.leads.map(l => [String(l.id), l]));
  const check = (label, t) => {
    const rows = (t.body && t.body.rows) || [];
    const lost = rows.filter(r => r.leadId && byId.get(r.leadId) && byId.get(r.leadId).stageId === 'closed_lost');
    const sellers = rows.filter(r => r.leadId && byId.get(r.leadId) && /seller|vendor/i.test(byId.get(r.leadId).enquiryType || ''));
    const dup = rows.length - new Set(rows.map(r => r.leadId)).size;
    const ttSellers = rows.filter(r => /seller|selling|sell my|owner/i.test(String(r.reqText || '')));
    log(`  checks ${label}: rows=${rows.length} lost=${lost.length} sellerEnquiryType=${sellers.length} (${mask(sellers.slice(0, 3).map(r => r.name + ' ' + r.pct + '%').join(', '))}) dupLeads=${dup} reqText-mentions-selling=${ttSellers.length} (${mask(ttSellers.slice(0, 2).map(r => r.name + ': ' + String(r.reqText).slice(0, 80)).join(' || '))})`);
  };
  const tabClients = async () => { await page.check('#forSeg input[value=clients]'); };

  await tabClients();
  log('placeholder on clients tab:', await page.getAttribute('#q', 'placeholder'), '| hint:', await page.textContent('#qHint'));
  await page.check('#forSeg input[value=properties]');
  log('placeholder on props tab:', await page.getAttribute('#q', 'placeholder'));
  await tabClients();

  // Plain-words box
  for (const q of ['3 BHK apartment in Anna Nagar 3 Cr resale', 'around 2000 sqft apartment in anna nagar', 'commercial space for rent T Nagar 4 L', 'plot Tambaram 50 L', 'ANR003', 'anr003', 'ANR 003', 'Aindro Coral Bay', 'Shriram', 'ZZZ999', 'adya']) {
    await page.fill('#q', q);
    const t = await timed(page, () => page.click('#qGo'));
    const r = await read(page);
    log(`\n▶ [plain words] "${q}" → mode=${t.body && t.body.mode} ${t.ms}ms (server ${t.serverMs})`);
    log(summary(r, 4));
    if (t.body && t.body.mode === 'clients') check(q, t);
  }
  await shot(page, OUT, 'p40-01-plainwords', true);

  // Top box while on the clients tab
  for (const q of ['3 BHK apartment in Anna Nagar 3 Cr resale', 'office space for rent OMR 3000 sqft 2 L', 'ANR004', 'buyers above 3 Cr in Anna Nagar']) {
    await tabClients();
    await page.fill('#q', q);
    const t = await timed(page, () => page.click('#qGo'));
    const r = await read(page);
    log(`\n▶ [top box, clients tab] "${q}" → mode=${t.body && t.body.mode} tab after=${r.tab} ${t.ms}ms`);
    log(summary(r, 3));
  }

  // Code box
  for (const q of ['ANR003', 'anr003', ' ADYA 001 ', 'ZZZ999', 'SALV0001']) {
    await tabClients();
    await page.fill('#q', q);
    const t = await timed(page, () => page.click('#qGo'));
    const r = await read(page);
    log(`\n▶ [code] "${q}" → ${t.status} mode=${t.body && t.body.mode} ${t.ms}ms err=${t.body && t.body.error}`);
    log(summary(r, 3));
  }

  // Describe form
  const D = async (label, fill) => {
    await tabClients();
    await page.evaluate(() => { detailsForm.reset(); refine.open = true; });
    await fill();
    const t = await timed(page, () => page.click('#detailsForm button[type=submit]'));
    const r = await read(page);
    log(`\n▶ [describe] ${label} → ${t.status} total=${t.body && t.body.total} about=${JSON.stringify(t.body && t.body.about)} ${t.ms}ms`);
    log(summary(r, 3));
    if (t.body && t.body.mode === 'clients') check(label, t);
    return t;
  };
  await D('apartment 3BHK Anna Nagar 1500 sqft 2.8 Cr resale ready', async () => {
    await page.selectOption('#dType', 'Apartment'); await page.selectOption('#dBhk', '3'); await page.fill('#dLoc', 'Anna Nagar');
    await page.fill('#dArea', '1500'); await page.fill('#dPrice', '2.8 Cr'); await page.selectOption('#dStatus', 'ready'); await page.selectOption('#dCond', 'resale');
  });
  await D('plot 2 grounds Porur 2.5 Cr', async () => { await page.selectOption('#dType', 'Plot'); await page.selectOption('#dSub', 'residential plot'); await page.fill('#dLoc', 'Porur'); await page.fill('#dArea', '2'); await page.selectOption('#dAUnit', 'grounds'); await page.fill('#dPrice', '2.5 Cr'); });
  await D('plot 50 cents Oragadam 60 L', async () => { await page.selectOption('#dType', 'Plot'); await page.fill('#dLoc', 'Oragadam'); await page.fill('#dArea', '50'); await page.selectOption('#dAUnit', 'cents'); await page.fill('#dPrice', '60 L'); });
  await D('land 2 acres Chengalpattu JV', async () => { await page.selectOption('#dType', 'Plot'); await page.fill('#dLoc', 'Chengalpattu'); await page.fill('#dArea', '2'); await page.selectOption('#dAUnit', 'acres'); await page.selectOption('#dDeal', 'jv'); });
  await D('apartment 2BHK rent Velachery 25k', async () => { await page.selectOption('#dType', 'Apartment'); await page.selectOption('#dBhk', '2'); await page.fill('#dLoc', 'Velachery'); await page.fill('#dPrice', '25k'); await page.selectOption('#dDeal', 'rent'); });
  await D('apartment 2BHK rent Velachery price "25000"', async () => { await page.selectOption('#dType', 'Apartment'); await page.selectOption('#dBhk', '2'); await page.fill('#dLoc', 'Velachery'); await page.fill('#dPrice', '25000'); await page.selectOption('#dDeal', 'rent'); });
  await D('apartment 2BHK rent Velachery price "25" (as people type)', async () => { await page.selectOption('#dType', 'Apartment'); await page.selectOption('#dBhk', '2'); await page.fill('#dLoc', 'Velachery'); await page.fill('#dPrice', '25'); await page.selectOption('#dDeal', 'rent'); });
  await D('commercial office lease Nungambakkam 3 L', async () => { await page.selectOption('#dType', 'Commercial'); await page.selectOption('#dSub', 'office space'); await page.fill('#dLoc', 'Nungambakkam'); await page.fill('#dPrice', '3 L'); await page.selectOption('#dDeal', 'lease'); });
  await D('villa ECR 5 Cr', async () => { await page.selectOption('#dType', 'Villa'); await page.fill('#dLoc', 'ECR'); await page.fill('#dPrice', '5 Cr'); });
  await D('house only, no place/price', async () => { await page.selectOption('#dType', 'Independent House'); });
  // Empty submit
  await tabClients();
  await page.evaluate(() => { detailsForm.reset(); refine.open = true; });
  const before = (await read(page)).title;
  await page.click('#detailsForm button[type=submit]');
  await page.waitForTimeout(400);
  log('\n▶ [describe] empty submit: toast=', await page.evaluate(() => (document.querySelector('.toast, #toast, [role=status].show') || {}).textContent || ''), '| title unchanged=', (await read(page)).title === before);

  // Client row details + links on a rich result
  await page.fill('#q', 'ANR003');
  await timed(page, () => page.click('#qGo'));
  const rows = await page.$$eval('#list > li', lis => lis.slice(0, 5).map(li => ({
    name: li.querySelector('h3')?.textContent, who: li.querySelector('.mt-who')?.textContent.replace(/\s+/g, ' '), kv: li.querySelector('.mt-kv')?.textContent.replace(/\s+/g, ' '), upd: li.querySelector('.mt-upd')?.textContent,
    next: li.querySelector('.mt-next')?.textContent.replace(/\s+/g, ' '),
    links: [...li.querySelectorAll('.mt-acts a')].map(a => a.textContent.trim() + ' ' + a.getAttribute('href').replace(/\d{5,}/g, '#').replace(/lead=[^&]+/, 'lead=<id>') + (a.target ? ' target=' + a.target : '')),
  })));
  log('\n▶ client rows detail:', mask(JSON.stringify(rows, null, 1)).slice(0, 3000));
  // WhatsApp number format check (without printing it)
  const wa = await page.$$eval('#list a[href^="https://wa.me/"]', as => as.map(a => a.getAttribute('href').replace('https://wa.me/', '')));
  log('  wa.me numbers: total', wa.length, 'bad (not 12 digits starting 91):', wa.filter(n => !/^91\d{10}$/.test(n)).map(n => n.length + ' digits').join(','));
  const tel = await page.$$eval('#list a[href^="tel:"]', as => as.map(a => a.getAttribute('href').slice(4)));
  log('  tel numbers bad:', tel.filter(n => !/^\+?\d{10,13}$/.test(n)).map(n => n.length).join(','));
  await page.locator('#list > li').first().locator('details.mt-more > summary').click();
  log('  client breakdown:', mask((await page.locator('#list > li').first().locator('details.mt-more').innerText()).replace(/\s+/g, ' ').slice(0, 700)));
  await shot(page, OUT, 'p40-02-client-rows', false);
  await shot(page, OUT, 'p40-02b-client-rows-full', true);
  // Follow-up link opens the CRM on that lead with the follow-up?
  const fu = await page.$eval('#list a[href*="followup=1"]', a => a.getAttribute('href'));
  const p2 = await page.context().newPage();
  await p2.goto(S.BASE + '/' + fu);
  await p2.waitForTimeout(7000);
  const crmState = await p2.evaluate(() => ({ title: document.title, url: location.search.replace(/lead=[^&]+/, 'lead=<id>'), open: [...document.querySelectorAll('dialog[open], .modal.open, .panel.open, [aria-modal=true]')].map(e => (e.id || e.className) + ':' + e.textContent.replace(/\s+/g, ' ').slice(0, 100)) }));
  log('  follow-up link →', mask(JSON.stringify(crmState)));
  await p2.screenshot({ path: OUT + '/p40-03-crm-followup.png' });
  await p2.close();

  // Switch tab: stale results?
  await page.check('#forSeg input[value=properties]');
  log('\n▶ switch to props after clients results: results hidden=', await page.evaluate(() => results.hidden), '| placeholder:', await page.getAttribute('#q', 'placeholder'));
  await page.check('#forSeg input[value=clients]');
  log('  back to clients: results hidden=', await page.evaluate(() => results.hidden));
  log('errors:', mask((await errorsOf(page)).filter(e => !/Listen\/channel/.test(e)).join(' | ')));
}
