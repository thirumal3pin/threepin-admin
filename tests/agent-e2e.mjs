// ═══════ THE AGENT LAYER, END TO END — real pages, real rules, real server code ═══════
//
// Chrome opens the real pages. Firebase is the real SDK, pointed at a LOCAL Firestore emulator
// (so firestore.rules decide every read and write exactly as in production). /api/* is the real
// server code running here against the same emulator. Only the sign-in is played. The whole set-up
// is tests/_agent-stack.mjs. Nothing touches the live database.
//
// People: Swami (admin), Rameez and Kavya (agents), Rajesh (full access, no role).
// Phone first (390×844); a desktop and a dark pass for the screenshots in tests/out/agent-e2e/.
//   JAVA_HOME=… node tests/agent-e2e.mjs          (ports: E2E_EMU_PORT, E2E_WEB_PORT)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStack } from './_agent-stack.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || join(ROOT, 'tests/out/agent-e2e');
mkdirSync(OUT, { recursive: true });
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + String(detail).slice(0, 400) : '')); errors.push(label); }
};
const section = s => console.log('\n── ' + s);

const S = await startStack();
const { BASE, db, as, until, doc, calls, todayAt } = S;
const now = Date.now(), DAY = 86400000;
const shot = (page, name) => page.screenshot({ path: join(OUT, name + '.png'), fullPage: false });
const noErrors = (page, where) => ok(`${where}: no errors in the page`, !page.__errors.length, page.__errors.slice(0, 4).join(' | '));

try {
  // ═══ Admin assigns a property on the Property dashboard ═══
  section('Swami (admin) assigns ADY002 to Rameez, Kavya as co-agent, on the Property dashboard');
  {
    const { ctx, page } = await as('swami', { viewport: { width: 1280, height: 860 } });
    await page.goto(BASE + '/dashboard.html');
    await page.waitForFunction(() => typeof properties !== 'undefined' && properties.some(p => p.id === 'ADY002'), null, { timeout: 25000 });
    await page.evaluate(() => openDetail('ADY002'));
    await page.waitForSelector('#dpAgents select');
    await until(() => page.evaluate(() => propTeam.length > 0));
    await page.evaluate(() => { renderPropAgents(properties.find(x => x.id === 'ADY002')); });
    await page.selectOption('#dpAgents select[aria-label="Primary agent"]', 'rameez@threepin.in');
    let p = await until(async () => { const d = await doc('properties', 'ADY002'); return d && d.assignedAgent === 'rameez@threepin.in' ? d : null; });
    ok('the primary agent is saved by the server', !!p);
    await page.waitForSelector('#dpAgents select.dp-add');
    await page.selectOption('#dpAgents select.dp-add', 'kavya@threepin.in');
    p = await until(async () => { const d = await doc('properties', 'ADY002'); return d && (d.secondaryAgents || []).includes('kavya@threepin.in') ? d : null; });
    ok('a co-agent is added (list + the old single field)', p && p.secondaryAgent === 'kavya@threepin.in', JSON.stringify(p && p.secondaryAgents));
    const log = await db.collection('assignmentLog').where('propertyId', '==', 'ADY002').get();
    ok('both changes are in the history', log.size === 2, log.size);
    await S.api('rameez', 'view');   // the agent opens a page: a property just given to him arrives
    const l1 = await doc('leads', 'lead_1');
    ok('the enquiry on ADY002 now reaches both its agents', JSON.stringify(l1.agentAccess) === JSON.stringify(['kavya@threepin.in', 'rameez@threepin.in']), JSON.stringify(l1.agentAccess));
    await until(() => page.evaluate(() => document.querySelectorAll('.dp-chip').length === 1));
    ok('the co-agent shows as a chip with a remove button', await page.evaluate(() => /Kavya/.test(document.querySelector('.dp-chip').textContent)));
    await shot(page, '01-dashboard-agents-panel');
    // Take Kavya off again: she stays only on her own VEL003.
    await page.click('.dp-chip button');
    p = await until(async () => { const d = await doc('properties', 'ADY002'); return d && !(d.secondaryAgents || []).length ? d : null; });
    ok('a co-agent is removed', !!p);
    ok('the enquiry leaves with her', !!(await until(async () => JSON.stringify((await doc('leads', 'lead_1')).agentAccess) === JSON.stringify(['rameez@threepin.in']))));
    noErrors(page, 'dashboard');
    await ctx.close();
  }

  // ═══ Rameez: home, menu, Properties ═══
  section('Rameez (agent) — My Day, the menu, his Properties');
  let rameez = await as('rameez');
  {
    const page = rameez.page;
    await page.goto(BASE + '/myday.html');
    await page.waitForSelector('#s-follow .item', { timeout: 25000 });
    ok('My Day greets him', /Rameez/.test(await page.textContent('#hello')));
    ok('his follow-up due today is listed', /Arjun Mehta/.test(await page.textContent('#s-follow')));
    await until(() => page.evaluate(() => /Ramesh Kumar/.test(document.querySelector('#s-new') && document.querySelector('#s-new').textContent)));
    ok('the new enquiry on his property is listed', /Ramesh Kumar/.test(await page.textContent('#s-new')));
    ok('nothing waits on him to approve', /Nothing waiting/.test(await page.textContent('#s-approve')));
    const tabbar = await page.evaluate(() => [...document.querySelectorAll('#pinTabbar a')].map(a => a.textContent.trim()));
    ok('phone tab bar: My Day, Properties, Messages, Leads, More', tabbar.join('|') === 'My Day|Properties|Messages|Leads|More', tabbar.join('|'));
    const menu = await page.evaluate(() => [...document.querySelectorAll('.rail-nav [data-item], .rail-nav .rl-sec-h, .rail-nav button')].map(x => x.textContent.trim()).join(' | '));
    ok('his menu has no Finance, Shoots, Team & access or Property dashboard', !/Finance|Shoot|Team &|Intelligence Dashboard/.test(menu), menu);
    await shot(page, '02-rameez-myday');
    noErrors(page, 'My Day (agent)');

    // His Properties: the Property dashboard itself, from his own copy (dashboard-assets/agent-mode.js).
    await page.goto(BASE + '/dashboard.html');
    await page.waitForFunction(() => window.PinAgent && window.PinAgent.view && document.querySelectorAll('#pgrid .card').length > 0, null, { timeout: 30000 });
    const grid = () => page.$$eval('#pgrid .card', cs => cs.map(c => c.textContent.replace(/\s+/g, ' ')));
    let cards = await grid();
    ok('the Property dashboard, from his copy: Mine shows only ADY002', cards.length === 1 && /Adyar/.test(cards[0]), cards.join(' || ').slice(0, 300));
    ok('his menu marks Properties as where he is', await page.evaluate(() => [...document.querySelectorAll('[aria-current="page"]')].some(a => /Properties/.test(a.textContent))));
    await page.evaluate(() => setAgentAccessFilter('all'));
    cards = await grid();
    ok('All: every active property, the sold villa left out', cards.length === 3 && !cards.some(t => /ECR/.test(t)), cards.length);
    ok('others are locked, with their agent named', cards.some(t => /Anna Nagar/.test(t) && /Locked/.test(t) && /Swami/.test(t)), cards.join(' || ').slice(0, 400));
    ok('no owner’s number or street on a locked card, and no Call', !cards.some(t => /9840012345|6th Avenue/.test(t)) && await page.evaluate(() => [...document.querySelectorAll('#pgrid .card.ag-locked')].every(c => !c.querySelector('.cta-call'))));
    await shot(page, '03-rameez-properties-all');
    // A locked property: the summary only, Overview only, and Request details.
    await page.evaluate(() => openDetail('ANR001'));
    await page.waitForSelector('#dp.open .ag-panel.locked');
    const locked = await page.evaluate(() => ({ text: document.getElementById('dp').textContent, tabs: [...document.querySelectorAll('.dp-tab')].filter(t => t.style.display !== 'none').map(t => t.textContent.trim()),
      office: [...document.querySelectorAll('#dp .dp-hact.danger, #dpSoldOut, #dp [onclick^="openEditModal"]')].every(b => getComputedStyle(b).display === 'none') }));
    ok('a locked property: the summary only — no street, no owner — and only its Overview', /Only this summary/.test(locked.text) && !/6th Avenue|9840012345|Mr Owner/.test(locked.text) && locked.tabs.join() === 'Overview', JSON.stringify(locked.tabs));
    ok('the office’s Edit, Delete and Mark Sold Out are not offered', locked.office);
    await shot(page, '04-rameez-locked-sheet');
    await page.click('.ag-panel [data-ag="ask"]');
    await page.waitForSelector('#aReason');
    await until(() => page.evaluate(() => document.querySelectorAll('#aClient option').length > 1));
    await page.selectOption('#aClient', 'lead_3');
    await page.fill('#aReason', 'My client Arjun wants a 3 BHK in Anna Nagar; can visit Saturday');
    await shot(page, '05-rameez-request-sheet');
    page.__lastDialog = null;
    await page.click('#aGo');
    const req = await until(async () => { const q = await db.collection('accessRequests').where('requesterEmail', '==', 'rameez@threepin.in').get(); return q.size ? { id: q.docs[0].id, ...q.docs[0].data() } : null; });
    ok('the request is saved, for the primary agent and the admins, with the client’s first name only', req && req.approvers.includes('swami@threepin.in') && req.approvers.includes('thirumal@threepin.in') && req.clientName === 'Arjun' && !('clientLeadId' in req), JSON.stringify(req && { a: req.approvers, c: req.clientName }));
    ok('…and the property’s code, for everyone on the request', req && req.targetCode === 'ANR001', req && req.targetCode);
    ok('sent without a “discard what you typed?” question, and the sheet is closed', !!(await until(() => page.evaluate(() => !document.querySelector('.sheet')))) && !page.__lastDialog, page.__lastDialog);
    ok('the property now says he asked', !!(await until(() => page.evaluate(() => /You asked/.test((document.querySelector('.ag-panel') || {}).textContent || '')))));
    await page.evaluate(() => closeDetail());
    ok('the card now says Details requested', !!(await until(() => page.evaluate(() => [...document.querySelectorAll('#pgrid .card')].some(c => /Anna Nagar/.test(c.textContent) && /Details requested/.test(c.textContent))))));
    // His own property in full: the owner's number, the buyers who match, availability and a note.
    await page.evaluate(() => { setAgentAccessFilter('mine'); openDetail('ADY002'); });
    await page.waitForSelector('#dp.open .ag-panel.mine');
    const own = await page.textContent('#dp');
    ok('his own property opens in full — address and owner’s number', /LB Road/.test(own) && /9840099999/.test(own));
    await page.click('.dp-tab:has-text("Matching Buyers")');
    await until(() => page.evaluate(() => !!document.querySelector('#dpAgMatches [data-mx="ask"]')));
    const mb = await page.textContent('#dpAgMatches');
    ok('a buyer with another agent who matches is shown without name or number', /2 BHK/.test(mb) && !/Divya|9222222222/.test(mb), mb.slice(0, 300));
    await shot(page, '06-rameez-own-property');
    await page.selectOption('.ag-panel select[data-ag="avail"]', 'On hold');
    ok('availability changes on his own property', !!(await until(async () => (await doc('properties', 'ADY002')).availability === 'On hold')));
    await page.click('.dp-tab:has-text("Notes & CRM")');
    await page.waitForSelector('#noteInput');
    await page.fill('#noteInput', 'Owner open to 92 L');
    await page.press('#noteInput', 'Enter');
    ok('a note is added (through the server)', !!(await until(async () => (await db.collection('properties').doc('ADY002').collection('notes').get()).docs.some(d => /92 L/.test(d.data().text)))));
    ok('…and the tab stays where he is after the availability change', await page.evaluate(() => document.querySelector('.dp-tab.active').textContent.includes('Notes')));
    await page.click('.dp-tab:has-text("Matching Buyers")');
    ok('…pointed to at the top of the tab', /with other agents also match/.test(await page.textContent('#dpAgJump')));
    ok('…each row says where his request stands: not asked yet', /Not asked yet/.test(await page.textContent('#dpAgMatches')));
    await page.click('#dpAgMatches [data-mx="ask"]');
    // Asked right on the row: a short note, already written for him — no pop-up.
    await page.waitForSelector('#dpAgMatches .mx-ask:not([hidden]) textarea');
    ok('…the note is pre-filled', (await page.inputValue('#dpAgMatches .mx-ask textarea')).length > 10);
    await page.fill('#dpAgMatches .mx-ask textarea', 'ADY002 fits her exactly');
    await page.click('#dpAgMatches [data-mx="send"]');
    ok('a request for the buyer’s number is sent', !!(await until(async () => (await db.collection('accessRequests').where('kind', '==', 'lead').get()).size === 1)));
    ok('…and the row says “Details requested” at once, with Cancel request', !!(await until(() => page.evaluate(() => /Details requested/.test(document.querySelector('#dpAgMatches').textContent) && !!document.querySelector('#dpAgMatches [data-mx="cancel"]')))));
    noErrors(page, 'Properties (agent)');
  }

  // ═══ Kavya sees nothing of it ═══
  section('Kavya (another agent) — her own only');
  {
    const { ctx, page } = await as('kavya');
    await page.goto(BASE + '/dashboard.html');
    await page.waitForFunction(() => window.PinAgent && window.PinAgent.view && document.querySelectorAll('#pgrid .card').length > 0, null, { timeout: 30000 });
    const mine = await page.$$eval('#pgrid .card', cs => cs.map(c => c.textContent));
    ok('Mine: only her VEL003', mine.length === 1 && /Velachery/.test(mine[0]), mine.join().slice(0, 200));
    const read = await page.evaluate(async () => {
      const fs = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js');
      const app = (await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js')).getApps()[0];
      const d = fs.getFirestore(app);
      const r = {};
      for (const [k, path] of [['lead3', 'leads/lead_3'], ['prop', 'properties/ANR001'], ['view', 'agentViews/t_3pinrealty__u_rameez']]) {
        try { await fs.getDoc(fs.doc(d, path)); r[k] = 'read'; } catch (e) { r[k] = e.code; }
      }
      return r;
    });
    ok('she cannot read Rameez’s lead, a property, or his copy (the rules)', Object.values(read).every(v => v === 'permission-denied'), JSON.stringify(read));
    noErrors(page, 'Properties (Kavya)');
    await ctx.close();
  }

  // ═══ Swami decides ═══
  section('Swami (admin) — approves in My Day, first decision wins');
  {
    const { ctx, page } = await as('swami');
    await page.goto(BASE + '/myday.html');
    await page.waitForSelector('#s-approve [data-decide]', { timeout: 25000 });
    ok('the property request waits on him', /Rameez asks for 3 BHK Apartment, Anna Nagar/.test(await page.textContent('#s-approve')));
    const card = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#s-approve .item')];
      const it = items.find(x => /Anna Nagar/.test(x.textContent)), a = it && it.querySelector('.pcode a');
      return it && { code: (it.querySelector('.pcode .code') || {}).textContent, href: a && a.getAttribute('href'), target: a && a.target,
        leadCode: items.filter(x => /matching buyer/i.test(x.textContent)).some(x => x.querySelector('.pcode')) };
    });
    ok('his card shows the property’s code and opens it in a new tab (an admin: the full property page)', card && card.code === 'ANR001' && card.href === 'property.html?id=ANR001' && card.target === '_blank', JSON.stringify(card));
    ok('…never a code on a buyer request (a lead’s id can carry the client’s number)', card && card.leadCode === false, JSON.stringify(card));
    await shot(page, '07-swami-myday-approvals');
    const btns = await page.$$('#s-approve [data-decide]');
    // The property request (not the lead one).
    for (const b of btns) { const t = await b.evaluate(x => x.closest('.item').textContent); if (/Anna Nagar/.test(t)) { await b.click(); break; } }
    await page.waitForSelector('#dGo');
    ok('the approve sheet shows the code and “Open property” in a new tab, to look before deciding', await page.evaluate(() => {
      const a = document.querySelector('.sheet .pcode a');
      return (document.querySelector('.sheet .pcode .code') || {}).textContent === 'ANR001' && a && a.getAttribute('href') === 'property.html?id=ANR001' && a.target === '_blank';
    }));
    await page.click('input[name=dDays][value="3"]');
    await page.check('#dShare');
    await page.click('input[name=dHours][value="24"]');
    await shot(page, '08-swami-approve-sheet');
    await page.click('#dGo');
    const g = await until(async () => { const q = await db.collection('grants').where('agentEmail', '==', 'rameez@threepin.in').where('kind', '==', 'property').get(); return q.size ? q.docs[0].data() : null; });
    ok('Rameez, on his Properties page, is told at once: “Approved by Swami”', !!(await until(() => rameez.page.evaluate(() => { const t = document.getElementById('pinInboxToast'); return t && !t.hidden && /Approved by Swami/.test(t.textContent); }))));
    ok('the grant: 3 days, owner’s number for 24 hours', g && g.expiresAt > now + 2.9 * DAY && g.includeContact && g.contactExpiresAt < now + 25 * 3600000, JSON.stringify(g && { e: g.expiresAt, c: g.contactExpiresAt }));
    // Thirumal pressing Approve a moment later: told it is already decided.
    const rid = (await db.collection('accessRequests').where('kind', '==', 'property').get()).docs[0].id;
    const second = await page.evaluate(async rid => {
      const q = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + btoa(JSON.stringify({ uid: 'u_thirumal', email: 'thirumal@threepin.in', tenantId: 't_3pinrealty', role: 'admin' })).replace(/=+$/, '') },
        body: JSON.stringify({ action: 'decide', id: rid, decision: 'reject', note: 'no' }) });
      return [q.status, (await q.json()).error];
    }, rid);
    ok('a second approver is told who decided first', second[0] === 409 && /Already approved by Swami/.test(second[1]), JSON.stringify(second));
    await until(() => page.evaluate(() => /Approved by Swami/.test(document.body.textContent) || !document.querySelector('#s-approve [data-decide]') || document.querySelectorAll('#s-approve [data-decide]').length === 1));
    noErrors(page, 'My Day (admin)');
    // The lead request: decided from Team & access → Requests.
    await page.goto(BASE + '/team.html?tab=requests');
    await page.waitForSelector('#requests [data-decide]', { timeout: 25000 });
    ok('Requests tab lists the buyer request and what is shared', /matching buyer/.test(await page.textContent('#requests')) && /Shared right now/.test(await page.textContent('#requests')));
    await shot(page, '09-team-requests');
    await page.click('#requests [data-decide]');
    await page.waitForSelector('#dGo');
    await page.click('#dGo');
    ok('approved: the buyer lead is opened to him by a grant (read-only, checked by the rules)', !!(await until(async () => { const g = await doc('grants', 't_3pinrealty__l__lead_2__rameez_threepin_in'); return g && g.active; })));
    noErrors(page, 'Team & access → Requests');
    await ctx.close();
  }

  // ═══ Rameez sees the result ═══
  section('Rameez — the shared property opens; the buyer is in his CRM');
  {
    const page = rameez.page;
    await page.goto(BASE + '/dashboard.html');
    await page.waitForFunction(() => window.PinAgent && window.PinAgent.view && properties.length > 0, null, { timeout: 30000 });
    await page.evaluate(() => setAgentAccessFilter('granted'));
    ok('Shared: ANR001 with its timer', !!(await until(() => page.evaluate(() => [...document.querySelectorAll('#pgrid .card')].some(c => /Anna Nagar/.test(c.textContent) && /Shared · (ends in|until)/.test(c.textContent))))));
    await page.evaluate(() => openDetail('ANR001'));
    await page.waitForSelector('#dp.open .ag-panel.granted');
    const t = await page.textContent('#dp');
    ok('…in full, with the owner’s number while that timer runs', /6th Avenue/.test(t) && /9840012345/.test(t));
    await shot(page, '10-rameez-shared-property');
    await page.goto(BASE + '/crm.html');
    await page.waitForFunction(() => typeof leads !== 'undefined' && leads.length >= 3, null, { timeout: 25000 });
    const ids = await page.evaluate(() => leads.map(l => l.id).sort());
    ok('his CRM: his lead, the enquiry on his property, the approved buyer — not Kavya’s', JSON.stringify(ids) === JSON.stringify(['lead_1', 'lead_2', 'lead_3']), JSON.stringify(ids));
    ok('team-only menus are hidden (stages, AI bot, digest)', await page.evaluate(() => getComputedStyle(document.querySelector('[onclick^="openStageManager"]')).display === 'none' && getComputedStyle(document.querySelector('[onclick^="openBotEditor"]')).display === 'none'));
    await page.evaluate(() => changeStage('lead_3', 'contacted'));
    ok('a stage change goes through the server', !!(await until(async () => (await doc('leads', 'lead_3')).stageId === 'contacted')));
    await page.evaluate(() => createLeadFromForm({ channel: 'phone', name: 'Duplicate Person', phone: '94444 44444', email: '', enquiryType: 'Property Enquiry', propertyInterest: '', budget: '', stageId: 'new', detailsSent: false, followUpAt: null, noteText: '' }));
    const errText = await until(() => page.evaluate(() => { const e = document.getElementById('lmErr'); return e && e.classList.contains('show') ? e.textContent : null; }));
    ok('a number already with the team is refused, without saying whose — inside the form, typed details kept', errText && /already with the team/.test(errText) && !/Kavya/.test(errText)
      && await page.evaluate(() => document.getElementById('lmName').value === 'Duplicate Person'), errText);
    await page.evaluate(() => typeof closeLeadModal === 'function' && closeLeadModal());
    ok('…and taken off his board again', await until(() => page.evaluate(() => !leads.some(l => l.name === 'Duplicate Person'))));
    await page.evaluate(() => createLeadFromForm({ channel: 'phone', name: 'Fresh Buyer', phone: '9555555555', email: '', enquiryType: 'Property Enquiry', propertyInterest: '2 BHK', budget: '', stageId: 'new', detailsSent: false, followUpAt: null, noteText: 'Met at the site' }));
    const fresh = await until(async () => { const q = await db.collection('leads').where('name', '==', 'Fresh Buyer').get(); return q.size ? q.docs[0].data() : null; });
    ok('a new lead is added as his', fresh && fresh.assignedAgent === 'rameez@threepin.in');
    ok('…with its first note', !!(await until(async () => fresh && (await db.collection('leads').doc(fresh.id).collection('notes').get()).size === 1)));
    await shot(page, '11-rameez-crm');
    noErrors(page, 'CRM (agent)');
  }

  // ═══ Messages ═══
  section('Messages — the people’s chat, the request’s card and thread, a reply, read ticks');
  {
    const page = rameez.page;
    await page.goto(BASE + '/messages.html');
    await page.waitForSelector('#threads .thread', { timeout: 25000 });
    const titles = await page.$$eval('#threads .thread b', bs => bs.map(b => b.textContent));
    // (26 Nov 2026: one chat per set of people — each request a card in it — not one chat per request.)
    ok('one chat with the people who decide, named after them', titles.some(t => /Swami/.test(t)) && !titles.some(t => /^3 BHK Apartment, Anna Nagar/.test(t)), titles.join(' | '));
    const anr = (await db.collection('accessRequests').where('requesterEmail', '==', 'rameez@threepin.in').where('targetId', '==', 'ANR001').get()).docs.map(d => d.data()).find(r => r.need === 'details' || !r.need);
    await page.click(`#threads [data-id="${anr.threadId}"]`);
    await page.waitForSelector('#msgs .rcard');
    const card = `#msgs [data-card="${anr.cardId}"]`;
    ok('the request is a card that says approved', !!(await until(() => page.evaluate(c => { const e = document.querySelector(c); return e && /You asked for/.test(e.textContent) && /Approved by Swami/.test(e.textContent); }, card))));
    ok('…with the property’s code — the asker gets no approver’s new-tab link (he has “Open property”)', await page.evaluate(c => !document.querySelector(c + ' .pcode a') && !!document.querySelector(c + ' a[href^="dashboard.html?property="]'), card));
    await page.click(card + ' .rc-thread');
    await page.waitForSelector('#side:not([hidden]) .rcard');
    const sys = await page.textContent('#sideBody');
    ok('its thread: approved with its timers', /Approved by Swami — details until/.test(sys) && /owner’s number until/.test(sys), sys.slice(0, 300));
    ok('the chat shows the approval small, at the card', await page.evaluate(() => [...document.querySelectorAll('#msgs .sysreq')].some(b => /ANR001 — Approved by Swami/.test(b.textContent))));
    await page.keyboard.press('Escape');
    await page.fill('#text', 'Thanks! Visiting Saturday 11 AM.');
    await page.click('#send');
    await page.waitForSelector('.bub.mine');
    ok('a sent message turns from a clock to ticks once saved', !!(await until(() => page.evaluate(() => !!document.querySelector('.bub.mine .tick')))));
    await shot(page, '12-rameez-chat');
    const th = await db.collection('threads').doc(await page.evaluate(() => new URLSearchParams(location.search).get('t'))).get();
    ok('his message is saved as the last line, by him', th && th.data().lastBy === 'rameez@threepin.in' && th.data().lastText === 'Thanks! Visiting Saturday 11 AM.', JSON.stringify(th && th.data()));
    const { ctx, page: sp } = await as('swami');
    await sp.goto(BASE + '/messages.html');
    await sp.waitForSelector('#threads .thread.unread', { timeout: 25000 });
    ok('Swami sees it unread', /Visiting Saturday/.test(await sp.textContent('#threads .thread.unread')));
    await sp.click('#threads .thread.unread');
    await sp.waitForSelector('.bub.them');
    ok('Swami’s read mark is saved (blue ticks once every member has read)', !!(await until(async () => { const d = (await db.collection('threads').doc(th.id).get()).data(); return d.reads && d.reads.swami_threepin_in >= d.lastAt - 5000; })));
    await sp.fill('#text', 'Great, the owner knows.');
    await sp.click('#send');
    ok('Rameez gets the reply live', !!(await until(() => page.evaluate(() => [...document.querySelectorAll('.bub.them')].some(b => /owner knows/.test(b.textContent))))));
    ok('Swami’s card: the code and the property in a new tab', await sp.evaluate(() => { const c = [...document.querySelectorAll('#msgs .rcard')].find(e => (e.querySelector('.pcode .code') || {}).textContent === 'ANR001'); const a = c && c.querySelector('.pcode a'); return a && a.target === '_blank' && a.getAttribute('href') === 'property.html?id=ANR001'; }));
    // Replies — Swami answers one message from the arrow beside it (a mouse)…
    await sp.hover('.bub.them:has-text("Visiting Saturday")');
    await sp.click('.bub.them:has-text("Visiting Saturday") .rp');
    await sp.waitForSelector('#replyBar:not([hidden])');
    const bar = await sp.textContent('#replyBar');
    ok('reply: the bar above the box says who is answered and quotes them', /Replying to Rameez/.test(bar) && /Visiting Saturday/.test(bar), bar);
    await sp.fill('#text', 'Saturday 11 is fine.');
    await sp.click('#send');
    const msgsOf = () => db.collection('threads').doc(th.id).collection('messages');
    const rep = await until(async () => { const q = await msgsOf().where('text', '==', 'Saturday 11 is fine.').get(); return q.size ? q.docs[0].data() : null; });
    const orig = (await msgsOf().where('text', '==', 'Thanks! Visiting Saturday 11 AM.').get()).docs[0];
    ok('reply: saved with the id of the message it answers (the rules check it is in this thread)', rep && orig && rep.replyTo === orig.id, JSON.stringify(rep));
    ok('reply: the bar is gone once sent', await sp.evaluate(() => document.getElementById('replyBar').hidden));
    ok('reply: Rameez sees his own words quoted (“You”) on top of the answer', !!(await until(() => page.evaluate(() => [...document.querySelectorAll('.bub.them')].some(b => {
      const q = b.querySelector('.quote');
      return q && /^You$/.test(q.querySelector('b').textContent) && /Visiting Saturday/.test(q.textContent) && /Saturday 11 is fine/.test(b.textContent);
    })))));
    // …tapping that quote goes back to the message it answers…
    await sp.click('.bub.mine .quote');
    ok('reply: tapping the quote goes to the message it answers', !!(await until(() => sp.evaluate(() => [...document.querySelectorAll('.bub.flash')].some(b => /Visiting Saturday/.test(b.textContent))))));
    // …and from the keyboard: Shift+Tab from the box reaches the newest message's arrow, Enter replies.
    await sp.focus('#text');
    // (Backwards from the box: past any request update shown small at the end, to the newest message's arrow.)
    for (let i = 0; i < 4; i++) { await sp.keyboard.press('Shift+Tab'); await sp.waitForTimeout(120); if (await sp.evaluate(() => document.activeElement && document.activeElement.classList.contains('rp'))) break; }
    await sp.waitForTimeout(150);
    const kb = await sp.evaluate(() => { const a = document.activeElement; return { rp: !!(a && a.classList.contains('rp')), shown: a ? getComputedStyle(a).opacity : '' }; });
    ok('reply: the keyboard reaches the reply arrow, and it shows when it has the focus', kb.rp && kb.shown === '1', JSON.stringify(kb));
    await sp.keyboard.press('Enter');
    ok('reply: Enter on it starts the reply', await sp.evaluate(() => !document.getElementById('replyBar').hidden && document.activeElement.id === 'text'));
    await sp.keyboard.press('Escape');
    // …and Rameez, on his phone, swipes Swami's message to the right to answer it.
    const swiped = await page.evaluate(async () => {
      const el = [...document.querySelectorAll('.bub.them')].find(b => /owner knows/.test(b.textContent));
      const r = el.getBoundingClientRect(), x = r.left + 30, y = r.top + r.height / 2;
      const fire = (type, dx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x + dx, clientY: y + dx / 20 }));
      fire('pointerdown', 0);
      for (const dx of [8, 16, 30, 48, 66, 80]) { fire('pointermove', dx); await new Promise(z => setTimeout(z, 16)); }
      fire('pointerup', 80);
      await new Promise(z => setTimeout(z, 60));
      const b = document.getElementById('replyBar');
      return { open: !b.hidden, text: b.textContent, back: el.style.translate === '' };
    });
    ok('reply: a swipe to the right on a phone starts a reply to that message, and the message springs back', swiped.open && /Replying to Swami/.test(swiped.text) && /owner knows/.test(swiped.text) && swiped.back, JSON.stringify(swiped));
    const scrolled = await page.evaluate(async () => {
      const el = [...document.querySelectorAll('.bub.them')].find(b => /owner knows/.test(b.textContent));
      document.getElementById('replyX').click();
      const r = el.getBoundingClientRect(), x = r.left + 30, y = r.top + r.height / 2;
      const fire = (type, d) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 8, pointerType: 'touch', isPrimary: true, clientX: x + d / 6, clientY: y - d }));
      fire('pointerdown', 0); for (const d of [10, 30, 60, 90]) fire('pointermove', d); fire('pointerup', 90);
      return document.getElementById('replyBar').hidden;
    });
    ok('reply: an up-and-down move is a scroll, not a reply', scrolled);
    await page.waitForTimeout(500);   // (a tap right after a swipe is ignored on purpose)
    await page.evaluate(() => [...document.querySelectorAll('.bub.them')].find(b => /owner knows/.test(b.textContent)).querySelector('.rp').click());
    ok('reply: the arrow starts one too', await page.evaluate(() => !document.getElementById('replyBar').hidden));
    await page.keyboard.press('Escape');
    ok('reply: Escape drops the reply and keeps the conversation open', await page.evaluate(() => document.getElementById('replyBar').hidden && !!document.getElementById('msgs')));
    // A real touch screen: a message arriving in the middle of a swipe must not break it (the list
    // waits to redraw until the finger lifts), the next swipe works too, and a tap shows the arrow.
    {
      const { ctx: tctx, page: tp } = await as('rameez', { touch: true });
      await tp.goto(BASE + '/messages.html?t=' + encodeURIComponent(th.id));
      await tp.waitForSelector('.bub.them', { timeout: 25000 });
      await tp.waitForTimeout(500);
      const cdp = await tctx.newCDPSession(tp);
      const swipeOn = async (text, midway) => {
        const el = tp.locator('.bub.them', { hasText: text }).last();
        await el.scrollIntoViewIfNeeded();
        const b = await el.boundingBox();
        const x0 = b.x + 30, y0 = b.y + b.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
        for (let dx = 6; dx <= 90; dx += 6) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx, y: y0 }] });
          await tp.waitForTimeout(16);
          if (dx === 36 && midway) await midway();
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await tp.waitForTimeout(200);
      };
      await swipeOn('owner knows', async () => {
        await db.collection('threads').doc(th.id).collection('messages').add({ kind: 'text', text: 'Also: bring the keys', at: Date.now(), by: 'swami@threepin.in' });
        await tp.waitForTimeout(600);   // it reaches the page while the finger is still down
      });
      ok('touch: a message arriving mid-swipe doesn’t break it — the reply starts', await tp.evaluate(() => !document.getElementById('replyBar').hidden && /owner knows/.test(document.getElementById('replyBar').textContent)));
      ok('…and that message shows once the finger lifts', !!(await until(() => tp.evaluate(() => /bring the keys/.test(document.getElementById('msgs').textContent)))));
      await tp.click('#replyX');
      await tp.waitForTimeout(450);
      await swipeOn('bring the keys');
      ok('touch: the next swipe works too', await tp.evaluate(() => /bring the keys/.test(document.getElementById('replyBar').textContent)));
      await tp.click('#replyX');
      await tp.waitForTimeout(450);
      const bubble = tp.locator('.bub.them', { hasText: 'owner knows' }).last();
      ok('touch: no arrow until asked for (a phone has no hover)', await bubble.evaluate(el => getComputedStyle(el.querySelector('.rp')).opacity === '0'));
      // (✕ put the cursor back in the box: the first tap only puts the keyboard away, as phones do.)
      await bubble.tap();
      await tp.waitForTimeout(250);
      ok('touch: a tap while typing only puts the keyboard away', await tp.evaluate(() => document.activeElement.id !== 'text' && !document.querySelector('#msgs .tapped')));
      await bubble.tap();
      await tp.waitForTimeout(250);
      ok('touch: tapping a message shows its reply arrow — a way without the swipe', await bubble.evaluate(el => el.classList.contains('tapped') && getComputedStyle(el.querySelector('.rp')).opacity === '1'));
      await bubble.locator('.rp').tap();
      ok('…and tapping the arrow starts the reply', await tp.evaluate(() => !document.getElementById('replyBar').hidden && /owner knows/.test(document.getElementById('replyBar').textContent)));
      noErrors(tp, 'Messages (touch screen)');
      await tctx.close();
    }
    await shot(sp, '13-swami-chat');
    noErrors(sp, 'Messages (admin)');
    await ctx.close();
    // New with no topic: the one chat with them (26 Nov 2026); with a topic: a separate group chat.
    await page.click('#back');
    await page.click('#newBtn');
    await page.waitForSelector('#nTitle');
    await page.click('#nPeople label:has-text("Swami")');
    await page.click('#nGo');
    ok('New with no topic opens the one chat with them', !!(await until(() => page.evaluate(() => /Swami/.test((document.querySelector('#chatTitle') || {}).textContent || '') && /Requests and messages/.test(document.querySelector('#chatTitle').textContent)))));
    await page.click('#back');
    await page.click('#newBtn');
    await page.waitForSelector('#nTitle');
    await page.click('#nPeople label:has-text("Swami")');
    await page.fill('#nTitle', 'Weekend visits');
    await page.click('#nGo');
    ok('…and opens once it has one', !!(await until(() => page.evaluate(() => /Weekend visits/.test((document.querySelector('#chatTitle') || {}).textContent || '')))));
    await page.fill('#text', 'Free on Sunday?');
    await page.click('#send');
    const wk = await until(async () => { const q = await db.collection('threads').where('title', '==', 'Weekend visits').get(); return q.size ? q.docs[0] : null; });
    const { ctx: c2, page: s2 } = await as('swami');
    await s2.goto(BASE + '/messages.html?t=' + encodeURIComponent(wk.id));
    await s2.waitForSelector('.bub.them', { timeout: 25000 });
    const blue = !!(await until(() => page.evaluate(() => !!document.querySelector('.bub.mine .tick.read'))));
    ok('two of them: the tick turns blue once Swami has read it', blue, JSON.stringify((await db.collection('threads').doc(wk.id).get()).data()) + ' swami errors: ' + s2.__errors.join('|'));
    await c2.close();
    noErrors(page, 'Messages (agent)');
  }

  section('The request card’s buttons work (an approver deciding from the conversation)');
  {
    const page = rameez.page;
    // A property of his that is on the market (ADY002 was put on hold earlier in this run).
    await db.collection('properties').doc('RMZ009').set({ tenantId: S.T, id: 'RMZ009', propertyCode: 'RMZ009', name: '3 BHK, Mogappair', config: '3 BHK', startingPrice: '₹1.1 Cr', zone: 'Mogappair', availability: 'Available', assignedAgent: 'rameez@threepin.in' });
    const k = await S.api('kavya', 'request', { kind: 'property', targetId: 'RMZ009', reason: 'My client wants Mogappair' });
    await page.goto(BASE + '/messages.html?t=' + encodeURIComponent(k.threadId));
    await page.waitForSelector('#msgs [data-cmore]', { timeout: 25000 });
    await page.click('#msgs [data-cmore]');
    ok('“More options” on the card opens the decision', !!(await until(() => page.evaluate(() => !!document.querySelector('#dGo')))));
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => !document.querySelector('.sheet')));
    // On a laptop, with the menu expanded: the conversation beside the list, the card's button there.
    const { ctx: lc, page: lp } = await as('swami', { viewport: { width: 1440, height: 900 } });
    await lp.goto(BASE + '/messages.html?t=' + encodeURIComponent(k.threadId));
    await lp.waitForSelector('#msgs [data-cmore]', { timeout: 25000 });
    const geo = await lp.evaluate(() => ({ chat: document.getElementById('chat').getBoundingClientRect().left, list: document.getElementById('threads').getBoundingClientRect().right, rail: document.body.classList.contains('rail-on') }));
    ok('laptop: the open conversation sits beside the list (menu expanded)', geo.rail && geo.chat >= geo.list - 2, JSON.stringify(geo));
    ok('laptop: the card’s decision buttons show', await lp.evaluate(() => { const b = document.querySelector('#msgs [data-cmore]'); return !!b && b.getBoundingClientRect().height > 0; }));
    await lp.click('#msgs [data-cmore]');
    ok('laptop: and it opens the decision', !!(await until(() => lp.evaluate(() => !!document.querySelector('#dGo')))));
    await lc.close();
  }

  section('Badges on every page');
  {
    const page = rameez.page;
    const t = (await db.collection('threads').where('title', '==', 'Weekend visits').get()).docs[0];
    await t.ref.collection('messages').add({ kind: 'text', text: 'Yes, Sunday works', at: Date.now(), by: 'swami@threepin.in' });
    await t.ref.update({ lastAt: Date.now(), lastText: 'Yes, Sunday works', lastBy: 'swami@threepin.in' });
    await page.goto(BASE + '/crm.html');
    ok('in the CRM, the Messages tab shows something new', !!(await until(() => page.evaluate(() => { const a = document.querySelector('#pinTabbar a[data-item="messages"] .tb-n'); return a && Number(a.textContent) >= 1; }))));
  }

  // ═══ A visit on a colleague's property ═══
  section('A site visit Rameez books on Swami’s property — Swami is told, client’s first name only');
  {
    const page = rameez.page;
    await page.goto(BASE + '/crm.html');
    await page.waitForFunction(() => typeof leads !== 'undefined' && leads.length >= 3, null, { timeout: 25000 });
    const at = todayAt(17);
    const r = await page.evaluate(async at => {
      const l = leads.find(x => x.id === 'lead_3');
      Object.assign(l, { siteVisitAt: at, siteVisitStatus: 'scheduled', siteVisitProperty: 'ANR001', siteVisitBy: 'rameez@threepin.in' });
      await window.crmFirebase.saveLead(l);
      const tok = await window.crmAuth.getIdToken();
      const q = await fetch('/api/tailortalk?action=calendar', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ op: 'visit', leadId: 'lead_3', visit: { siteVisitAt: at, siteVisitStatus: 'scheduled', siteVisitProperty: 'ANR001' } }) });
      return q.status;
    }, at);
    const alerts = await until(async () => { const q = await db.collection('visitAlerts').get(); return q.size ? q.docs.map(d => d.data()) : null; });
    ok('one alert, to Swami, with the client’s first name only', alerts && alerts.length === 1 && alerts[0].to.join() === 'swami@threepin.in' && alerts[0].clientName === 'Arjun' && !JSON.stringify(alerts).includes('9333333333'), JSON.stringify(alerts));
    const { ctx, page: sp } = await as('swami');
    await sp.goto(BASE + '/myday.html');
    await sp.waitForSelector('#s-visits .item', { timeout: 25000 });
    ok('Swami’s My Day: “Collaboration visit” today', /Collaboration visit/.test(await sp.textContent('#s-visits')) && /Rameez \(agent\) booked a visit for their client Arjun/.test(await sp.textContent('#s-visits')));
    await shot(sp, '14-swami-collab-visit');
    // An admin takes the access back.
    await sp.goto(BASE + '/team.html?tab=requests');
    await sp.waitForSelector('#requests [data-a="revoke"]', { timeout: 25000 });
    await sp.click('#requests [data-a="hide-contact"]');
    ok('Hide number: the owner’s number is off', !!(await until(async () => { const q = await db.collection('grants').where('kind', '==', 'property').where('agentEmail', '==', 'rameez@threepin.in').get(); return q.docs[0].data().includeContact === false; })));
    await rameez.page.goto(BASE + '/myday.html');
    ok('…but the details are still shared: Rameez keeps “Open property”', !!(await until(() => rameez.page.evaluate(() => /owner’s number hidden/.test(document.body.textContent) && [...document.querySelectorAll('a.btn')].some(a => /Open property/.test(a.textContent))))));
    // The list redraws when the number is hidden: press Take back on the redrawn row.
    await until(() => sp.evaluate(() => !document.querySelector('#requests [data-a="hide-contact"]') && !!document.querySelector('#requests [data-a="revoke"]')));
    await sp.evaluate(() => [...document.querySelectorAll('#requests .item')].find(i => /Anna Nagar/.test(i.textContent) && i.querySelector('[data-a="revoke"]')).querySelector('[data-a="revoke"]').click());
    ok('Take back: the grant ends', !!(await until(async () => { const q = await db.collection('grants').where('kind', '==', 'property').get(); return q.docs[0].data().active === false; })));
    noErrors(sp, 'Team (admin) revoke');
    await ctx.close();
    await page.goto(BASE + '/dashboard.html');
    await page.waitForFunction(() => window.PinAgent && window.PinAgent.view && properties.length > 0, null, { timeout: 30000 });
    await page.evaluate(() => setAgentAccessFilter('all'));
    ok('Rameez: ANR001 is locked again', !!(await until(() => page.evaluate(() => [...document.querySelectorAll('#pgrid .card')].some(c => /Anna Nagar/.test(c.textContent) && /Locked/.test(c.textContent))))));
  }

  // ═══ Staff and admin keep everything ═══
  section('Rajesh (full access) — works as before, plus My Day and Messages');
  {
    const { ctx, page } = await as('rajesh', { viewport: { width: 1280, height: 860 } });
    await page.goto(BASE + '/crm.html');
    await page.waitForFunction(() => typeof leads !== 'undefined' && leads.length >= 5, null, { timeout: 25000 });
    ok('he sees every lead, as before', await page.evaluate(() => leads.length >= 5));
    ok('…and no agent tab bar', await page.evaluate(() => !document.getElementById('pinTabbar')));
    await page.goto(BASE + '/listings.html');
    await page.waitForURL(/dashboard\.html/, { timeout: 15000 });
    await page.waitForFunction(() => typeof properties !== 'undefined' && properties.length >= 3, null, { timeout: 25000 });
    ok('an old Properties link sends him to the full dashboard — every property, no agent view', await page.evaluate(() => !window.PinAgent && properties.length >= 4 && properties.some(p => p.contactNumber)));
    await page.goto(BASE + '/myday.html');
    await page.waitForSelector('#sections .card', { timeout: 25000 });
    ok('My Day opens for him too', /Good|day/.test(await page.textContent('#hello')));
    noErrors(page, 'My Day (staff)');
    await ctx.close();
  }

  section('Property links for an agent — the property, on his dashboard');
  {
    const page = rameez.page;
    const at = id => page.evaluate(id => typeof currentDetailId !== 'undefined' && currentDetailId === id && document.getElementById('dp').classList.contains('open'), id);
    await page.goto(BASE + '/dashboard.html?property=ADY002');
    ok('a dashboard link opens his own property', !!(await until(async () => (await at('ADY002')) && page.evaluate(() => !!document.querySelector('.ag-panel.mine')))));
    await page.goto(BASE + '/listings.html?id=ADY002');
    ok('an old Properties link lands on the same property', !!(await until(async () => /dashboard\.html/.test(page.url()) && (await at('ADY002')))), page.url());
    await page.goto(BASE + '/property.html?id=ANR001');
    ok('a shared property link opens its summary for him, locked', !!(await until(async () => (await at('ANR001')) && page.evaluate(() => !!document.querySelector('.ag-panel.locked')))));
    noErrors(page, 'Property links (agent)');
  }

  // ═══ Screens: desktop and dark ═══
  section('Screens: desktop and dark');
  for (const [key, path, name] of [['rameez', '/myday.html', '20-desktop-myday'], ['rameez', '/dashboard.html', '21-desktop-properties'], ['swami', '/messages.html', '22-desktop-messages']]) {
    const { ctx, page } = await as(key, { viewport: { width: 1280, height: 820 } });
    await page.goto(BASE + path);
    await page.waitForTimeout(2500);
    await shot(page, name);
    ok(`${name}: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await ctx.close();
  }
  for (const [key, path, name] of [['rameez', '/myday.html', '23-dark-myday'], ['rameez', '/dashboard.html', '24-dark-properties'], ['rameez', '/messages.html', '25-dark-messages']]) {
    const { ctx, page } = await as(key, { dark: true });
    await page.goto(BASE + path);
    await page.waitForTimeout(2500);
    await shot(page, name);
    ok(`${name}: no sideways scroll on a phone`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await ctx.close();
  }
} catch (e) {
  console.error(e);
  errors.push('crashed: ' + e.message);
} finally {
  await S.stop();
}
console.log(errors.length ? `\n${errors.length} failed:\n  · ` + errors.join('\n  · ') : '\nAll good.');
process.exit(errors.length ? 1 : 0);
