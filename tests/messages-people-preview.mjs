// ═══════ MESSAGES — ONE CHAT PER SET OF PEOPLE, EACH REQUEST A CARD ═══════
//
//   node tests/messages-people-preview.mjs
//
// The whole local stack (tests/_agent-stack.mjs: Firestore emulator with the real rules, the real
// server, Chrome). Before 26 Nov 2026 every request opened its own chat; now a set of people has one
// chat, each request is a card in it (Approve / Reject on the card, status live), and everything
// about one request is in the card's own thread beside the chat. An old one-request chat is folded
// in when Messages opens. Screenshots: tests/out/messages-people-*.png. Asked for by the owner.
import { startStack } from './_agent-stack.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(fileURLToPath(new URL('..', import.meta.url)), 'tests/out');
mkdirSync(OUT, { recursive: true });
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); errors.push(label); }
};

const S = await startStack({ emuPort: 8486, webPort: 8587, rich: true });
console.log('Messages — one chat per set of people');
try {
  const T = S.T, now = Date.now();
  // Three more requests from Rameez on Swami's / the office's properties: the same people decide them.
  const ids = [];
  for (const [code, why] of [['OMR014', 'Asking again — client is keen'], ['ANR001', 'interested in the property'], ['ADY002', 'interested in property']]) {
    const r = await S.api('rameez', 'request', { kind: 'property', targetId: code, reason: why });
    if (r.id) ids.push(r.id);
  }
  const docs = await Promise.all(ids.map(id => S.db.collection('accessRequests').doc(id).get().then(d => ({ ...d.data(), id }))));
  const sets = new Set(docs.map(d => d.threadId));
  ok('Requests between the same people land in ONE chat', ids.length === 3 && docs.every(d => d.cardId) && sets.size <= 2, docs.map(d => [d.targetId, d.threadId, (d.approvers || []).join(',')]));
  const th = (await S.db.collection('threads').doc(docs[0].threadId).get()).data();
  ok('…a people’s chat (type direct), not one per request', th.type === 'direct' && th.members.includes('rameez@threepin.in'), th);
  const card = (await S.db.collection('threads').doc(docs[0].threadId).collection('messages').doc(docs[0].cardId).get()).data();
  ok('…each request is a card in it', card && card.kind === 'request' && card.requestId === ids[0], card);

  // An old-style chat (one per request, from before 26 Nov), to be folded in.
  const oldReq = S.db.collection('accessRequests').doc('old_req_1'), oldTh = S.db.collection('threads').doc(T + '__access_request__oldone');
  await oldReq.set({ tenantId: T, kind: 'property', need: 'details', targetId: 'VEL003', targetCode: 'VEL003', title: '1 BHK, Velachery', requesterUid: 'u_rameez', requesterEmail: 'rameez@threepin.in', requesterName: 'Rameez',
    approvers: th.members.filter(e => e !== 'rameez@threepin.in'), status: 'approved', decidedBy: 'swami@threepin.in', decidedByName: 'Swami', decidedAt: now - 2 * 86400000, createdAt: now - 3 * 86400000, threadId: oldTh.id, terms: { until: now + 4 * 86400000 } });
  await oldTh.set({ tenantId: T, title: 'Access: 1 BHK, Velachery', type: 'access_request', linkedId: 'old_req_1', members: th.members, names: {}, createdBy: 'rameez@threepin.in', createdAt: now - 3 * 86400000, lastAt: now - 2 * 86400000, lastText: 'Approved by Swami', lastBy: null, reads: {} });
  await oldTh.collection('messages').doc('o1').set({ kind: 'system', text: 'Rameez asked for the details of 1 BHK, Velachery', at: now - 3 * 86400000, by: null, requestId: 'old_req_1' });
  await oldTh.collection('messages').doc('o2').set({ kind: 'text', text: 'Is the client serious?', at: now - 3 * 86400000 + 60000, by: 'swami@threepin.in' });
  await oldTh.collection('messages').doc('o3').set({ kind: 'text', text: 'Yes, visiting Saturday', at: now - 3 * 86400000 + 120000, by: 'rameez@threepin.in' });
  await oldTh.collection('messages').doc('o4').set({ kind: 'system', text: 'Approved by Swami — details until Sunday', at: now - 2 * 86400000, by: null, requestId: 'old_req_1' });

  const { page, ctx } = await S.as('swami', { viewport: { width: 1366, height: 900 } });
  await page.goto(S.BASE + '/messages.html');
  await page.waitForSelector('#threads .thread', { timeout: 30000 });
  await S.until(async () => (await oldTh.get()).data().foldedInto, 20000);
  const folded = (await oldTh.get()).data();
  ok('The old one-request chat is folded into the people’s chat', folded.foldedInto === docs[0].threadId || sets.has(folded.foldedInto), folded.foldedInto);
  const or = (await oldReq.get()).data();
  ok('…its request now points at the card there', or.threadId === folded.foldedInto && /^fold_/.test(or.cardId || ''), or);
  const fm = (await S.db.collection('threads').doc(folded.foldedInto).collection('messages').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  ok('…its messages became the card’s replies (nothing lost)', fm.filter(m => m.replyTo === or.cardId).length === 3 && fm.some(m => m.id === or.cardId && m.kind === 'request'), fm.filter(m => /^fold_/.test(m.id)).map(m => [m.kind, m.text, m.replyTo]));
  await page.waitForTimeout(800);
  const rows = await page.$$eval('#threads .thread', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('The list shows the chat by name, not one row per request', rows.some(r => /^RA? ?Rameez/.test(r) || /Rameez/.test(r)) && !rows.some(r => /^Access:|Velachery$/.test(r)), rows);
  ok('…with how many wait on me', rows.some(r => /Rameez/.test(r) && /\d+ waiting/.test(r)), rows);
  ok('…no folded chat is listed', !(await page.$(`#threads [data-id="${oldTh.id}"]`)));
  await page.click(`#threads [data-id="${docs[0].threadId}"]`);
  await page.waitForSelector('#msgs .rcard', { timeout: 15000 });
  await S.until(() => page.evaluate(() => !document.querySelector('#msgs .rcard [data-capprove][disabled]') && !document.querySelector('#msgs .rcard.loading')), 15000);
  const cards = await page.$$eval('#msgs .rcard', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('The chat shows each request as a card', cards.length >= 4 && cards.some(c => /OMR014/.test(c)) && cards.some(c => /VEL003/.test(c)), cards.length);
  ok('…a waiting card has Approve / Reject / More options', await page.$$eval('#msgs .rcard.open', els => els.some(e => e.querySelector('[data-capprove]') && e.querySelector('[data-creject]') && e.querySelector('[data-cmore]'))));
  ok('…the old (folded) one shows its status and "2 replies"', cards.some(c => /VEL003/.test(c) && /Approved by you/.test(c) && /2 replies/.test(c)), cards.find(c => /VEL003/.test(c)));
  ok('…its old talk is not in the chat itself, its approval is (small)', !(await page.$$eval('#msgs .bub', b => b.some(x => /Is the client serious/.test(x.textContent)))) && await page.$$eval('#msgs .sysreq', b => b.some(x => /VEL003 — Approved by Swami/.test(x.textContent))));
  ok('The strip on top: requests waiting on me, Approve all', /waiting on you/.test(await page.textContent('#pinned')) && !!(await page.$('#pinned [data-approveall]')));
  await page.screenshot({ path: join(OUT, 'messages-people-light.png') });

  // A request's own thread.
  await page.click(`#msgs [data-card="${docs[1].cardId}"] .rc-thread`);
  await page.waitForSelector('#side:not([hidden]) .rcard', { timeout: 5000 });
  ok('Reply on a card opens its thread beside the chat', /ANR001/.test(await page.textContent('#sideT')));
  await page.fill('#sideText', 'Which client is this for?');
  await page.click('#sideCompose .send');
  await S.until(async () => (await S.db.collection('threads').doc(docs[1].threadId).collection('messages').where('replyTo', '==', docs[1].cardId).get()).size > 0, 10000);
  ok('…the reply is saved as an answer to the card (the rules allow it)', true);
  await S.until(() => page.evaluate(() => /Which client/.test(document.getElementById('sideBody').textContent)), 8000);
  ok('…shows in the thread', /Which client is this for\?/.test(await page.textContent('#sideBody')));
  ok('…not in the chat; the card says "1 reply"', !(await page.$$eval('#msgs .bub', b => b.some(x => /Which client/.test(x.textContent)))) && /1 reply/.test(await page.textContent(`#msgs [data-card="${docs[1].cardId}"]`)));
  ok('…and the chat list names the request', /ANR001 — Which client/.test((await S.db.collection('threads').doc(docs[1].threadId).get()).data().lastText));
  await page.screenshot({ path: join(OUT, 'messages-people-thread.png') });
  // Approve from the card in the thread.
  await page.click('#sideBody [data-capprove]');
  await S.until(async () => (await S.db.collection('accessRequests').doc(ids[1]).get()).data().status === 'approved', 15000);
  ok('Approve on the card approves it', true);
  await S.until(() => page.evaluate(() => /Approved by you/.test(document.getElementById('sideBody').textContent)), 8000);
  ok('…the card turns "Approved by you", and the thread has the line', /Approved by you/.test(await page.textContent('#sideBody .rcard')) && /Approved by Swami/.test(await page.textContent('#sideBody')));
  await page.keyboard.press('Escape');
  ok('Escape closes the thread first', await page.$eval('#side', s => s.hidden) && !!(await page.$('#msgs')));
  // Approve all the rest from the strip.
  await page.click('#pinned [data-approveall]');
  await S.until(async () => (await Promise.all([ids[0], ids[2]].map(id => S.db.collection('accessRequests').doc(id).get()))).every(d => d.data().status === 'approved'), 20000);
  ok('"Approve all" approves every request waiting here', true);
  await S.until(() => page.evaluate(() => !document.querySelector('#pinned .waiting')), 10000);
  ok('…and the strip goes', !(await page.$('#pinned .waiting')));
  ok('No page errors (Swami)', !page.__errors.length, page.__errors);
  await ctx.close();

  // Rameez: the same chat from his side.
  const nr = await S.api('rameez', 'request', { kind: 'property', targetId: 'ECR004', reason: 'one more' });
  const { page: rp, ctx: rc } = await S.as('rameez', { viewport: { width: 1366, height: 900 } });
  await rp.goto(S.BASE + '/messages.html?t=' + encodeURIComponent(docs[0].threadId) + '&r=' + encodeURIComponent(ids[1]));
  await rp.waitForSelector('#side:not([hidden]) .rcard', { timeout: 30000 });
  ok('A link to one request opens the chat at its thread (My Day → Message)', /ANR001/.test(await rp.textContent('#sideT')) && /Which client/.test(await rp.textContent('#sideBody')));
  await rp.keyboard.press('Escape');
  const mine = await rp.$$eval('#msgs .rcard', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('Rameez sees his requests as cards: "You asked…", approved with terms', mine.some(c => /You asked for/.test(c) && /Approved by Swami/.test(c)), mine.slice(0, 3));
  if (nr.id) ok('…a waiting one with "Cancel request" (no Approve)', await rp.$$eval('#msgs .rcard.open', els => els.some(e => e.querySelector('[data-ccancel]') && !e.querySelector('[data-capprove]'))));
  ok('No page errors (Rameez)', !rp.__errors.length, rp.__errors);
  await rc.close();

  // Old links: a folded chat's address goes on to the people's chat, at that request.
  const { page: op, ctx: oc } = await S.as('swami', { viewport: { width: 1366, height: 900 } });
  await op.goto(S.BASE + '/messages.html?t=' + encodeURIComponent(oldTh.id));
  await op.waitForSelector('#side:not([hidden]) .rcard', { timeout: 30000 });
  ok('An old chat’s link opens the people’s chat at that request', /VEL003/.test(await op.textContent('#sideT')) && /Is the client serious/.test(await op.textContent('#sideBody')));
  await oc.close();

  // "New" with no topic: your one chat with them.
  const d = await S.api('kavya', 'thread-open', { type: 'direct', members: ['rameez@threepin.in'] });
  const d2 = await S.api('rameez', 'thread-open', { type: 'direct', members: ['kavya@threepin.in'] });
  ok('New with no topic opens the one chat between those people (either side)', d.ok && d.id === d2.id, [d, d2]);

  // Dark and phone.
  for (const [name, opt] of [['dark', { dark: true, viewport: { width: 1366, height: 900 } }], ['phone', { viewport: { width: 390, height: 844 } }]]) {
    const { page: p2, ctx: c2 } = await S.as('rameez', opt);
    await p2.goto(S.BASE + '/messages.html?t=' + encodeURIComponent(docs[0].threadId));
    await p2.waitForSelector('#msgs .rcard', { timeout: 30000 });
    await p2.waitForTimeout(800);
    await p2.screenshot({ path: join(OUT, 'messages-people-' + name + '.png') });
    await p2.click('#msgs .rc-thread');
    await p2.waitForSelector('#side:not([hidden])');
    await p2.waitForTimeout(300);
    const over = await p2.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    ok(name + ': cards and the thread fit, nothing sideways', over === 0, over);
    await p2.screenshot({ path: join(OUT, 'messages-people-' + name + '-thread.png') });
    ok(name + ': no page errors', !p2.__errors.length, p2.__errors);
    await c2.close();
  }
} catch (e) {
  console.error(e); errors.push(String(e.message));
} finally {
  await S.stop();
}
console.log(errors.length ? `\n${errors.length} problem(s)` : '\nAll good.');
process.exit(errors.length ? 1 : 0);
