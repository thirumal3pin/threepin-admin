// TASK-BASED usability walkthrough: each use case as a busy sales person would do it, from the menu,
// once as an admin (Thirumal, 1280×900) and once as an agent (Rameez, 390×844 touch phone).
// Screenshots: tests/out/ux-<role>-<case>-<n>.png (one per meaningful step). UX_TAG=before|after
// puts them in tests/out/ux-<tag>/ instead.
//
// The page: a toggle (Find properties | Find clients) above ONE box; "I read this as" under it after
// a search; More options holds the field-by-field form; Sort + Filters on one row (a drawer on a
// phone); cards with one trust badge, a short fit summary and the actions.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { read, mask, settle } from './_h.mjs';

export default async function ({ S, live, seeded, OUT: OUT0, log }) {
  const OUT = join(OUT0, '..');           // tests/out/
  const tag = process.env.UX_TAG || '';
  if (tag) mkdirSync(join(OUT, 'ux-' + tag), { recursive: true });
  const dir = tag ? join(OUT, 'ux-' + tag) : OUT;

  const roles = [
    { role: 'admin', who: 'thirumal', vp: { width: 1280, height: 900 }, touch: false, home: '/dashboard.html' },
    { role: 'agent', who: 'rameez', vp: { width: 390, height: 844 }, touch: true, home: '/myday.html' },
  ];
  const ownLead = live.leads.find(l => l.id === seeded.rameezLeads[0]);
  const officeLead = live.leads.find(l => l.assignedAgent === 'admin@threepin.in' && /^[A-Za-z]{4,} [A-Za-z]{4,}$/.test(l.name || '') && l.stageId !== 'closed_lost' && /cr|lakh|l\b/i.test(String(l.budget || '')));
  const summary = { problems: [] };

  for (const R of roles) {
    const { ctx, page } = await S.as(R.who, { viewport: R.vp, touch: R.touch });
    page.__net = [];
    const bodies = [];
    page.on('response', async r => { if (r.url().includes('/api/')) { try { bodies.push(r.url().replace(/^.*\/api/, '/api') + ' ' + await r.text()); } catch (e) { /* gone */ } } });
    const phone = R.touch;
    const tap = async sel => (phone ? page.tap(sel) : page.click(sel));
    let C = '', n = 0, clicks = 0;
    const note = s => log(`   [${R.role} ${C}] ${mask(s)}`);
    const problem = s => { summary.problems.push(`${R.role} ${C}: ${s}`); note('PROBLEM: ' + s); };
    const shot = async (what, full = false) => {
      n++; const f = `ux-${R.role}-${C}-${n}.png`;
      await page.screenshot({ path: join(dir, f), fullPage: full });
      const hs = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (hs > 0) problem(`sideways scroll ${hs}px on ${f}`);
      log(`   📷 ${f} — ${what}`);
    };
    const start = c => { C = c; n = 0; clicks = 0; log(`\n■ ${R.role.toUpperCase()} · case ${c}`); };
    const act = async (fn, label) => { clicks++; await fn(); if (label) note(`step ${clicks}: ${label}`); };
    const setFor = v => act(() => page.check(`#forSeg input[value="${v}"]`), `toggle → ${v === 'clients' ? 'Find clients' : 'Find properties'}`);
    const forIs = () => page.evaluate(() => document.querySelector('#forSeg input:checked').value);
    // Where the first result sits: in view without scrolling?
    const fold = async () => { await page.waitForTimeout(900); return page.evaluate(() => {
      const f = document.querySelector('#list > li'); const res = document.getElementById('results');
      if (!f || res.hidden) return 'no results shown';
      const t = Math.round(f.getBoundingClientRect().top);
      return t < 0 ? `scrolled past the first result (top ${t}px)` : t < innerHeight - 80 ? `first result in view (top ${t}px of ${innerHeight})` : `first result BELOW the fold (top ${t}px, screen ${innerHeight}px)`;
    }); };
    async function viaMenu() {
      await page.goto(S.BASE + R.home);
      await page.waitForTimeout(1500);
      if (phone) { await act(() => page.tap('[data-rail-toggle]'), 'open the menu'); await page.waitForTimeout(400); }
      await act(() => page.locator('a[href="match.html"], a[href$="/match.html"]').filter({ visible: true }).first().click(), 'tap Match in the menu');
      await page.waitForURL(/match\.html/);
      await page.waitForSelector('#q');
      await page.waitForTimeout(500);
    }
    async function search(text, label) {
      await page.fill('#q', text); clicks++;
      await act(() => tap('#qGo'), label || `type “${text}”, Search`);
      await settle(page);
    }

    // ── 1. A buyer just called ──
    start('1');
    await viaMenu();
    // A fresh visit: the toggle starts where it was last left — make sure it is on Find properties.
    if (await forIs() !== 'properties') await setFor('properties');
    await shot('the Match page as it opens');
    const above = await page.evaluate(() => Math.round(document.getElementById('refine').getBoundingClientRect().bottom));
    note(`top of the page ends at ${above}px (toggle, box, helper, examples, More options)`);
    const t1 = Date.now();
    await search('3 BHK in Anna Nagar around 3 Cr, not Mogappair', 'type the requirement, Search');
    note(`answer in ${Date.now() - t1} ms; ${await fold()}`);
    await shot('results right after Search (what is on screen)');
    let r = await read(page);
    note(`${r.title} · ${r.count}${r.note ? ' · ' + r.note : ''}`);
    note(`read as: ${r.chips}`);
    note(`top 10: ${r.rows.slice(0, 10).map(x => (/Verified/.test(x.src) ? '✓' : '·') + parseInt(x.score) + '% ' + x.name.slice(0, 28)).join(' | ')}`);
    note(`Mogappair rows: ${r.rows.filter(x => /mogappair/i.test(x.facts)).length}`);
    await page.evaluate(() => document.querySelector('#list > li')?.scrollIntoView({ block: 'start' }));
    await shot('the first result card up close');
    await page.evaluate(() => scrollTo(0, 0));
    await act(() => tap('#readAs'), 'tap “I read this as”');
    await page.waitForTimeout(400);
    note(`More options open=${await page.evaluate(() => refine.open)}; filled: locations="${await page.inputValue('#iLoc')}" not in="${await page.inputValue('#iEx')}" budget up to="${await page.inputValue('#iBMax')}"`);
    await shot('More options, filled in from what was read');

    // ── 2. A seller with a property not in the system ──
    start('2');
    await viaMenu();
    if (await forIs() !== 'properties') await setFor('properties');
    await search('2 BHK flat for rent in Porur 22k semi-furnished', 'type the seller’s property with the toggle on Find properties');
    r = await read(page);
    note(`first try → "${r.title}" · ${r.count} · toggle=${await forIs()}`);
    await shot('first try: the toggle on Find properties');
    const redoB = page.locator('#resNote [data-redo=clients]');
    if (await redoB.count()) {
      await act(() => redoB.click(), 'tap “Find buyers for it instead”');
      await settle(page);
      r = await read(page);
      note(`→ ${r.title} · ${r.count} · toggle=${await forIs()}; ${await fold()}`);
      if (await forIs() !== 'clients') problem('“Find buyers for it instead” did not flip the toggle');
      await shot('after “Find buyers for it instead” (toggle on Find clients)');
    } else problem('no “Find buyers for it instead” link');
    note(`top 5: ${r.rows.slice(0, 5).map(x => parseInt(x.score) + '% ' + x.name.slice(0, 20) + ' [' + (x.kv || '').slice(0, 70) + ']').join(' | ')}`);
    await search('2 grounds land in Medavakkam 2.5 Cr', 'toggle already on Find clients: type the land, Search');
    r = await read(page);
    note(`land → ${r.title} · ${r.count} · read as: ${r.chips}`);
    await shot('buyers for the land');
    await act(() => page.evaluate(() => { refine.open = true; }), 'open More options');
    await page.locator('#refine').scrollIntoViewIfNeeded();
    const formNow = await page.evaluate(() => [dType.value, dLoc.value, dPrice.value, dDeal.value].join(' · '));
    note(`More options holds the latest search: ${formNow}`);
    if (!/Medavakkam/.test(formNow)) problem('More options does not hold the latest search');
    await shot('More options on Find clients, holding the land just searched');
    // Now the rental, field by field.
    await page.selectOption('#dType', 'Apartment'); await page.selectOption('#dBhk', '2'); await page.fill('#dLoc', 'Porur'); await page.fill('#dPrice', '22k'); await page.selectOption('#dDeal', 'rent');
    clicks += 5;
    await act(() => tap('#detailsForm button[type=submit]'), 'Find clients');
    await settle(page);
    r = await read(page);
    note(`form → ${r.title} · ${r.count}; ${await fold()}`);
    await shot('buyers for the rental (form)');

    // ── 3. Who wants ANR003 ──
    start('3');
    await viaMenu();
    if (await forIs() !== 'properties') await setFor('properties');
    await search('ANR003', 'type the code with the toggle on Find properties, Search');
    r = await read(page);
    note(`→ "${r.title}" · ${r.count} · toggle=${await forIs()}`);
    if (await forIs() !== 'clients') problem('a code did not flip the toggle to Find clients');
    await shot('the code: clients, toggle flipped');
    note(`${await fold()}; top 3: ${r.rows.slice(0, 3).map(x => parseInt(x.score) + '% ' + x.name.slice(0, 22) + (x.held ? ' (held)' : '')).join(' | ')}`);

    // ── 4. Client by name / last digits → lead mode → edit, save, history ──
    start('4');
    await viaMenu();
    if (await forIs() !== 'properties') await setFor('properties');
    const target = R.role === 'agent' ? ownLead : officeLead;
    const digits = String(target.phone).replace(/\D/g, '').slice(-5);
    await search(digits, 'type the last 5 digits of the number, Search');
    let lead = await page.evaluate(() => !leadBox.hidden);
    r = await read(page);
    note(`digits → ${lead ? 'straight to the client (one match)' : `"${r.title}" · ${r.count} · picks: ${r.rows.length}`}`);
    await shot(lead ? 'the digits went straight to the client' : 'the pick list for the digits');
    if (!lead) {
      await search(target.name.split(' ')[0], 'type the first name, Search');
      lead = await page.evaluate(() => !leadBox.hidden);
      r = await read(page);
      note(`first name → ${lead ? 'straight to the client' : r.rows.length + ' to pick from'}`);
      await shot('the pick list for the first name');
      if (!lead) {
        const pick = page.locator('#list [data-pick-lead]').filter({ hasText: target.name }).first();
        if (await pick.count()) { await act(() => pick.click(), 'tap the client'); await settle(page); lead = true; } else problem('client not in the pick list');
      }
    }
    if (lead) {
      r = await read(page);
      note(`lead mode → ${r.title} · ${r.count}; requirement: "${mask(await page.textContent('#leadLine'))}"; ${await page.textContent('#leadReviewed')}; ${await fold()}`);
      await page.evaluate(() => scrollTo(0, 0));
      await shot('the client’s requirement (one line) and properties');
      await act(() => tap('#reqEdit'), 'Edit');
      await page.waitForSelector('#reqEditor:not([hidden])');
      await page.locator('#reqEditor').scrollIntoViewIfNeeded();
      await shot('the editor');
      await page.fill('#iBMax', '3.5 Cr'); clicks++;
      await page.fill('#iEx', 'Mogappair'); clicks++;
      await page.locator('#reqSave').scrollIntoViewIfNeeded();
      await shot('changes made, Save in view');
      await act(() => tap('#reqSave'), 'Save');
      await page.waitForTimeout(1500); await settle(page);
      note(`after save: editor closed=${await page.evaluate(() => reqEditor.hidden)} err="${await page.textContent('#reqErr')}" reviewed="${await page.textContent('#leadReviewed')}" line="${mask(await page.textContent('#leadLine'))}"`);
      if (/@/.test(await page.textContent('#leadReviewed'))) problem('reviewer shown as an e-mail');
      await page.evaluate(() => leadBox.scrollIntoView({ block: 'start' }));
      await shot('after Save');
      await act(() => tap('#reqHist'), 'History');
      await page.waitForTimeout(1200);
      const hist = await page.evaluate(() => histBox.innerText.replace(/\s+/g, ' '));
      note(`history: ${mask(hist).slice(0, 240)}`);
      if (!/^Now/.test(hist.trim()) || !/Before/.test(hist)) problem('History does not say Now / Before');
      await shot('History');
    }

    // ── 5. Stock that already has buyers ──
    start('5');
    await viaMenu();
    if (await forIs() !== 'clients') await setFor('clients');
    await act(() => page.locator('#egs [data-eg]').filter({ hasText: 'Seller leads with buyers' }).click(), 'tap the “Seller leads with buyers” example');
    await settle(page);
    r = await read(page);
    note(`→ ${r.title} · ${r.count}; ${await fold()}; first: ${r.rows.slice(0, 3).map(x => x.name.slice(0, 25) + ' ' + x.score).join(' | ')}`);
    note(`first card: ${mask(await page.locator('#list > li').first().innerText()).replace(/\s+/g, ' ').slice(0, 260)}`);
    await shot('the demand list');
    const said = await page.locator('#list > li .mt-score b').first().innerText();
    await act(() => page.locator('#list button[data-act=demand-buyers]').first().click(), 'See buyers on the first one');
    await settle(page);
    await page.waitForTimeout(700);
    r = await read(page);
    const top = await page.evaluate(() => Math.round(document.getElementById('results').getBoundingClientRect().top));
    note(`card said ${said} buyers → "${r.count}"; box now "${mask(await page.inputValue('#q'))}"; results top at ${top}px`);
    await shot('the buyers for that seller’s property (lands at the results)');
    const backB = page.locator('#resNote [data-back]');
    if (await backB.count()) {
      await act(() => backB.click(), '“← Back to …”');
      await settle(page);
      note(`back → ${(await read(page)).title}`);
      await shot('back at the demand list');
    } else problem('no way back to the demand list');

    // ── 6. Narrow the list ──
    start('6');
    await viaMenu();
    if (await forIs() !== 'properties') await setFor('properties');
    await search('3 BHK in Anna Nagar under 3 Cr', 'search');
    await act(() => tap('#filterBtn'), 'Filters');
    await page.waitForTimeout(300);
    note(`filters open as ${await page.evaluate(() => filters.matches(':modal') ? 'a bottom drawer' : 'a panel under the header')}`);
    await shot('filters open');
    await act(() => page.check('input[name=fSrc][value=onboarded]'), 'tick Onboarded');
    await act(() => page.check('input[name=fBhk][value="3"]'), 'tick 3 BHK');
    await page.waitForTimeout(500); await settle(page);
    note(`filtered → ${(await read(page)).count}; button says "${await page.textContent('#filterShow')}"`);
    await shot('filters ticked — the Show button counts');
    await act(() => tap('#filterShow'), 'Show N');
    await act(() => page.selectOption('#sort', 'budget'), 'sort by Best budget match');
    await page.waitForTimeout(500); await settle(page);
    r = await read(page);
    note(`budget sort first 5: ${r.rows.slice(0, 5).map(x => parseInt(x.score) + '% ' + (x.fits || '').slice(0, 45)).join(' | ')}`);
    await shot('filtered and sorted');
    await act(() => tap('#filterBtn'), 'Filters');
    await act(() => page.check('#fOut'), 'Show ruled out');
    await page.waitForTimeout(500); await settle(page);
    if (await page.evaluate(() => filters.open)) await act(() => tap('#filterShow'), 'Show N');
    r = await read(page);
    note(`ruled out shown: ${r.rows.filter(x => x.out).length}; count "${r.count}"`);
    const out = page.locator('#list > li.out').first();
    if (await out.count()) {
      await out.scrollIntoViewIfNeeded();
      const o = r.rows.find(x => x.out);
      note(`a ruled-out row: next="${o.next}" acts=${o.acts.join('/')}`);
      if (o.next) problem('ruled-out row still has a Next line');
      await shot('a ruled-out row (Open only)');
    }
    await act(() => tap('#filterBtn'), 'Filters');
    await page.uncheck('#fOut'); await page.waitForTimeout(500); await settle(page);
    await page.evaluate(() => filters.close());
    await page.locator('#list > li').first().scrollIntoViewIfNeeded();
    await act(() => page.locator('#list > li').first().locator('details.mt-more > summary').click(), 'open Why this score');
    note(`why: ${mask((await page.locator('#list > li').first().locator('details.mt-more').innerText()).replace(/\s+/g, ' ')).slice(0, 400)}`);
    await page.locator('#list > li').first().locator('details.mt-more').scrollIntoViewIfNeeded();
    await shot('Why this score');

    // ── 7. Act on a result ──
    start('7');
    await viaMenu();
    if (await forIs() !== 'clients') await setFor('clients');
    await search('ANR003', 'code ANR003');
    const acts = await page.$$eval('#list > li', lis => lis.slice(0, 8).map(li => [...li.querySelectorAll('.mt-acts a, .mt-acts button')].filter(a => a.checkVisibility()).map(a => a.textContent.trim() || a.getAttribute('aria-label')).join('/')));
    note(`actions on the first rows: ${mask([...new Set(acts)].join(' || '))}`);
    note(`count: ${(await read(page)).count}`);
    await page.locator('#list > li').first().scrollIntoViewIfNeeded();
    await shot('client rows and their actions');
    note(`WhatsApp ${(await page.$('#list a[href^="https://wa.me/"]')) ? 'present' : 'absent'}; Call ${(await page.$('#list a[href^="tel:"]')) ? 'present' : 'absent'}; Follow-up ${(await page.$('#list a[href*="followup=1"]')) ? 'present' : 'absent'}`);
    if (phone) {
      const more = page.locator('#list .mt-moreb').filter({ visible: true }).first();
      if (await more.count()) {
        await act(() => more.tap(), 'tap ⋯');
        await page.waitForTimeout(300);
        note(`⋯ menu: ${await page.evaluate(() => [...document.querySelectorAll('.mt-pop:popover-open a, .mt-pop:popover-open button')].map(a => a.textContent.trim()).join(' / '))}`);
        await shot('the ⋯ menu (View client, Share)');
        await page.keyboard.press('Escape');
      }
    }
    if (R.role === 'agent') {
      const req = page.locator('#list button[data-act=request]').first();
      if (await req.count()) {
        await req.scrollIntoViewIfNeeded();
        await shot('a held client with Request details');
        const nBefore = (await S.db.collection('accessRequests').get()).size;
        await act(() => req.tap(), 'Request details');
        await page.waitForTimeout(2000);
        const msg = await page.locator('#list .mt-reqres.ok, #list .mt-reqres.bad').first().textContent().catch(() => '(no message)');
        note(`request → "${msg}"; pill shown=${await page.locator('#list .mt-wait').count() > 0}; accessRequests ${nBefore} → ${(await S.db.collection('accessRequests').get()).size}`);
        await shot('after Request details (Requested · waiting)');
      }
      // A property this agent may only see in summary: Request details on the card itself.
      await setFor('properties');
      await search('3 BHK in Anna Nagar under 3 Cr', 'search properties');
      const rp = page.locator('#list button[data-act=req-prop]').first();
      if (await rp.count()) {
        await rp.scrollIntoViewIfNeeded();
        await shot('a summary-only property with Request details');
        await act(() => rp.tap(), 'Request details (property)');
        await page.waitForTimeout(2000);
        note(`property request → "${await page.locator('#list .mt-reqres.ok, #list .mt-reqres.bad').first().textContent().catch(() => '(none)')}"; pill=${await page.locator('#list .mt-wait').count() > 0}`);
        await shot('after Request details on a property');
      } else note('no summary-only property in the list');
      await page.goto(S.BASE + '/myday.html');
      await page.waitForTimeout(3000);
      const md = await page.evaluate(() => document.body.innerText.match(/request[^\n]{0,80}/gi) || []);
      note(`My Day mentions: ${mask(md.slice(0, 4).join(' | '))}`);
      await shot('My Day after the requests');
    } else {
      if (await page.locator('[data-act=request], [data-act=req-prop]').count()) problem('an admin sees Request buttons');
      await setFor('properties');
      await search('3 BHK in Anna Nagar under 3 Cr', 'search properties');
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.locator('#list button[data-act=share]').first().click();
      await page.waitForTimeout(300);
      note(`Share copies: ${mask(await page.evaluate(() => navigator.clipboard.readText())).replace(/\n/g, ' ⏎ ')}`);
      await shot('property rows with Open / Matching clients / Share');
    }

    // ── 8. Agent only: no leaks; held rows understood ──
    if (R.role === 'agent') {
      start('8');
      await viaMenu();
      if (await forIs() !== 'clients') await setFor('clients');
      await search('3 BHK apartment in Anna Nagar 3 Cr', 'the property in plain words');
      note(`count: ${(await read(page)).count} · ${await page.evaluate(() => mineRow.hidden ? '(no Mine chip)' : mineRow.innerText.replace(/\s+/g, ' '))}`);
      await page.evaluate(() => scrollTo(0, 0));
      await shot('clients: Mine · N and how many others hold');
      if (await page.locator('#mineRow [data-mine]').count()) {
        await act(() => page.tap('#mineRow [data-mine]'), 'tap Mine');
        await page.waitForTimeout(500); await settle(page);
        const rm = await read(page);
        note(`Mine → ${rm.count}; held rows ${rm.rows.filter(x => x.held).length} of ${rm.rows.length}`);
        if (rm.rows.some(x => x.held)) note('(the server does not filter on mine yet)');
        await page.evaluate(() => document.getElementById('results').scrollIntoView());
        await shot('Mine: only this agent’s clients');
        await page.tap('#mineRow [data-mine]'); await page.waitForTimeout(500); await settle(page);
      }
      const heldRow = page.locator('#list > li.held').first();
      if (await heldRow.count()) {
        await heldRow.scrollIntoViewIfNeeded();
        await shot('held rows as the agent sees them');
        note(`a held row reads: ${mask((await heldRow.innerText()).replace(/\s+/g, ' ')).slice(0, 400)}`);
      }
      const html = await page.content();
      const all = bodies.join('\n') + html;
      let phones = 0, names = 0, ids = 0;
      const nowDocs = new Map((await S.db.collection('leads').where('agentAccess', 'array-contains', 'rameez@threepin.in').get()).docs.map(d => [d.id, 1]));
      for (const l of live.leads) {
        const mine = ['rameez@threepin.in'].includes(l.assignedAgent) || seeded.rameezLeads.includes(l.id) || (l.agentAccess || []).includes('rameez@threepin.in') || nowDocs.has(l.id);
        if (mine) continue;
        const d = String(l.phone || '').replace(/\D/g, '');
        if (d.length >= 10 && all.includes(d.slice(-10))) phones++;
        if (String(l.id).length > 8 && all.includes(String(l.id))) ids++;
        if ((l.name || '').length >= 7 && / /.test(l.name) && html.includes('>' + l.name + '<')) names++;
      }
      note(`LEAK CHECK over every page and API response this session: other clients' phones ${phones}, lead ids ${ids}, names as headings ${names}`);
      if (phones || ids) problem(`leak: phones ${phones}, ids ${ids}`);
    }
    const errs = [...(page.__errors || []), ...(page.__net || [])].filter(e => !/Listen\/channel/.test(e));
    log(`\n${R.role} page errors: ${mask(errs.slice(0, 6).join(' | ')) || 'none'}`);
    if (errs.length) summary.problems.push(`${R.role}: ${errs.length} console/network errors`);
    await ctx.close();
  }
  log(`\nUX WALKTHROUGH PROBLEMS: ${summary.problems.length ? summary.problems.map(mask).join(' || ') : 'none'}`);
}
