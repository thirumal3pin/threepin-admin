// Rameez (agent) on a phone, 390×844: every tab, restricted rows, Request details, no leaks.
import { smart, read, summary, shot, errorsOf, mask, timed, hscroll } from './_h.mjs';

export default async function ({ S, live, seeded, agent, OUT, log }) {
  const page = agent.page;
  const responses = [];
  const onResp = async r => { if (r.url().includes('/api/match')) { try { responses.push(await r.text()); } catch (e) { /* gone */ } } };
  page.on('response', onResp);
  await page.goto(S.BASE + '/match.html');
  await page.waitForSelector('#q');
  await page.waitForTimeout(1000);
  log('boot errors:', mask((await errorsOf(page)).join(' | ')));
  log('hscroll at load:', await hscroll(page));
  await shot(page, OUT, 'p50-01-agent-start', true);

  // Nav: the menu
  const navBtn = page.locator('[data-rail-toggle]');
  if (await navBtn.isVisible()) {
    await navBtn.click();
    await page.waitForTimeout(500);
    const items = await page.$$eval('nav a, .rail a, [data-nav] a', as => [...new Set(as.filter(a => a.offsetParent).map(a => a.textContent.replace(/\s+/g, ' ').trim()))].slice(0, 30));
    log('agent menu items:', items.join(' | '));
    await shot(page, OUT, 'p50-02-agent-menu');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await page.evaluate(() => document.documentElement.classList.contains('rail-open') || document.body.classList.contains('drawer-open'))) await navBtn.click();
  }

  // Properties search as an agent
  let t = await smart(page, '3 BHK in Anna Nagar under 3 Cr');
  let r = await read(page);
  log(`\n▶ agent properties search ${t.ms}ms`, summary(r, 6));
  const acc = (t.body.rows || []).reduce((o, x) => { o[x.access] = (o[x.access] || 0) + 1; return o; }, {});
  log('  access mix:', JSON.stringify(acc));
  const summaryRow = (t.body.rows || []).find(x => x.access === 'summary');
  if (summaryRow) log('  a summary row carries:', Object.keys(summaryRow).join(','), '| facts:', JSON.stringify(summaryRow.facts).slice(0, 300), '| link:', JSON.stringify(summaryRow.link));
  const restrictedProp = (t.body.rows || []).find(x => x.access === 'restricted');
  if (restrictedProp) log('  a restricted (un-onboarded) row:', mask(JSON.stringify({ name: restrictedProp.name, link: restrictedProp.link, src: restrictedProp.src, facts: restrictedProp.facts, sellerName: restrictedProp.sellerName, location: restrictedProp.location })).slice(0, 600));
  log('  hscroll:', await hscroll(page));
  await shot(page, OUT, 'p50-03-agent-props', true);

  // Name lookup: only own clients
  const others = live.leads.filter(l => l.assignedAgent === 'admin@threepin.in' && /^[A-Za-z]{4,} [A-Za-z]{4,}$/.test(l.name || '') && l.stageId !== 'closed_lost');
  const other = others[5];
  const own = live.leads.find(l => l.id === seeded.rameezLeads[0]);
  t = await smart(page, other.name);
  log(`\n▶ agent looks up an office client "${other.name}" → ${summary(await read(page), 3)}`);
  t = await smart(page, own.name.split(' ')[0]);
  log(`▶ agent looks up own client "${own.name}" → ${summary(await read(page), 3)}`);

  // Clients search: restricted rows
  await page.check('#forSeg input[value=clients]');
  await page.fill('#q', 'ANR003');
  t = await timed(page, () => page.click('#qGo'));
  r = await read(page);
  log(`\n▶ agent clients for ANR003 ${t.ms}ms`, summary(r, 5));
  const rows = t.body.rows || [];
  const restricted = rows.filter(x => x.access === 'restricted');
  log(`  restricted ${restricted.length} / full ${rows.filter(x => x.access === 'full').length}`);
  // Leak check: no other client's name, phone or lead id anywhere in the DOM or the responses
  const leakNames = [], leakPhones = [], leakIds = [];
  const html = await page.content();
  const allResp = responses.join('\n');
  for (const l of live.leads) {
    if (l.assignedAgent === 'rameez@threepin.in' || (l.agentAccess || []).includes('rameez@threepin.in')) continue;
    const d = String(l.phone || '').replace(/\D/g, '');
    if (d.length >= 10 && (html.includes(d.slice(-10)) || allResp.includes(d.slice(-10)))) leakPhones.push(l.name);
    if (String(l.id).length > 8 && (html.includes(String(l.id)) || allResp.includes('"' + String(l.id) + '"'))) leakIds.push(l.name);
    if ((l.name || '').length >= 6 && /\s/.test(l.name) && restricted.length && (html.includes(l.name))) leakNames.push(l.name);
  }
  log(`  LEAK CHECK: other clients' phones in DOM/responses: ${leakPhones.length} (${leakPhones.slice(0, 3).join(', ')}) | ids: ${leakIds.length} (${leakIds.slice(0, 3).join(', ')}) | full names in DOM: ${leakNames.length} (${leakNames.slice(0, 5).join(', ')})`);
  if (restricted[0]) log('  a restricted client row carries:', mask(JSON.stringify(restricted[0])).slice(0, 1400));
  log('  hscroll:', await hscroll(page));
  // Touch targets
  const small = await page.$$eval('#list button, #list a, #main button, #main input[type=checkbox] + *, .mt-dir [role=tab]', els => els.filter(e => e.offsetParent).map(e => { const b = e.getBoundingClientRect(); return { t: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 25), w: Math.round(b.width), h: Math.round(b.height) }; }).filter(x => x.h < 44 || x.w < 44));
  log('  touch targets under 44px:', small.length, JSON.stringify(small.slice(0, 12)));
  await shot(page, OUT, 'p50-04-agent-clients', true);

  // Request details
  const before = (await S.db.collection('accessRequests').get()).size;
  const btn = page.locator('#list button[data-act=request]').first();
  if (await btn.count()) {
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await page.waitForTimeout(2500);
    const msg = await page.locator('#list .mt-reqres').first().textContent();
    const after = await S.db.collection('accessRequests').get();
    const newest = after.docs.map(d => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    log(`\n▶ Request details → message="${msg}" accessRequests ${before} → ${after.size}; newest: ${mask(JSON.stringify(newest && { kind: newest.kind, by: newest.agentEmail || newest.by, status: newest.status, reason: newest.reason, targetId: newest.targetId ? '(set)' : '(none)' }))}`);
    // Twice?
    const btn2 = page.locator('#list button[data-act=request]').first();
    if (await btn2.count()) { await btn2.click(); await page.waitForTimeout(2000); log('  second request message:', await page.locator('#list .mt-reqres.ok, #list .mt-reqres.bad').nth(1).textContent().catch(() => '-')); }
    await shot(page, OUT, 'p50-05-agent-requested');
  } else log('  no Request details button');

  // Own lead in lead mode; another's lead refused
  await page.goto(S.BASE + '/match.html?lead=' + encodeURIComponent(own.id));
  await page.waitForTimeout(2500);
  r = await read(page);
  log(`\n▶ agent ?lead=<own> → ${summary(r, 2)} | leadBox hidden=${await page.evaluate(() => leadBox.hidden)}`);
  log('  hscroll:', await hscroll(page));
  await shot(page, OUT, 'p50-06-agent-own-lead', true);
  await page.goto(S.BASE + '/match.html?lead=' + encodeURIComponent(other.id));
  await page.waitForTimeout(2500);
  log(`▶ agent ?lead=<office lead> → ${summary(await read(page), 2)}`);
  // Direct API: save-req and req-history on someone else's lead
  const api = async body => page.evaluate(async b => {
    const { auth } = await import('/shared-assets/agent-client.js');
    const tok = await auth.currentUser.getIdToken();
    const res = await fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(b) });
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  }, body);
  const kavyaLead = seeded.kavyaLeads[0];
  log('  save-req on an office lead:', JSON.stringify(await api({ action: 'save-req', leadId: other.id, items: [{ status: 'active', locations: [{ name: 'Adyar', pref: 'primary' }] }] })));
  log('  save-req on Kavya’s lead:', JSON.stringify(await api({ action: 'save-req', leadId: kavyaLead, items: [{ status: 'active', locations: [{ name: 'Adyar', pref: 'primary' }] }] })));
  log('  req-history on Kavya’s lead:', JSON.stringify(await api({ action: 'req-history', leadId: kavyaLead })));
  log('  structure on Kavya’s lead:', JSON.stringify(await api({ action: 'structure', leadId: kavyaLead })).slice(0, 200));
  log('  search leadId Kavya’s lead:', JSON.stringify(await api({ action: 'search', mode: 'properties', leadId: kavyaLead })).slice(0, 200));
  log('  search sellerLeadId (office seller):', mask(JSON.stringify(await api({ action: 'search', mode: 'clients', sellerLeadId: live.leads.find(l => /seller/i.test(l.enquiryType || '')).id }))).slice(0, 300));
  const kv = await S.doc('leads', kavyaLead);
  log('  Kavya’s lead reqs untouched:', !kv.reqs);

  // Demand as agent
  await page.goto(S.BASE + '/match.html');
  await page.waitForSelector('#q');
  await page.check('#forSeg input[value=clients]');
  t = await timed(page, () => page.locator('.mt-eg [data-eg]').filter({ hasText: 'Seller leads with buyers' }).click());
  r = await read(page);
  log(`\n▶ agent demand ${t.ms}ms`, summary(r, 3));
  const demandHtml = await page.content();
  const topNames = (t.body.rows || []).flatMap(x => x.top || []).map(x => x.name);
  log('  demand top names shown to agent:', [...new Set(topNames)].slice(0, 8).join(', '), '| any leadId in response:', (t.body.rows || []).some(x => (x.top || []).some(y => y.leadId)));
  const restrictedDemand = (t.body.rows || []).filter(x => x.property && x.property.access === 'restricted').length;
  log('  demand rows with restricted property:', restrictedDemand, 'of', (t.body.rows || []).length, '| sellerName/phone in demand html:', /seller(Name|Phone)/.test(demandHtml));
  await shot(page, OUT, 'p50-07-agent-demand', true);
  log('  hscroll:', await hscroll(page));
  log('errors:', mask((await errorsOf(page)).filter(e => !/Listen\/channel/.test(e)).join(' | ')));
  page.off('response', onResp);
}
