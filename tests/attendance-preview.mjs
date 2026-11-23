// Screens of the Attendance page and the morning pop-up, in the local test kit (no live data):
//   node tests/attendance-preview.mjs <folder for the screenshots>

import { startStack, T } from './_agent-stack.mjs';
import * as C from '../shared-assets/attendance-core.js';
const OUT = process.argv[2];
const S = await startStack({ emuPort: 8484, webPort: 8585 });
const errs = [];
try {
  const tok = k => Buffer.from(JSON.stringify({ uid: S.PEOPLE[k].uid, email: S.PEOPLE[k].email, tenantId: T, role: S.PEOPLE[k].role })).toString('base64url');
  const att = async (k, action, body = {}) => (await fetch(S.BASE + '/api/attendance', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok(k) }, body: JSON.stringify({ action, ...body }) })).json();
  // A morning: Rajesh in at 9:10, out for lunch, back; Thirumal in.
  const day = C.dayOf(); const h = 3600e3;
  const base = Date.now() - 7 * h;
  const ev = (type, at) => ({ id: 'r' + at, type, at, source: 'page', by: 'rajesh@threepin.in' });
  const events = [ev('in', base), ev('out', base + 3.5 * h), ev('in', base + 4.2 * h)];
  await S.db.collection('attendance').doc(C.docId(T, 'u_rajesh', day)).set({ tenantId: T, uid: 'u_rajesh', email: 'rajesh@threepin.in', name: 'Rajesh', day, events, ...C.summarise(events), updatedAt: Date.now() });
  const y = C.addDays(day, -1);
  const ye = [ev('in', base - 24 * h), ev('out', base - 15 * h)];
  await S.db.collection('attendance').doc(C.docId(T, 'u_rajesh', y)).set({ tenantId: T, uid: 'u_rajesh', email: 'rajesh@threepin.in', name: 'Rajesh', day: y, events: ye, ...C.summarise(ye) });
  console.log('thirumal in', (await att('thirumal', 'sign-in')).ok);

  // Rajesh on a phone: the attendance page, then the pop-up on My Day (Swami, not signed in yet).
  let { page } = await S.as('rajesh', { viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => errs.push('rajesh: ' + e.message));
  await page.goto(S.BASE + '/attendance.html');
  await page.waitForSelector('#go', { timeout: 15000 });
  await page.click('#hist summary'); await page.waitForSelector('.at-days', { timeout: 10000 });
  await page.screenshot({ path: OUT + '/1-employee-phone.png', fullPage: true });

  ({ page } = await S.as('swami', { viewport: { width: 390, height: 844 }, attendance: true }));
  page.on('pageerror', e => errs.push('swami: ' + e.message));
  await page.goto(S.BASE + '/myday.html');
  await page.waitForSelector('dialog.att-pop[open]', { timeout: 15000 });
  await page.screenshot({ path: OUT + '/2-popup.png' });
  await page.click('#attPopIn');
  await page.waitForSelector('.ap-done', { timeout: 10000 });
  await page.screenshot({ path: OUT + '/3-popup-done.png' });

  // Thirumal on a laptop: the admin view.
  ({ page } = await S.as('thirumal', { viewport: { width: 1280, height: 900 } }));
  page.on('pageerror', e => errs.push('thirumal: ' + e.message));
  await page.goto(S.BASE + '/attendance.html');
  await page.waitForSelector('.at-prow', { timeout: 15000 });
  await page.screenshot({ path: OUT + '/4-admin-laptop.png', fullPage: true });
  await page.click('.at-prow[data-uid="u_rajesh"]');
  await page.waitForSelector('.at-psum', { timeout: 10000 });
  await page.screenshot({ path: OUT + '/5-person-sheet.png' });
  await page.keyboard.press('Escape');
  await page.click('.at-x');
  await page.waitForTimeout(500);
  console.log('alerts after clearing one:', await page.locator('.at-a').count());
  // Thirumal signs out from the page.
  const ag = page.locator('#go'); await ag.click(); await page.waitForTimeout(800);
  console.log('thirumal state:', await page.locator('.at-state').textContent());
  ({ page } = await S.as('thirumal', { viewport: { width: 390, height: 844 } }));
  await page.goto(S.BASE + '/attendance.html');
  await page.waitForSelector('.at-prow', { timeout: 15000 });
  await page.screenshot({ path: OUT + '/6-admin-phone.png', fullPage: true });
} catch (e) { console.error('FAIL', e.message); }
finally { console.log('page errors:', errs.length ? errs : 'none'); await S.stop(); }
