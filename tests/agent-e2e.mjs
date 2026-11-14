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

    await page.goto(BASE + '/listings.html');
    await page.waitForSelector('#list .pcard', { timeout: 25000 });
    const mine = await page.$$eval('#list .pcard b', bs => bs.map(b => b.textContent));
    ok('Mine: only ADY002', mine.length === 1 && /Adyar/.test(mine[0]), mine.join(', '));
    await page.click('#tabs [data-tab="all"]');
    const all = await page.$$eval('#list .pcard', cs => cs.map(c => c.textContent));
    ok('All: every active property, the sold villa left out', all.length === 3 && !all.some(t => /ECR/.test(t)), all.length);
    ok('others are locked, with their agent named', all.some(t => /Anna Nagar/.test(t) && /Locked/.test(t) && /Swami/.test(t)));
    await shot(page, '03-rameez-properties-all');
    // The locked card: summary only.
    await page.click('.pcard[data-id="ANR001"]');
    await page.waitForSelector('.sheet');
    const sheet = await page.textContent('.sheet');
    ok('a locked property shows the summary only — no street, no owner', /Only this summary/.test(sheet) && !/6th Avenue|9840012345|Mr Owner/.test(sheet), sheet.slice(0, 200));
    await shot(page, '04-rameez-locked-sheet');
    await page.click('#pAsk');
    await page.waitForSelector('#aReason');
    await until(() => page.evaluate(() => document.querySelectorAll('#aClient option').length > 1));
    await page.selectOption('#aClient', 'lead_3');
    await page.fill('#aReason', 'My client Arjun wants a 3 BHK in Anna Nagar; can visit Saturday');
    await shot(page, '05-rameez-request-sheet');
    await page.click('#aGo');
    const req = await until(async () => { const q = await db.collection('accessRequests').where('requesterEmail', '==', 'rameez@threepin.in').get(); return q.size ? { id: q.docs[0].id, ...q.docs[0].data() } : null; });
    ok('the request is saved, for the primary agent and the admins, with the client’s first name only', req && req.approvers.includes('swami@threepin.in') && req.approvers.includes('thirumal@threepin.in') && req.clientName === 'Arjun' && !('clientLeadId' in req), JSON.stringify(req && { a: req.approvers, c: req.clientName }));
    await until(() => page.evaluate(() => /Asked/.test(document.querySelector('.pcard[data-id="ANR001"]').textContent)));
    ok('the card now says Asked', /Asked/.test(await page.textContent('.pcard[data-id="ANR001"]')));
    // His own property in full, with a matching buyer.
    await page.click('#tabs [data-tab="mine"]');
    await page.click('.pcard[data-id="ADY002"]');
    await page.waitForSelector('.sheet .kv');
    const own = await page.textContent('.sheet');
    ok('his own property opens in full — address and owner’s number', /LB Road/.test(own) && /9840099999/.test(own));
    ok('a matching buyer is shown without name or number', /Matching buyers/.test(own) && /2 BHK/.test(own) && !/Divya|9222222222/.test(own), own.slice(own.indexOf('Matching'), own.indexOf('Matching') + 300));
    await shot(page, '06-rameez-own-property');
    await page.selectOption('#pAvail', 'On hold');
    ok('availability changes on his own property', !!(await until(async () => (await doc('properties', 'ADY002')).availability === 'On hold')));
    await page.fill('#pNote', 'Owner open to 92 L');
    await page.click('#pNoteGo');
    ok('a note is added', !!(await until(async () => (await db.collection('properties').doc('ADY002').collection('notes').get()).docs.some(d => /92 L/.test(d.data().text)))));
    await page.click('[data-askref]');
    await page.waitForSelector('#lReason');
    await page.fill('#lReason', 'ADY002 fits her exactly');
    await page.click('#lGo');
    ok('a request for the buyer’s number is sent', !!(await until(async () => (await db.collection('accessRequests').where('kind', '==', 'lead').get()).size === 1)));
    noErrors(page, 'Properties (agent)');
  }

  // ═══ Kavya sees nothing of it ═══
  section('Kavya (another agent) — her own only');
  {
    const { ctx, page } = await as('kavya');
    await page.goto(BASE + '/listings.html');
    await page.waitForSelector('#list .pcard', { timeout: 25000 });
    const mine = await page.$$eval('#list .pcard b', bs => bs.map(b => b.textContent));
    ok('Mine: only her VEL003', mine.length === 1 && /Velachery/.test(mine[0]), mine.join());
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
    await shot(page, '07-swami-myday-approvals');
    const btns = await page.$$('#s-approve [data-decide]');
    // The property request (not the lead one).
    for (const b of btns) { const t = await b.evaluate(x => x.closest('.item').textContent); if (/Anna Nagar/.test(t)) { await b.click(); break; } }
    await page.waitForSelector('#dGo');
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
    await page.goto(BASE + '/listings.html');
    await page.waitForSelector('#list .pcard', { timeout: 25000 });
    await page.click('#tabs [data-tab="granted"]');
    await until(() => page.evaluate(() => !!document.querySelector('.pcard[data-id="ANR001"]')));
    ok('Shared tab: ANR001 with its timer', /Shared · (ends in|until)/.test(await page.textContent('.pcard[data-id="ANR001"]')));
    await page.click('.pcard[data-id="ANR001"]');
    await page.waitForSelector('.sheet .kv');
    const t = await page.textContent('.sheet');
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
  section('Messages — the request’s thread, a reply, read ticks');
  {
    const page = rameez.page;
    await page.goto(BASE + '/messages.html');
    await page.waitForSelector('#threads .thread', { timeout: 25000 });
    const titles = await page.$$eval('#threads .thread b', bs => bs.map(b => b.textContent));
    ok('a thread per request (titled by what it is about)', titles.some(t => /^3 BHK Apartment, Anna Nagar · for Arjun$/.test(t)), titles.join(' | '));
    await page.click('#threads .thread:has-text("Anna Nagar")');
    await page.waitForSelector('#msgs .sys');
    const sys = await page.textContent('#msgs');
    ok('the system lines: asked, approved with its timers', /asked for the details/.test(sys) && /Approved by Swami — details until/.test(sys) && /owner’s number until/.test(sys), sys.slice(0, 300));
    ok('the pinned card says approved', !!(await until(() => page.evaluate(() => /Approved by Swami/.test(document.querySelector('#pinned').textContent)))));
    await page.fill('#text', 'Thanks! Visiting Saturday 11 AM.');
    await page.click('#send');
    await page.waitForSelector('.bub.mine');
    ok('a sent message turns from a clock to ticks once saved', !!(await until(() => page.evaluate(() => !!document.querySelector('.bub.mine .tick')))));
    await shot(page, '12-rameez-chat');
    const th = (await db.collection('threads').where('type', '==', 'access_request').get()).docs.find(d => /Anna Nagar/.test(d.data().title));
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
    await shot(sp, '13-swami-chat');
    noErrors(sp, 'Messages (admin)');
    await ctx.close();
    // A new conversation needs a title.
    await page.click('#back');
    await page.click('#newBtn');
    await page.waitForSelector('#nTitle');
    await page.click('#nPeople label:has-text("Swami")');
    await page.click('#nGo');
    ok('a conversation needs a title', /title/i.test(await page.textContent('#nErr')));
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

  section('The pinned card’s buttons work (an approver deciding from the conversation)');
  {
    const page = rameez.page;
    // A property of his that is on the market (ADY002 was put on hold earlier in this run).
    await db.collection('properties').doc('RMZ009').set({ tenantId: S.T, id: 'RMZ009', propertyCode: 'RMZ009', name: '3 BHK, Mogappair', config: '3 BHK', startingPrice: '₹1.1 Cr', zone: 'Mogappair', availability: 'Available', assignedAgent: 'rameez@threepin.in' });
    const k = await S.api('kavya', 'request', { kind: 'property', targetId: 'RMZ009', reason: 'My client wants Mogappair' });
    await page.goto(BASE + '/messages.html?t=' + encodeURIComponent(k.threadId));
    await page.waitForSelector('#pDecide', { timeout: 25000 });
    await page.click('#pDecide');
    ok('“Approve or reject” on the pinned card opens the decision', !!(await until(() => page.evaluate(() => !!document.querySelector('#dGo')))));
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => !document.querySelector('.sheet')));
    // On a laptop, with the menu expanded: the conversation beside the list, the card's button there.
    const { ctx: lc, page: lp } = await as('swami', { viewport: { width: 1440, height: 900 } });
    await lp.goto(BASE + '/messages.html?t=' + encodeURIComponent(k.threadId));
    await lp.waitForSelector('#pDecide', { timeout: 25000 });
    const geo = await lp.evaluate(() => ({ chat: document.getElementById('chat').getBoundingClientRect().left, list: document.getElementById('threads').getBoundingClientRect().right, rail: document.body.classList.contains('rail-on') }));
    ok('laptop: the open conversation sits beside the list (menu expanded)', geo.rail && geo.chat >= geo.list - 2, JSON.stringify(geo));
    ok('laptop: the decision button shows while the reply box has the cursor', await lp.evaluate(() => { const b = document.getElementById('pDecide'); return !!b && b.getBoundingClientRect().height > 0; }));
    await lp.click('#pDecide');
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
    await page.goto(BASE + '/listings.html');
    await page.waitForSelector('#list .pcard, #list .empty', { timeout: 25000 });
    await page.click('#tabs [data-tab="all"]');
    await until(() => page.evaluate(() => /Locked/.test((document.querySelector('.pcard[data-id="ANR001"]') || {}).textContent || '')));
    ok('Rameez: ANR001 is locked again', /Locked/.test(await page.textContent('.pcard[data-id="ANR001"]')));
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
    ok('the agent Properties page sends him to the full dashboard', true);
    await page.goto(BASE + '/myday.html');
    await page.waitForSelector('#sections .card', { timeout: 25000 });
    ok('My Day opens for him too', /Good|day/.test(await page.textContent('#hello')));
    noErrors(page, 'My Day (staff)');
    await ctx.close();
  }

  section('Rameez on the Property dashboard link → his own Properties');
  {
    const page = rameez.page;
    await page.goto(BASE + '/dashboard.html?id=ADY002');
    await page.waitForURL(/listings\.html\?id=ADY002/, { timeout: 20000 }).catch(() => {});
    ok('sent to listings.html at the same property', /listings\.html\?id=ADY002/.test(page.url()), page.url());
  }

  // ═══ Screens: desktop and dark ═══
  section('Screens: desktop and dark');
  for (const [key, path, name] of [['rameez', '/myday.html', '20-desktop-myday'], ['rameez', '/listings.html', '21-desktop-properties'], ['swami', '/messages.html', '22-desktop-messages']]) {
    const { ctx, page } = await as(key, { viewport: { width: 1280, height: 820 } });
    await page.goto(BASE + path);
    await page.waitForTimeout(2500);
    await shot(page, name);
    ok(`${name}: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await ctx.close();
  }
  for (const [key, path, name] of [['rameez', '/myday.html', '23-dark-myday'], ['rameez', '/listings.html', '24-dark-properties'], ['rameez', '/messages.html', '25-dark-messages']]) {
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
