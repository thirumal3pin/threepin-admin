// Lead mode: edit requirements → save → emulator; History; deep links; CRM / dashboard / Shoot links.
import { read, summary, shot, errorsOf, mask, timed, settle } from './_h.mjs';

export default async function ({ S, live, admin, OUT, log }) {
  const page = admin.page;
  const buyer = live.leads.find(l => l.stageId !== 'closed_lost' && !/seller|vendor/i.test(l.enquiryType || '') && /anna nagar/i.test(String(l.propertyInterest || '') + String(l.budget || '')) && /cr/i.test(String(l.budget || '')) && l.name && l.name.length > 3);
  log('buyer:', buyer.name, '| interest:', mask(buyer.propertyInterest).slice(0, 80), '| budget:', mask(buyer.budget).slice(0, 80));
  const before = await S.doc('leads', buyer.id);
  await page.goto(S.BASE + '/match.html?lead=' + encodeURIComponent(buyer.id));
  await settle(page);
  let r = await read(page);
  const lb = () => page.evaluate(() => ({ title: leadTitle.textContent, reviewed: leadReviewed.textContent, reqs: leadReqs.innerText.replace(/\s+/g, ' '), line: leadLine.textContent, stale: !leadStale.hidden }));
  log('lead box:', mask(JSON.stringify(await lb())));
  log(summary(r, 4));
  await shot(page, OUT, 'p60-01-lead', true);

  // Requirement chips (#1, #2…) if more than one
  const reqBtns = await page.$$('#leadReqs [data-req]');
  if (reqBtns.length > 1) {
    await timed(page, () => reqBtns[1].click());
    log('switched to req #2:', mask(JSON.stringify(await lb())), '| url has req:', page.url().includes('req='));
  }

  // Edit
  await page.click('#reqEdit');
  await page.waitForSelector('#reqEditor:not([hidden])');
  const form0 = await page.evaluate(() => ({ tabs: edTabs.innerText.replace(/\s+/g, ' '), deal: iDeal.value, loc: iLoc.value, bmax: iBMax.value, bmin: iBMin.value, bhk: [...document.querySelectorAll('input[name=bhk]:checked')].map(i => i.value) }));
  log('\n▶ editor opened:', mask(JSON.stringify(form0)));
  await shot(page, OUT, 'p60-02-editor', true);
  // Read with AI inside the editor (no key → built-in)
  let t = await timed(page, () => page.click('#reqAi'));
  log('  editor Read with AI:', t.status, await page.textContent('#reqAiNote'), '| err:', await page.textContent('#reqErr'));
  // Change: budget max 3.5 Cr, add Kilpauk, exclude Mogappair, 3 BHK
  await page.fill('#iBMax', '3.5 Cr');
  await page.fill('#iLoc', 'Anna Nagar, Kilpauk');
  await page.fill('#iEx', 'Mogappair');
  await page.check('input[name=bhk][value="3"]');
  await page.dispatchEvent('#iLoc', 'change');
  // Add a second requirement (a plot to invest) and mark it previous
  await page.click('#edAdd');
  await page.check('input[name=types][value=plot]');
  await page.fill('#iLoc', 'Oragadam');
  await page.fill('#iBMax', '60 L');
  await page.dispatchEvent('#iLoc', 'change');
  await page.selectOption('#edStatus', 'previous');
  log('  editor tabs now:', await page.evaluate(() => edTabs.innerText.replace(/\s+/g, ' ')));
  await shot(page, OUT, 'p60-03-editor-two', true);
  t = await timed(page, () => page.click('#reqSave'));
  await page.waitForTimeout(1500);
  await settle(page);
  log('  save →', t.status, 'err:', await page.textContent('#reqErr'), 'editor hidden:', await page.evaluate(() => reqEditor.hidden));
  const after = await S.doc('leads', buyer.id);
  log('  emulator lead.reqs:', JSON.stringify(after.reqs && { src: after.reqs.src, by: after.reqs.by, rev: after.reqs.rev, items: after.reqs.items }).slice(0, 700));
  const crmSame = ['propertyInterest', 'budget', 'stageId', 'assignedAgent', 'name', 'phone', 'updatedAt', 'followUpAt'].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  log('  CRM fields changed (should be none):', crmSame.join(',') || 'none');
  const revs = await S.db.collection('leads').doc(buyer.id).collection('reqRevisions').get();
  log('  reqRevisions docs:', revs.size, revs.docs.map(d => d.id).join(','));
  // The lead view also updated? (the server reads leads from views)
  r = await read(page);
  log('  after save lead box:', mask(JSON.stringify(await lb())));
  log(summary(r, 3));
  await shot(page, OUT, 'p60-04-after-save', true);
  // History
  await page.click('#reqHist');
  await page.waitForTimeout(1200);
  log('  history:', mask(await page.evaluate(() => histBox.innerText.replace(/\s+/g, ' '))).slice(0, 500));
  await shot(page, OUT, 'p60-05-history', true);
  // Edit again and remove requirement 1 → save → history shows 2 revisions
  await page.click('#reqEdit');
  await page.waitForSelector('#reqEditor:not([hidden])');
  log('  re-open editor tabs (previous kept?):', await page.evaluate(() => edTabs.innerText.replace(/\s+/g, ' ')));
  await page.click('#reqCancel');
  // Save with nothing active → error
  await page.click('#reqEdit');
  await page.selectOption('#edStatus', 'previous');
  await page.click('#reqSave');
  await page.waitForTimeout(600);
  log('  save with nothing active:', await page.textContent('#reqErr'));
  await page.click('#reqCancel');
  // After Cancel: is the refine form back where it belongs (Properties tab, not inside the hidden editor)?
  log('  item form back in refine:', await page.evaluate(() => !!document.querySelector('.mt-refine-b #itemForm')));

  // Deep links
  const prop = live.props.find(p => p.propertyCode === 'ANR004');
  const listing = live.listings.find(l => l.location && l.stageId === 'new_listing');
  const seller = live.leads.find(l => /seller/i.test(l.enquiryType || '') && l.stageId !== 'closed_lost');
  const links = [
    ['?q=3bhk anna nagar 3 cr', '?q=' + encodeURIComponent('3bhk anna nagar 3 cr')],
    ['?q=client name', '?q=' + encodeURIComponent(buyer.name)],
    ['?property=ANR004', '?property=ANR004'], ['?property=anr004', '?property=anr004'], ['?property=<doc id>', '?property=' + encodeURIComponent(prop.id)],
    ['?listing=<id>', '?listing=' + encodeURIComponent(listing.id)], ['?seller=<id>', '?seller=' + encodeURIComponent(seller.id)],
    ['?lead=<id>&req=0', '?lead=' + encodeURIComponent(buyer.id) + '&req=0'], ['?lead=<id>#requirements', '?lead=' + encodeURIComponent(buyer.id) + '#requirements'],
    ['?property=garbage', '?property=NOPE123'], ['?listing=garbage', '?listing=lst_nope'], ['?seller=garbage', '?seller=nope'], ['?lead=garbage', '?lead=nope'], ['?lead=../x', '?lead=' + encodeURIComponent('../x')],
    ['?q=<script>', '?q=' + encodeURIComponent('<img src=x onerror=alert(1)>')],
  ];
  for (const [label, qs] of links) {
    await page.goto(S.BASE + '/match.html' + qs);
    await page.waitForTimeout(400);
    await settle(page).catch(() => {});
    r = await read(page);
    const extra = await page.evaluate(() => ({ q: document.getElementById('q').value, toggle: document.querySelector('#forSeg input:checked').value, editorOpen: !reqEditor.hidden }));
    log(`\n▶ deep link ${label}: tab=${r.tab} title="${r.title}" count="${r.count}" q="${mask(extra.q)}" code="${extra.code}" editorOpen=${extra.editorOpen} first=${mask((r.rows[0] && (r.rows[0].name || r.rows[0].empty || r.rows[0].pick)) || '-').slice(0, 100)} dialog=${page.__lastDialog || ''}`);
  }
  await shot(page, OUT, 'p60-06-deeplink-last', true);

  // CRM: the buyer's panel — "Not yet onboarded" and the requirement line
  const p2 = await page.context().newPage();
  p2.__errs = []; p2.on('pageerror', e => p2.__errs.push(e.message));
  await p2.goto(S.BASE + '/crm.html?lead=' + encodeURIComponent(buyer.id));
  await p2.waitForTimeout(8000);
  const mm = await p2.evaluate(() => { const b = document.getElementById('dpMatchMore'); return b ? { text: b.innerText.replace(/\s+/g, ' ').slice(0, 900), links: [...b.querySelectorAll('a')].map(a => a.textContent.trim() + ' → ' + a.getAttribute('href').replace(/lead=[^&#]+/, 'lead=<id>')) } : null; });
  log('\n▶ CRM dpMatchMore:', mask(JSON.stringify(mm)));
  const el = await p2.$('#dpMatchMore');
  if (el) { await el.scrollIntoViewIfNeeded(); await p2.waitForTimeout(500); await p2.screenshot({ path: OUT + '/p60-07-crm-matchmore.png' }); }
  log('  crm page errors:', p2.__errs.slice(0, 3).join(' | '));
  // A seller lead's panel
  const sellerWithListing = live.leads.find(l => /seller/i.test(l.enquiryType || '') && l.stageId !== 'closed_lost' && live.listings.some(x => x.leadId === l.id));
  await p2.goto(S.BASE + '/crm.html?lead=' + encodeURIComponent(sellerWithListing.id));
  await p2.waitForTimeout(7000);
  log('  CRM seller dpMatchMore:', mask(await p2.evaluate(() => { const b = document.getElementById('dpMatchMore'); return b ? b.innerText.replace(/\s+/g, ' ').slice(0, 300) + ' | ' + [...b.querySelectorAll('a')].map(a => a.getAttribute('href').replace(/=.*/, '=…')).join(',') : 'none'; })));
  // Dashboard: property panel → Open in Match
  await p2.goto(S.BASE + '/dashboard.html?property=ANR003');
  await p2.waitForTimeout(6000);
  const tabBtn = p2.locator('text=Matching Buyers').first();
  if (await tabBtn.count()) { await tabBtn.click(); await p2.waitForTimeout(3000); }
  log('  dashboard Open in Match:', await p2.evaluate(() => [...document.querySelectorAll('a[href^="match.html"]')].map(a => a.textContent.trim() + ' → ' + a.getAttribute('href')).join(' | ') || 'none'));
  await p2.screenshot({ path: OUT + '/p60-08-dashboard-match.png' });
  // Shoot board card → Open in Match
  const lst = live.listings.find(x => x.location && x.askingPrice && x.stageId === 'new_listing');
  await p2.goto(S.BASE + '/propertytrack.html?listing=' + encodeURIComponent(lst.id));
  await p2.waitForTimeout(7000);
  log('  propertytrack Open in Match:', await p2.evaluate(() => [...document.querySelectorAll('a[href^="match.html"]')].map(a => a.textContent.trim() + ' → ' + a.getAttribute('href').replace(/=.*/, '=…')).join(' | ') || 'none'));
  await p2.screenshot({ path: OUT + '/p60-09-track-match.png' });
  await p2.close();
  log('errors:', mask((await errorsOf(page)).filter(e => !/Listen\/channel/.test(e)).join(' | ')));
}
