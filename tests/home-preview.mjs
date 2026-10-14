// ═══════ THE FRONT DOOR (index.html) ═══════
// Served from the repo with Firebase Auth swapped for a stand-in that can be told who is signed
// in, whether a sign-in succeeds, and which claim the account carries. Checks every state the
// page has (checking, signed out, signed in, opening, no access, errors) and screenshots them
// on desktop and phone.
//   node tests/home-preview.mjs [out-dir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'tests/out/home';
mkdirSync(OUT, { recursive: true });
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.json': 'application/json' };

// Auth stand-in. window.__auth = { user, claim, failWith, ... } is set by the test before load.
const FIREBASE_STUB = `
const A = () => (window.__auth = window.__auth || {});
let cur = null;   // a stable user object per sign-in, as Firebase keeps (auth.currentUser is compared by identity)
const mk = () => { const a = A(); if (!a.user) { cur = null; return null; }
  if (!cur || cur.email !== a.user.email) cur = { email: a.user.email, displayName: a.user.name || null, uid: 'u1',
    getIdTokenResult: async () => { if (A().tokenFails) throw new Error('offline'); return { claims: A().claim ? { tenantId: 't_3pinrealty' } : {} }; } };
  return cur; };
let cbs = [];
const fire = () => cbs.forEach(cb => setTimeout(() => cb(mk()), 0));
export const initializeApp = () => ({}), getApps = () => [];
export const getAuth = () => ({ get currentUser() { return mk(); } }), GoogleAuthProvider = class { setCustomParameters() {} };
export const onAuthStateChanged = (a, cb) => { cbs.push(cb); setTimeout(() => cb(mk()), A().delay || 0); return () => {}; };
export const signInWithEmailAndPassword = async (a, email) => {
  if (A().failWith) { const e = new Error('x'); e.code = A().failWith; throw e; }
  A().user = { email }; fire(); return {};
};
export const signInWithPopup = async () => {
  if (A().failWith) { const e = new Error('x'); e.code = A().failWith; throw e; }
  A().user = { email: A().googleEmail || 'pradeep@threepin.in', name: 'Pradeep Kumar' }; fire(); return {};
};
export const signOut = async () => { A().user = null; A().signedOut = (A().signedOut || 0) + 1; fire(); };
export const getFirestore = () => ({}), clearIndexedDbPersistence = async () => { A().cleared = true; };
`;

const browser = await chromium.launch();
async function open(viewport, auth, scheme = 'light') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme });
  await ctx.addInitScript(a => { window.__auth = a; try { localStorage.clear(); } catch (e) {} }, auth);
  const page = await ctx.newPage();
  page.on('pageerror', e => { if (/Transition was skipped/.test(e.message)) return; console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.gstatic.com' && /firebasejs/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_STUB });
    if (url.hostname !== 'app.local') return route.abort();
    // Opening a console is not this page's business: answer with a stub page.
    if (/^\/(crm|dashboard|property)\.html$/.test(url.pathname)) return route.fulfill({ contentType: 'text/html', body: '<title>console</title>' });
    const file = join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://app.local/');
  return { page, ctx };
}
const view = p => p.evaluate(() => document.getElementById('gate').dataset.view);
const settle = async (p, v) => { await p.waitForFunction(x => document.getElementById('gate').dataset.view === x, v, { timeout: 4000 }); await p.waitForTimeout(700); };
const overflowX = p => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };

for (const [label, vp] of [['desktop', DESK], ['phone', PHONE]]) {
  console.log('\n' + label.toUpperCase());

  // Signed out
  {
    const { page, ctx } = await open(vp, {});
    await settle(page, 'signin');
    ok('signed out shows the sign-in', await view(page) === 'signin');
    ok('no sideways scroll', !(await overflowX(page)));
    ok('Google and email are both offered', await page.locator('#google-btn').isVisible() && await page.locator('#signin-submit').isVisible());
    await page.screenshot({ path: join(OUT, `${label}-1-signin.png`) });
    await page.locator('#pass-toggle').click();
    ok('password can be shown', await page.locator('#signin-pass').getAttribute('type') === 'text');
    await ctx.close();
  }

  // Dark scheme
  {
    const { page, ctx } = await open(vp, {}, 'dark');
    await settle(page, 'signin');
    await page.screenshot({ path: join(OUT, `${label}-2-signin-dark.png`) });
    await ctx.close();
  }

  // Wrong password
  {
    const { page, ctx } = await open(vp, { failWith: 'auth/invalid-credential' });
    await settle(page, 'signin');
    await page.fill('#signin-email', 'someone@threepin.in');
    await page.fill('#signin-pass', 'nope');
    await page.click('#signin-submit');
    await page.waitForSelector('#signin-err:not([hidden])');
    ok('wrong password says so', /don't match/.test(await page.locator('#signin-err').innerText()));
    ok('and stays on the sign-in', await view(page) === 'signin');
    await page.screenshot({ path: join(OUT, `${label}-3-error.png`) });
    await ctx.close();
  }

  // Email sign-in → Daily task
  {
    const { page, ctx } = await open(vp, { claim: true });
    await settle(page, 'signin');
    await page.fill('#signin-email', 'pradeep@threepin.in');
    await page.fill('#signin-pass', 'secret');
    await page.click('#signin-submit');
    await page.waitForURL(/crm\.html\?nav=today/, { timeout: 4000 }).catch(() => {});
    ok('email sign-in opens the Daily task', /crm\.html\?nav=today/.test(page.url()), page.url());
    await ctx.close();
  }

  // Google sign-in → Daily task
  {
    const { page, ctx } = await open(vp, { claim: true });
    await settle(page, 'signin');
    await page.click('#google-btn');
    await page.waitForURL(/crm\.html\?nav=today/, { timeout: 4000 }).catch(() => {});
    ok('Google sign-in opens the Daily task', /crm\.html\?nav=today/.test(page.url()), page.url());
    await ctx.close();
  }

  // Google account with no tenant claim → refused, signed out, says so
  {
    const { page, ctx } = await open(vp, { claim: false, googleEmail: 'stranger@gmail.com' });
    await settle(page, 'signin');
    await page.click('#google-btn');
    await page.waitForSelector('#signin-err:not([hidden])');
    const t = await page.locator('#signin-err').innerText();
    ok('an account with no access is told so, by email', /stranger@gmail\.com/.test(t) && /set up/.test(t), t);
    ok('and is signed straight out', await page.evaluate(() => window.__auth.signedOut === 1));
    ok('and stays on the sign-in', await view(page) === 'signin' && !/crm\.html/.test(page.url()));
    await page.screenshot({ path: join(OUT, `${label}-4-no-access.png`) });
    await ctx.close();
  }

  // Signed in but the token cannot be fetched (offline): not signed out, and says why
  {
    const { page, ctx } = await open(vp, { user: { email: 'pradeep@threepin.in' }, claim: true, tokenFails: true });
    await settle(page, 'signin');
    ok('an unreachable check does not sign the person out', await page.evaluate(() => !window.__auth.signedOut));
    ok('and says it could not check', /check your account/i.test(await page.locator('#signin-err').innerText()));
    await ctx.close();
  }

  // Popup closed by the person: no error
  {
    const { page, ctx } = await open(vp, { failWith: 'auth/popup-closed-by-user' });
    await settle(page, 'signin');
    await page.click('#google-btn');
    await page.waitForTimeout(300);
    ok('closing the Google window is not an error', await page.locator('#signin-err').isHidden());
    ok('and the buttons work again', await page.locator('#google-btn').isEnabled());
    await ctx.close();
  }

  // Already signed in → the consoles, no redirect
  {
    const { page, ctx } = await open(vp, { user: { email: 'pradeep.kumar@threepin.in' }, claim: true });
    await settle(page, 'signedin');
    ok('signed in shows the consoles', await page.locator('.tile').count() === 5);
    ok('greets by name', /Welcome back, Pradeep/.test(await page.locator('#who-hi').innerText()));
    ok('Daily task is the first tile', /Daily task/.test(await page.locator('.tile').first().innerText()));
    ok('and stays on the page', !/crm\.html/.test(page.url()));
    ok('no sideways scroll', !(await overflowX(page)));
    await page.screenshot({ path: join(OUT, `${label}-5-signedin.png`) });
    await page.click('#signout-btn');
    await settle(page, 'signin');
    ok('sign out returns to the sign-in', await view(page) === 'signin');
    await page.waitForFunction(() => window.__auth.cleared === true, null, { timeout: 2000 }).catch(() => {});
    ok('and drops the local copy', await page.evaluate(() => window.__auth.cleared === true));
    await ctx.close();
  }

  // Worst case: a very long address and name
  {
    const long = 'a.very.long.email.address.for.the.front.desk.team@a-subdomain.of-a-very-long-company-name.example.co.in';
    const { page, ctx } = await open(vp, { user: { email: long, name: 'Bartholomew-Maximilian Featherstonehaugh' }, claim: true });
    await settle(page, 'signedin');
    ok('a very long address does not break the page', !(await overflowX(page)));
    await page.screenshot({ path: join(OUT, `${label}-6-signedin-long.png`) });
    await ctx.close();
  }

  // Checking (slow auth)
  {
    const { page, ctx } = await open(vp, { delay: 1500 });
    await page.waitForTimeout(300);
    ok('while checking, the form is not shown', await view(page) === 'checking' && await page.locator('#google-btn').isHidden());
    await page.screenshot({ path: join(OUT, `${label}-0-checking.png`) });
    await ctx.close();
  }
}

await browser.close();
console.log(errors.length ? `\n${errors.length} check(s) failed.` : '\nAll good.');
process.exit(errors.length ? 1 : 0);
