// ═══════ EÅSY — in the real CRM page, in a real browser ═══════
//
//   node tests/easy-preview.mjs [out-dir]        (uses the installed Chrome; PW_CHANNEL= to use Playwright's)
//
// Starts the local dev server (scripts/easy-dev.mjs) on a spare port — fake Firestore, the stand-in
// model unless ANTHROPIC_API_KEY is set — opens crm.html and uses Eåsy as an agent would: every MVP
// feature through the chat box, its cards and buttons, checking what lands in the database.
// Then once more with EASY_DISABLED=1, where the button must not appear. Screenshots to out-dir.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'tests/out/easy';
mkdirSync(OUT, { recursive: true });
const errors = [];
let passed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); errors.push(label); }
};

function startServer(port, env = {}) {
  return new Promise((resolve, reject) => {
    // The stand-in model, even when .env.local has a key: free and repeatable.
    const env2 = { ...process.env, PORT: String(port), EASY_DEV_STANDIN: '1', ...env };
    const p = spawn(process.execPath, ['scripts/easy-dev.mjs'], { cwd: ROOT, env: env2 });
    let log = '';
    p.stdout.on('data', d => { log += d; if (/local dev →/.test(log)) resolve({ p, log: () => log }); });
    p.stderr.on('data', d => { log += d; });
    p.on('exit', c => reject(new Error('dev server exited ' + c + '\n' + log)));
    setTimeout(() => reject(new Error('dev server did not start\n' + log)), 20000);
  });
}

const browser = await chromium.launch(process.env.PW_CHANNEL === '' ? {} : { channel: process.env.PW_CHANNEL || 'chrome' });

async function openCrm(port, viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => {
    window.__opened = [];
    window.open = url => { window.__opened.push(url); return null; };
    try { localStorage.removeItem('easy.shownReminders'); localStorage.removeItem('easy.voiceLang'); localStorage.removeItem('easy.speak'); } catch (e) {}
    // A microphone that "hears" window.__heard, and a voice that records what it would say.
    window.__heard = ''; window.__langs = []; window.__spoken = [];
    window.SpeechRecognition = class {
      start() {
        window.__langs.push(this.lang);
        setTimeout(() => {
          const words = String(window.__heard).split(' ');
          const res = (t, fin) => { const r = [{ transcript: t }]; r.isFinal = fin; return r; };
          this.onresult && this.onresult({ resultIndex: 0, results: [res(words.slice(0, 2).join(' '), false)] });
          this.onresult && this.onresult({ resultIndex: 0, results: [res(window.__heard, true)] });
          if (!this.continuous) setTimeout(() => this.onend && this.onend(), 30);
        }, 60);
      }
      stop() { setTimeout(() => this.onend && this.onend(), 10); }
      abort() { this.stop(); }
    };
    const synth = { speak: u => window.__spoken.push({ text: u.text, lang: u.lang }), cancel() {}, getVoices: () => [] };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`pageerror ${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|maps|favicon|Firestore leads sync error/i.test(m.text())) errors.push(`console ${viewport.width}px: ${m.text()}`); });
  // Only this machine: fonts and the like from the internet are not needed for the test.
  await page.route('**/*', r => { const u = new URL(r.request().url()); return u.hostname === 'localhost' ? r.continue() : r.abort(); });
  await page.goto(`http://localhost:${port}/crm.html`);
  return page;
}
const state = async port => (await fetch(`http://localhost:${port}/__dev/state`)).json();
const lastBot = page => page.locator('.easy-log .easy-bot').last();
async function ask(page, text) {
  const before = await page.locator('.easy-log .easy-bot').count();
  await page.fill('.easy-input', text);
  await page.click('.easy-send');
  await page.waitForFunction(n => { const b = document.querySelectorAll('.easy-log .easy-bot'); return b.length > n && !b[b.length - 1].querySelector('.easy-dots'); }, before, { timeout: 30000 });
  return (await lastBot(page).innerText()).trim();
}

const port = 5300 + Math.floor(Math.random() * 400);
const srv = await startServer(port);
try {
  // ═══ Laptop ═══
  console.log('\nLaptop — the whole MVP through the chat box');
  const page = await openCrm(port, { width: 1440, height: 900 });
  await page.waitForSelector('.easy:not([hidden]) .easy-fab', { timeout: 20000 });
  ok('The Eåsy button appears once the CRM has signed in', await page.isVisible('.easy-fab'));
  await page.waitForFunction(() => typeof leads !== 'undefined' && leads.length > 5, null, { timeout: 20000 });
  ok('The CRM loaded the sample leads from the fake Firestore', await page.evaluate(() => leads.length) >= 8);

  // Reminders arrive on their own (MVP-11, MVP-13).
  await page.waitForSelector('.easy-dot:not([hidden])', { timeout: 15000 });
  ok('A reminder lights the dot on the button', true);
  await page.click('.easy-fab');
  ok('The panel opens', await page.isVisible('#easyPanel'));
  ok('The 2-hour visit reminder is there (Priya)', await page.locator('.easy-remind', { hasText: 'Priya' }).count() === 1);
  ok('The pre-visit gist is there (Arun), with the property and owner', await page.locator('.easy-gist', { hasText: 'Arun' }).count() === 1 && /MAM001/.test(await page.locator('.easy-gist').first().innerText()));
  await page.screenshot({ path: `${OUT}/01-reminders-laptop.png` });

  // Voice: speak a question, hear the answer.
  ok('The 🎤 button is in the ask box', await page.isVisible('.easy-mic') && await page.isEnabled('.easy-mic'));
  ok('Reminders are shown, not read aloud (no voice out of nowhere)', await page.evaluate(() => window.__spoken.length) === 0);
  await page.evaluate(() => { window.__spoken.length = 0; window.__heard = 'what is my day'; });
  let before = await page.locator('.easy-log .easy-bot').count();
  await page.click('.easy-mic');
  await page.waitForFunction(n => { const b = document.querySelectorAll('.easy-log .easy-bot'); return b.length > n && !b[b.length - 1].querySelector('.easy-dots'); }, before, { timeout: 30000 });
  ok('Speaking a question sends it by itself, marked 🎤', /🎤 what is my day/.test(await page.locator('.easy-user').last().innerText()));
  ok('…in English by default', (await page.evaluate(() => window.__langs.at(-1))) === 'en-IN');
  ok('…and the answer is read aloud, without ids or symbols', await page.evaluate(() => window.__spoken.length === 1 && /day/i.test(window.__spoken[0].text) && !/\[lead:|\*\*/.test(window.__spoken[0].text)), await page.evaluate(() => window.__spoken));
  await page.click('.easy-lang');
  ok('The language switch goes to Tamil', (await page.innerText('.easy-lang')).trim() === 'தமிழ்');
  await page.evaluate(() => { window.__heard = 'இன்றைய வேலை என்ன'; });
  before = await page.locator('.easy-log .easy-bot').count();
  await page.click('.easy-mic');
  await page.waitForFunction(n => document.querySelectorAll('.easy-log .easy-bot').length > n, before, { timeout: 30000 });
  ok('…and the microphone then listens in Tamil', (await page.evaluate(() => window.__langs.at(-1))) === 'ta-IN');
  await page.click('.easy-lang');
  await page.waitForFunction(() => !document.querySelector('.easy-dots'), null, { timeout: 30000 });
  await page.click('.easy-speaker');
  await page.evaluate(() => { window.__spoken.length = 0; window.__heard = 'team overview'; });
  before = await page.locator('.easy-log .easy-bot').count();
  await page.click('.easy-mic');
  await page.waitForFunction(n => { const b = document.querySelectorAll('.easy-log .easy-bot'); return b.length > n && !b[b.length - 1].querySelector('.easy-dots'); }, before, { timeout: 30000 });
  ok('With the speaker off (🔇), nothing is read aloud', await page.evaluate(() => window.__spoken.length) === 0 && (await page.innerText('.easy-speaker')).trim() === '🔇');
  await page.click('.easy-speaker');
  await page.screenshot({ path: `${OUT}/01b-voice.png` });

  // MVP-10
  let t = await ask(page, 'What is my day?');
  ok('"What is my day?" answers', /Your day/.test(t), t);
  ok('…with the plan card, visits first at their times', await page.locator('.easy-plan li').count() >= 5 && /Site visit/.test(await page.locator('.easy-plan li').first().innerText()));
  ok('…the visits are marked as fixed', await page.locator('.easy-plan').last().locator('li.pr-fixed').count() === 2);
  await page.screenshot({ path: `${OUT}/02-plan.png` });

  // Open lead from an answer
  await page.locator('.easy-plan .easy-lead').first().click();
  await page.waitForTimeout(400);
  ok('Open lead opens that lead in the CRM', await page.evaluate(() => getComputedStyle(document.getElementById('dp')).display !== 'none'));
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  if (await page.evaluate(() => getComputedStyle(document.getElementById('dp')).display !== 'none')) await page.evaluate(() => typeof closeDetail === 'function' && closeDetail());
  await page.click('.easy-fab');
  if (await page.isHidden('#easyPanel')) await page.click('.easy-fab');

  // MVP-07
  t = await ask(page, 'Summary of Shiva');
  ok('A name two leads share → Eåsy asks which', /Which one/.test(t) && /Shiva Kumar/.test(t) && /Shiva R/.test(t), t);

  // MVP-05
  t = await ask(page, 'Who matches MED001?');
  ok('Matching buyers for MED001 lists Medavakkam buyers', /Buyers for MED001/.test(t) && /(Priya|Karthik)/.test(t), t);

  // MVP-12 / MVP-08
  t = await ask(page, 'Who went cold? Draft the follow-ups');
  ok('Going cold → a draft to Lakshmi', await page.locator('.easy-draft', { hasText: 'Lakshmi' }).count() >= 1, t);
  const card = page.locator('.easy-draft', { hasText: 'Lakshmi' }).last();
  await card.locator('textarea').fill('Hi Lakshmi, this is Thirumal from 3 PIN — any update on the Thiruvanmiyur search?');
  await card.locator('[data-do="send"]').click();
  const opened = await page.evaluate(() => window.__opened.at(-1));
  ok('Send opens WhatsApp with the number and the edited text', /^https:\/\/wa\.me\/919876543214\?text=Hi%20Lakshmi/.test(opened), opened);
  ok('…then asks "Sent?"', /Sent\?/.test(await card.innerText()));
  await card.locator('[data-do="sent"]').click();
  await page.waitForTimeout(300);
  let s = await state(port);
  const d = Object.entries(s).find(([k, v]) => k.startsWith('easyDrafts/') && /Thiruvanmiyur search/.test(v.text));
  ok('"Yes" records it as sent, with the edited text', d && d[1].status === 'sent', d && d[1]);
  await page.screenshot({ path: `${OUT}/03-draft-sent.png` });

  // MVP-06 / MVP-03
  t = await ask(page, 'What is missing on MED001?');
  ok('What is missing on MED001', /MED001/.test(t) && /complete/.test(t), t);
  t = await ask(page, 'Ask the owner of MED001 for the missing details');
  s = await state(port);
  const missing = Object.values(s).filter(v => v && v.code === 'MED001' && v.status === 'asked');
  ok('Asking the owner → a draft to the owner, and each detail tracked', await page.locator('.easy-draft').last().isVisible() && missing.length >= 1, t);

  // MVP-04
  const withB = Object.values(s).find(v => v && v.propertyCode && v.brochureLink);
  t = await ask(page, `Brochure for ${withB.propertyCode}`);
  ok('Brochure → the link card', await page.locator('.easy-card a.easy-link', { hasText: withB.brochureLink }).count() === 1, t);

  // MVP-01
  t = await ask(page, 'Add a 2BHK in Velachery, 72 lakhs, owner Rajan 98400 12345');
  const add = page.locator('.easy-change').last();
  const addText = await add.innerText();
  ok('Add a property → a card with the new code and what is missing', /Code: VEL\d{3}/.test(addText) && /Still missing/.test(addText), addText);
  const code = addText.match(/VEL\d{3}/)[0];
  ok('…nothing saved before Yes', !Object.values(await state(port)).some(v => v && v.propertyCode === code));
  await add.locator('[data-do="yes"]').click();
  await page.waitForSelector('.easy-change:last-child .easy-ok', { timeout: 10000 });
  s = await state(port);
  ok('Yes → the property is saved as a draft listing', Object.values(s).some(v => v && v.propertyCode === code && v.listingStatus === 'draft'));
  await page.screenshot({ path: `${OUT}/04-add-property.png` });

  // MVP-02
  t = await ask(page, 'MED001 price is now 1.3 Cr');
  const upd = page.locator('.easy-change').last();
  ok('Update → the card reads old → new', /→ ₹1\.3 Cr/.test(await upd.innerText()), await upd.innerText());
  await upd.locator('[data-do="no"]').click();
  await page.waitForTimeout(400);
  s = await state(port);
  ok('No → the price stays', !Object.values(s).some(v => v && v.propertyCode === 'MED001' && v.startingPrice === '₹1.3 Cr'));
  t = await ask(page, 'MED001 price is now 1.3 Cr');
  await page.locator('.easy-change').last().locator('[data-do="yes"]').click();
  await page.waitForTimeout(500);
  s = await state(port);
  ok('Yes → the price changes', Object.values(s).some(v => v && v.propertyCode === 'MED001' && v.startingPrice === '₹1.3 Cr'));

  // MVP-09 / MVP-15
  await page.click('.easy-logcall');
  await page.fill('.easy-call-lead', await page.evaluate(() => { const l = leads.find(x => x.id === 'L_priya'); return l.name + ' · ' + l.phone; }));
  await page.evaluate(() => { window.__heard = 'Liked MED001, wants a covered car park. Call back Friday.'; });
  await page.click('.easy-call-mic');
  await page.waitForFunction(() => /car park/.test(document.querySelector('.easy-call-text').value), null, { timeout: 5000 });
  ok('Call notes can be dictated: 🎤 Speak fills the notes', /covered car park/.test(await page.inputValue('.easy-call-text')));
  await page.click('.easy-call-mic');   // ■ Stop
  await page.click('.easy-call-save');
  await page.waitForSelector('.easy-change:last-child [data-do="yes"]', { timeout: 15000 });
  ok('Log call → a call-notes card for Priya', /call notes for Priya/i.test(await page.locator('.easy-change').last().innerText()));
  await page.locator('.easy-change').last().locator('[data-do="yes"]').click();
  await page.waitForTimeout(500);
  s = await state(port);
  ok('Yes → the note is on Priya\'s lead', Object.entries(s).some(([k, v]) => k.startsWith('leads/L_priya/notes/') && /covered car park/.test(v.text) && /Call notes/.test(v.text)));
  const serverTouched = s['leads/L_priya'].updatedAt;
  await page.waitForFunction(at => { const l = leads.find(x => x.id === 'L_priya'); return l && l.updatedAt === at; }, serverTouched, { timeout: 5000 }).catch(() => {});
  ok('…and the CRM page\'s own copy of the lead updated live', await page.evaluate(at => leads.find(x => x.id === 'L_priya').updatedAt === at, serverTouched));

  // MVP-14
  t = await ask(page, 'Seller summaries for this week');
  ok('Seller summaries → an owner update for MED001', /MED001/.test(t) && await page.locator('.easy-draft').last().isVisible(), t);

  // MVP-16
  t = await ask(page, 'Team overview');
  ok('Team overview for the admin', /Team today/.test(t) && /thirumal@threepin\.in/.test(t), t);
  await page.screenshot({ path: `${OUT}/05-laptop-end.png` });

  // ═══ Phone ═══
  console.log('\nPhone width');
  const phone = await openCrm(port, { width: 390, height: 844 });
  await phone.waitForSelector('.easy:not([hidden]) .easy-fab', { timeout: 20000 });
  await phone.click('.easy-fab');
  await phone.waitForTimeout(300);
  const fits = await phone.evaluate(() => { const r = document.getElementById('easyPanel').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 && document.documentElement.scrollWidth <= innerWidth + 1; });
  ok('The panel fits the phone screen, no sideways scroll', fits);
  const fab = await phone.locator('.easy-fab').boundingBox();
  ok('The button sits bottom-left, clear of the + add lead button', fab.x < 100);
  await ask(phone, 'What is my day?');
  ok('The plan card works on the phone', await phone.locator('.easy-plan li').count() >= 5);
  await phone.screenshot({ path: `${OUT}/06-phone.png` });

  // ═══ Kept in the browser: the chat, answers, the schedule ═══
  console.log('\nKept in the browser');
  const calls = [];
  page.context().on('request', r => { if (r.url().includes('/api/easy')) { try { const b = JSON.parse(r.postData() || '{}'); calls.push(b.action || (b.history ? 'ask' : '?')); } catch (e) {} } });
  // The same question again, straight after the same answer: answered from the browser.
  await page.click('.easy-new');
  ok('↺ New chat clears the conversation', await page.locator('.easy-log .easy-msg').count() === 0 && await page.isVisible('.easy-chips'));
  calls.length = 0;
  await ask(page, 'What is my day?');
  ok('A question asks the server once', calls.filter(c => c === 'ask').length === 1, calls);
  await ask(page, 'Thanks');
  calls.length = 0;
  const t1 = await ask(page, 'What is my day?');
  ok('…asked again after a different answer, it goes to the server', calls.filter(c => c === 'ask').length === 1, calls);
  calls.length = 0;
  await ask(page, 'What is my day?');
  ok('…asked again straight after the same answer: answered from the browser, no server call', calls.length === 0, calls);
  ok('…shown with its time and ↻ Refresh', await page.locator('.easy-asof .easy-refresh').count() >= 1 && /Answered at/.test(await page.locator('.easy-asof').last().innerText()));
  await page.locator('.easy-refresh').last().click();
  await page.waitForFunction(() => !document.querySelector('.easy-dots'), null, { timeout: 30000 });
  ok('↻ Refresh asks the server again', calls.filter(c => c === 'ask').length === 1, calls);
  // The chat follows you to another page and survives a reload.
  const kept = await page.locator(".easy-log .easy-msg").count();
  await page.goto(`http://localhost:${port}/dashboard.html`);
  await page.waitForSelector('.easy:not([hidden]) .easy-fab', { timeout: 20000 });
  await page.click('.easy-fab');
  ok('The chat is still there on another page', await page.locator('.easy-log .easy-msg').count() === kept, `${await page.locator('.easy-log .easy-msg').count()} vs ${kept}`);
  calls.length = 0;
  await page.reload();
  await page.waitForSelector('.easy:not([hidden]) .easy-fab', { timeout: 20000 });
  await page.waitForTimeout(1500);
  ok('…and after a reload; the day\'s schedule is not fetched again (it is kept for 20 minutes)', !calls.includes('schedule') && !calls.includes('reminders'), calls);
  await page.click('.easy-fab');
  t = await ask(page, 'And who went cold?');
  ok('…the conversation carries on from where it was', t.length > 0);
  // Two more tabs, as people keep them: still no extra schedule asks.
  calls.length = 0;
  const extra = [await page.context().newPage(), await page.context().newPage()];
  for (const [i, pg] of extra.entries()) await pg.goto(`http://localhost:${port}/${i ? 'propertytrack.html' : 'crm.html'}`);
  await page.waitForTimeout(4000);
  ok('Opening two more tabs costs no schedule fetch', !calls.includes('schedule') && !calls.includes('reminders'), calls);
  for (const pg of extra) await pg.close();
  await page.goto(`http://localhost:${port}/crm.html`);
  await page.waitForSelector('.easy:not([hidden]) .easy-fab', { timeout: 20000 });
  await page.click('.easy-fab');

  // ═══ The database's daily limit, said plainly (shared-assets/quota-notice.js) ═══
  await page.evaluate(() => console.error('Firestore leads sync error:', Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })));
  ok('An ordinary error shows no limit banner', await page.locator('[role="alert"]', { hasText: 'daily limit' }).count() === 0);
  await page.evaluate(() => console.error('Firestore leads sync error:', Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' })));
  const banner = page.locator('[role="alert"]', { hasText: 'daily limit' });
  ok('Firestore out of quota → one plain banner on the page, with the reset time', await banner.count() === 1 && /resets at about \d{1,2}:\d\d [ap]m/.test(await banner.innerText()), await banner.count() ? await banner.innerText() : 'none');
  await page.screenshot({ path: `${OUT}/08-quota-banner.png` });
  await banner.locator('button').click();

  // ═══ The admin's switch ═══
  console.log('\nThe admin\'s switch');
  ok('The admin sees the ⏻ switch', await page.isVisible('.easy-power'));
  page.once('dialog', d => d.accept());
  await page.click('.easy-power');
  await page.waitForSelector('.easy', { state: 'hidden', timeout: 5000 });
  ok('Switched off: the eåsy button is gone, even for the admin', await page.locator('.easy-fab').isHidden());
  await page.evaluate(() => toggleMoreMenu && toggleMoreMenu());
  ok('…and the ⋮ menu says "✨ Eåsy: Off", next to Lead automation', (await page.innerText('#easyBtn')).trim() === '✨ Eåsy: Off' && await page.evaluate(() => document.getElementById('autoBtn').nextElementSibling.id === 'easyBtn'));
  await page.screenshot({ path: `${OUT}/09-menu-off.png` });
  {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctxA.addCookies([{ name: 'easyDevAs', value: 'pradeep@threepin.in', url: `http://localhost:${port}` }]);
    const pa = await ctxA.newPage();
    await pa.route('**/*', r => { const u = new URL(r.request().url()); return u.hostname === 'localhost' ? r.continue() : r.abort(); });
    await pa.goto(`http://localhost:${port}/crm.html`);
    await pa.waitForFunction(() => typeof leads !== 'undefined' && leads.length > 5, null, { timeout: 20000 });
    await pa.waitForTimeout(2500);
    ok('…an agent sees no Eåsy and no menu item, and the CRM works', await pa.locator('.easy-fab').isHidden() && await pa.locator('#easyBtn').count() === 0);
    await ctxA.close();
  }
  await page.reload();
  await page.waitForFunction(() => document.getElementById('easyBtn'), null, { timeout: 20000 });
  ok('After a reload the admin still has the menu item, and no button', (await page.textContent('#easyBtn')).trim() === '✨ Eåsy: Off' && await page.locator('.easy-fab').isHidden());
  page.once('dialog', d => d.accept());
  await page.evaluate(() => document.getElementById('easyBtn').click());
  await page.waitForSelector('.easy:not([hidden]) .easy-fab', { timeout: 5000 });
  ok('Turned back on from the ⋮ menu: the button is back and the menu says On', (await page.textContent('#easyBtn')).trim() === '✨ Eåsy: On' && await page.isVisible('.easy-fab'));
  await page.click('.easy-fab');
  ok('…and it answers again', /day/i.test(await ask(page, 'what is my day')));

  // ═══ Every admin page ═══
  console.log('\nEvery admin page');
  for (const [file, label] of [['dashboard.html', 'Properties'], ['propertytrack.html', 'the board'], ['3pinfinance.html', 'Finance'], ['index.html', 'Home']]) {
    const pg = await (async () => {
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const p2 = await ctx2.newPage();
      await p2.route('**/*', r => { const u = new URL(r.request().url()); return u.hostname === 'localhost' ? r.continue() : r.abort(); });
      await p2.goto(`http://localhost:${port}/${file}`);
      return p2;
    })();
    const shown = await pg.waitForSelector('.easy:not([hidden]) .easy-fab', { timeout: 20000 }).then(() => true).catch(() => false);
    ok(`Eåsy is on ${label} (${file})`, shown);
    if (shown) {
      await pg.click('.easy-fab');
      const t2 = await ask(pg, 'What is my day?');
      ok(`…and answers there`, /Your day/.test(t2), t2.slice(0, 80));
      const lb = pg.locator('.easy-plan .easy-lead').first();
      if (await lb.count()) {
        await lb.click();
        await pg.waitForURL(/crm\.html\?lead=/, { timeout: 5000 }).catch(() => {});
        ok('…Open lead goes to that lead in the CRM', /crm\.html\?lead=L_/.test(pg.url()), pg.url());
      }
    }
    await pg.context().close();
  }
  // Finance on a phone: the bottom tabs stay clear.
  {
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p3 = await ctx3.newPage();
    await p3.route('**/*', r => { const u = new URL(r.request().url()); return u.hostname === 'localhost' ? r.continue() : r.abort(); });
    await p3.goto(`http://localhost:${port}/3pinfinance.html`);
    if (await p3.waitForSelector('.easy:not([hidden]) .easy-fab', { timeout: 20000 }).then(() => true).catch(() => false)) {
      const clear = await p3.evaluate(() => {
        const bar = document.querySelector('.bottom'); const fab = document.querySelector('.easy-fab').getBoundingClientRect();
        if (!bar || getComputedStyle(bar).display === 'none') return true;
        return fab.bottom <= bar.getBoundingClientRect().top + 1;
      });
      ok('Finance on a phone: the Eåsy button sits above the bottom tabs', clear);
      await p3.screenshot({ path: `${OUT}/07-finance-phone.png` });
    } else ok('Finance on a phone: Eåsy appears', false);
    await ctx3.close();
  }

  // ═══ An agent who is not the admin ═══
  console.log('\nAs an agent (not the admin)');
  const ctx = phone.context();
  await ctx.addCookies([{ name: 'easyDevAs', value: 'pradeep@threepin.in', url: `http://localhost:${port}` }]);
  const agent = await openCrm(port, { width: 1280, height: 800 });
  await agent.context().addCookies([{ name: 'easyDevAs', value: 'pradeep@threepin.in', url: `http://localhost:${port}` }]);
  await agent.reload();
  await agent.waitForSelector('.easy:not([hidden]) .easy-fab', { timeout: 20000 });
  await agent.click('.easy-fab');
  t = await ask(agent, 'Team overview');
  ok('The team overview is refused for an agent', /Only the admin/.test(t), t);
  await agent.waitForTimeout(1500);
  ok('…and Thirumal\'s visit reminders do not show for Pradeep', await agent.locator('.easy-remind, .easy-gist').count() === 0);
} finally {
  srv.p.kill();
}

// ═══ Switched off ═══
console.log('\nSwitched off (EASY_DISABLED=1)');
const port2 = port + 1;
const off = await startServer(port2, { EASY_DISABLED: '1' });
try {
  const page = await openCrm(port2, { width: 1280, height: 800 });
  await page.waitForFunction(() => typeof leads !== 'undefined' && leads.length > 5, null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  ok('With Eåsy off, the button never appears and the CRM still works', await page.locator('.easy-fab').isHidden() && await page.evaluate(() => leads.length) >= 8);
} finally {
  off.p.kill();
}

await browser.close();
const real = errors.filter(e => !/^(pageerror|console)/.test(e));
const pageErrs = errors.filter(e => /^(pageerror|console)/.test(e));
if (pageErrs.length) console.log('\nPage errors:\n  ' + pageErrs.join('\n  '));
console.log(errors.length ? `\n${real.length} failed, ${passed} passed, ${pageErrs.length} page errors` : `\nAll good (${passed} checks). Screenshots in ${OUT}/`);
process.exit(errors.length ? 1 : 0);
