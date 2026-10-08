// ═══════ CREATE BROCHURE — THE PROPERTY ID FIELD ═══════
// Typing a code suggests the codes already in the inventory, each marked "Already exists",
// and the next free code in that series — so a new listing never takes a code that is taken,
// and the series show how codes are numbered.
//   • focus with nothing typed → every series, with its next free code
//   • "tnag" → TNAG0003 offered as new; TNAG0001 / TNAG0002 marked already exists
//   • a taken code → said under the field, and asked about on submit
//   • a slip (THVA0001 for THVA001) and an off-series number are pointed out
//   • picking a code keeps the title already typed after it
//   • keyboard: arrows + Enter pick, Escape closes, Enter never submits the form from the list
//   • phone width: the list fits, no sideways scroll
//   node tests/brochure-code-preview.mjs [out-dir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'tests/out/brochure-code';
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';
const P = (id, name, location) => ({ id, propertyCode: id, tenantId: T, name, location, type: 'Apartment', status: 'Ready to Move' });
const PROPS = [
  P('TNAG0001', '2BHK Pondy Bazaar', 'T Nagar'), P('TNAG0002', '3BHK Usman Road', 'T Nagar'),
  P('THVA001', 'LUX 49 - Manvi Homes', 'Thiruvanmiyur'),
  P('NOL001', 'Villa, Nolambur', 'Nolambur'), P('NOL002', '3BHK in Velachery', 'Velachery'),
  P('VIVA0001', 'Viva 1', 'Vadapalani'), P('VIVA0002', 'Viva 2', 'Vadapalani'), P('VIVA0004', 'Viva 4', 'Vadapalani'),
  P('SRS_OMR001', 'OMR plot', 'OMR'),
  { id: 'p1786282875836', propertyCode: '', tenantId: T, name: 'Added in the dashboard, no code', location: 'Adyar', status: 'Ready to Move' },
  { id: '17', propertyCode: '', tenantId: T, name: 'Old listing, bare-number id', location: 'Adyar', status: 'Ready to Move' }
];
const STUB = `
window.dashboardFirebase = { saveProperty: async()=>{}, deleteProperty: async()=>{}, saveFavorites: async()=>{}, saveChange: async()=>{}, getChanges: async()=>[], saveNaFields: async()=>{} };
window.dashboardAuth = { login: async()=>{}, logout: async()=>{}, getIdToken: async()=>'test-token', getTenantId: ()=>'${T}' };
if(window.onDashboardAuthChange) window.onDashboardAuthChange({ email:'agent.a@example.com' });
if(window.applyPropertiesSnapshot) window.applyPropertiesSnapshot(${JSON.stringify(PROPS)});
window.__ready = true;
`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const browser = await chromium.launch();
async function open(viewport, scheme = 'light') {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  pg.__posts = [];
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'docs.google.com') { pg.__posts.push(route.request().postData()); return route.fulfill({ status: 200, body: '' }); }
    if (url.hostname !== 'dash.local') return route.abort();
    if (url.pathname === '/dashboard-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true,"entries":[]}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await pg.goto('http://dash.local/dashboard.html');
  await pg.waitForFunction(() => window.__ready === true && !!window.BrochureCodes, null, { timeout: 15000 });
  await pg.evaluate(() => { const r = document.getElementById('appRoot'); if (r) r.style.display = ''; openBrochurePage(); });
  await pg.waitForTimeout(300);
  return pg;
}
const state = pg => pg.evaluate(() => {
  const pop = document.getElementById('bfCodePop');
  return {
    open: !pop.hidden,
    head: (pop.querySelector('.bf-code-head') || {}).textContent || '',
    opts: [...pop.querySelectorAll('.bf-code-opt')].map(b => b.querySelector('b').textContent + ' | ' + b.querySelector('.bf-code-tag').textContent),
    at: (pop.querySelector('.bf-code-opt.at b') || {}).textContent || '',
    verdict: document.getElementById('bfCodeVerdict').textContent.replace(/\s+/g, ' ').trim(),
    vkind: document.getElementById('bfCodeVerdict').className,
    value: document.getElementById('bfTitle').value,
    expanded: document.getElementById('bfTitle').getAttribute('aria-expanded')
  };
});
const typeFresh = async (pg, text) => { await pg.fill('#bfTitle', ''); await pg.click('#bfTitle'); if (text) await pg.keyboard.type(text); await pg.waitForTimeout(80); };

// ── desktop ──
console.log('\n── desktop');
let pg = await open({ width: 1440, height: 900 });
await typeFresh(pg, '');
let s = await state(pg);
ok('focus with nothing typed opens the series list', s.open && /locality letters, then a number/.test(s.head), JSON.stringify(s));
ok('each series shows its next free code', s.opts.includes('TNAG | Next: TNAG0003') && s.opts.includes('NOL | Next: NOL003') && s.opts.includes('THVA | Next: THVA002'), s.opts.join(' / '));
ok('a series with a gap still goes past its highest (VIVA0004 → VIVA0005)', s.opts.includes('VIVA | Next: VIVA0005'), s.opts.join(' / '));
ok('a bare-number id is not a series', !s.opts.some(o => /^17/.test(o)));
await pg.screenshot({ path: join(OUT, '1-series.png') });

await typeFresh(pg, 'tnag');
s = await state(pg);
ok('"tnag" offers the next free code as new', s.opts[0] === 'TNAG0003 | New', s.opts.join(' / '));
ok('"tnag" lists the taken codes as Already exists', s.opts.includes('TNAG0001 | Already exists') && s.opts.includes('TNAG0002 | Already exists'), s.opts.join(' / '));
ok('the line under the field says to add the number', /next free code is TNAG0003/.test(s.verdict), s.verdict);
await pg.screenshot({ path: join(OUT, '2-tnag.png') });

await typeFresh(pg, 'T');
s = await state(pg);
ok('one letter: every series starting with it, and codes', s.opts.includes('TNAG0003 | New') && s.opts.includes('THVA002 | New') && s.opts.includes('THVA001 | Already exists'), s.opts.join(' / '));

await typeFresh(pg, 'TNAG0002');
s = await state(pg);
ok('a taken code is listed first among the existing ones', s.opts.includes('TNAG0002 | Already exists'), s.opts.join(' / '));
ok('a taken code is called out under the field', /TNAG0002 already exists — 3BHK Usman Road, T Nagar/.test(s.verdict) && /use TNAG0003/.test(s.verdict) && /dup/.test(s.vkind), s.verdict);
await pg.screenshot({ path: join(OUT, '3-taken.png') });

await typeFresh(pg, 'tnag-0002');
s = await state(pg);
ok('case and dashes do not hide a duplicate', /TNAG0002 already exists/.test(s.verdict), s.verdict);

await typeFresh(pg, 'THVA0001');
s = await state(pg);
ok('a padding slip is pointed out', /Did you mean THVA001/.test(s.verdict) && /warn/.test(s.vkind), s.verdict);

await typeFresh(pg, 'TNAG0009');
s = await state(pg);
ok('an off-series number points at the next free code', /TNAG series is at TNAG0002 — the next free code is TNAG0003/.test(s.verdict), s.verdict);

await typeFresh(pg, 'tnag0003');
s = await state(pg);
ok('the next free code is new', /✓ TNAG0003 is a new code/.test(s.verdict) && /ok/.test(s.vkind), s.verdict);

await typeFresh(pg, 'ZZQ0001');
s = await state(pg);
ok('a brand-new series is simply new', /✓ ZZQ0001 is a new code/.test(s.verdict) && !s.open, JSON.stringify(s));

// preview of the existing property, with a way to open it in a new tab
await typeFresh(pg, 'NOL002');
await pg.evaluate(() => document.activeElement.blur());
ok('a taken code offers a preview button, card closed', await pg.locator('.bf-prev-btn').count() === 1 && await pg.locator('.bf-prev').count() === 0);
await pg.click('.bf-prev-btn');
const card = await pg.evaluate(() => { const c = document.querySelector('.bf-prev'); const a = c && c.querySelector('.bf-prev-open'); return c && { text: c.textContent.replace(/\s+/g, ' '), href: a.getAttribute('href'), target: a.target, rel: a.rel, btn: document.querySelector('.bf-prev-btn').textContent }; });
ok('the preview shows the property', card && /NOL002/.test(card.text) && /3BHK in Velachery/.test(card.text), JSON.stringify(card));
ok('"Open property" opens that property in a new tab', card && card.href === 'property.html?id=NOL002' && card.target === '_blank' && /noopener/.test(card.rel), JSON.stringify(card));
ok('the button now hides it', card && card.btn === 'Hide preview');
await pg.screenshot({ path: join(OUT, '6-preview.png') });
const [tab] = await Promise.all([pg.context().waitForEvent('page'), pg.click('.bf-prev-open')]);
ok('clicking it opens a second tab on property.html?id=NOL002', /property\.html\?id=NOL002$/.test(tab.url()), tab.url());
await tab.close();
await pg.click('.bf-prev-btn');
ok('keyboard focus stays on the button after toggling', await pg.evaluate(() => document.activeElement && document.activeElement.classList.contains('bf-prev-btn')));
ok('Hide preview closes the card', await pg.locator('.bf-prev').count() === 0);
await pg.click('.bf-prev-btn');
await pg.fill('#bfTitle', 'NOL001 - x'); await pg.evaluate(() => bfCodeVerdict());
ok('a different code does not keep the old preview open', await pg.locator('.bf-prev').count() === 0);
await typeFresh(pg, 'THVA0001');
await pg.evaluate(() => document.activeElement.blur());
ok('a "did you mean" message can preview the near-miss', await pg.locator('.bf-prev-btn').count() === 1 && /THVA001/.test(await pg.locator('.bf-prev-btn').textContent()));

// keyboard
await typeFresh(pg, 'tnag');
await pg.keyboard.press('ArrowDown');
s = await state(pg);
ok('ArrowDown highlights the first option', s.at === 'TNAG0003', s.at);
await pg.keyboard.press('Enter');
s = await state(pg);
ok('Enter picks it, the form is not submitted', s.value === 'TNAG0003 - ' && !s.open && pg.__posts.length === 0, JSON.stringify(s));
ok('aria-expanded follows the list', s.expanded === 'false');
await pg.keyboard.type('3BHK near Pondy Bazaar');
s = await state(pg);
ok('typing the title: the list steps aside, the verdict stays', !s.open && /TNAG0003 is a new code/.test(s.verdict), JSON.stringify(s));

await typeFresh(pg, 'tna');
await pg.keyboard.press('Escape');
s = await state(pg);
ok('Escape closes the list', !s.open);
ok('…and only the list — the page stays open', await pg.evaluate(() => document.getElementById('brochurePanel').classList.contains('open')));
await pg.keyboard.press('Escape');
ok('a second Escape closes the page as before', await pg.evaluate(() => !document.getElementById('brochurePanel').classList.contains('open')));
await pg.evaluate(() => openBrochurePage());

// picking keeps the title typed after the code
await pg.fill('#bfTitle', 'tnag 3BHK, Usman Road');
await pg.click('#bfTitle');
await pg.evaluate(() => { const i = document.getElementById('bfTitle'); i.setSelectionRange(4, 4); bfCodeInput(); });
s = await state(pg);
ok('caret back in the code reopens the list', s.open, JSON.stringify(s));
await pg.click('.bf-code-opt[data-i="0"]');
s = await state(pg);
ok('clicking a code keeps the title already typed', s.value === 'TNAG0003 - 3BHK, Usman Road', s.value);

// submitting a taken code asks first
await pg.fill('#bfTitle', 'NOL002 - 3BHK in Velachery');
await pg.fill('#bfDetails', '3BHK, 1200 sqft, Velachery.');
let asked = '';
pg.once('dialog', d => { asked = d.message(); d.dismiss(); });
await pg.click('#bfSubmitBtn');
await pg.waitForTimeout(200);
ok('a taken code is asked about on submit', /NOL002 already exists — 3BHK in Velachery/.test(asked) && /use NOL003/.test(asked), asked);
ok('cancelling does not submit', pg.__posts.length === 0, String(pg.__posts.length));
pg.once('dialog', d => d.accept());
await pg.click('#bfSubmitBtn');
await pg.waitForTimeout(400);
ok('confirming submits (a redo of that property)', pg.__posts.length === 1, String(pg.__posts.length));

await pg.evaluate(() => newBrochure());
await pg.fill('#bfTitle', 'NOL003 - Villa');
await pg.fill('#bfDetails', 'Villa.');
let askedNew = false;
const spy = d => { askedNew = true; d.accept(); };
pg.on('dialog', spy);
await pg.click('#bfSubmitBtn');
await pg.waitForTimeout(400);
pg.off('dialog', spy);
ok('a new code submits without asking', !askedNew && pg.__posts.length === 2);

// what is posted is the code as the pipeline files it
const lastTitle = () => decodeURIComponent((pg.__posts[pg.__posts.length - 1] || '').match(/entry\.1238821452=([^&]*)/)?.[1] || '').replace(/\+/g, ' ');
await pg.evaluate(() => newBrochure());
await pg.fill('#bfTitle', 'tnag-0002 - redo'); await pg.fill('#bfDetails', 'redo');
pg.once('dialog', d => d.accept());
await pg.click('#bfSubmitBtn'); await pg.waitForTimeout(300);
ok('a typed variant goes out as the stored code (tnag-0002 → TNAG0002)', lastTitle() === 'TNAG0002 - redo', lastTitle());
await pg.evaluate(() => newBrochure());
await pg.fill('#bfTitle', 'srs_omr001 - redo'); await pg.fill('#bfDetails', 'redo');
pg.once('dialog', d => d.accept());
await pg.click('#bfSubmitBtn'); await pg.waitForTimeout(300);
ok('an underscore code keeps its stored spelling', lastTitle() === 'SRS_OMR001 - redo', lastTitle());
await pg.evaluate(() => newBrochure());
await pg.fill('#bfTitle', 'tnag0003 - new'); await pg.fill('#bfDetails', 'new');
await pg.click('#bfSubmitBtn'); await pg.waitForTimeout(300);
ok('a new code goes out in capitals', lastTitle() === 'TNAG0003 - new', lastTitle());

// Enter with the list open and nothing highlighted never submits
await pg.evaluate(() => newBrochure());
await pg.fill('#bfDetails', 'details already pasted');
const before = pg.__posts.length;
await typeFresh(pg, 'tna');
await pg.keyboard.press('Enter');
s = await state(pg);
ok('Enter with the list open and nothing highlighted closes it, no submit', !s.open && pg.__posts.length === before, JSON.stringify(s));

// dashboard-made ids and underscore codes are not series
await typeFresh(pg, '');
s = await state(pg);
ok('no bogus series from a p<timestamp> id', !s.opts.some(o => /^P \|/.test(o)), s.opts.join(' / '));
ok('an underscore code is not a series either', !s.opts.some(o => /^SRS/.test(o)), s.opts.join(' / '));
await typeFresh(pg, 'srs_omr001');
s = await state(pg);
ok('an underscore code is still reported as existing', /SRS_OMR001 already exists/.test(s.verdict), s.verdict);

// draft restore shows the verdict
await pg.evaluate(() => { newBrochure(); document.getElementById('bfTitle').value = 'THVA001 - Lux'; saveBrochureDraft(); closeBrochurePage(); document.getElementById('bfTitle').value = ''; bfCodeVerdict(); openBrochurePage(); });
await pg.waitForTimeout(150);
s = await state(pg);
ok('a restored draft shows its verdict', /THVA001 already exists/.test(s.verdict), s.verdict);
await pg.context().close();

// before the real inventory loads (sample data only) there is no verdict to trust
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const g = await ctx.newPage();
  await g.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'dash.local') return route.abort();
    if (url.pathname === '/dashboard-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.__ready = true;' });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true,"entries":[]}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await g.goto('http://dash.local/dashboard.html');
  await g.waitForFunction(() => window.__ready === true && !!window.BrochureCodes);
  await g.evaluate(() => { const r = document.getElementById('appRoot'); if (r) r.style.display = ''; openBrochurePage(); });
  await g.click('#bfTitle'); await g.keyboard.type('TNAG0002');
  const early = await state(g);
  ok('before the inventory loads: no verdict, no list', early.verdict === '' && !early.open, JSON.stringify(early));
  await g.evaluate(p => window.applyPropertiesSnapshot(p), PROPS);
  await g.waitForTimeout(100);
  ok('…and the verdict appears once it does', /TNAG0002 already exists/.test((await state(g)).verdict));
  await ctx.close();
}

// ── phone, light and dark ──
for (const scheme of ['light', 'dark']) {
  console.log(`\n── phone ${scheme}`);
  pg = await open({ width: 390, height: 844 }, scheme);
  await typeFresh(pg, 'tnag');
  const m = await pg.evaluate(() => {
    const pop = document.getElementById('bfCodePop').getBoundingClientRect();
    const sc = document.getElementById('brochurePanel');
    return { left: pop.left, right: pop.right, vw: innerWidth, docW: document.documentElement.scrollWidth, panelSW: sc.scrollWidth, panelCW: sc.clientWidth };
  });
  ok('the list fits the screen', m.left >= 0 && m.right <= m.vw, JSON.stringify(m));
  ok('no sideways scroll', m.docW <= m.vw && m.panelSW <= m.panelCW, JSON.stringify(m));
  await pg.screenshot({ path: join(OUT, `4-phone-${scheme}.png`) });
  await typeFresh(pg, 'TNAG0002');
  await pg.screenshot({ path: join(OUT, `5-phone-${scheme}-taken.png`) });
  await pg.context().close();
}

await browser.close();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall passed');
process.exit(errors.length ? 1 : 0);
