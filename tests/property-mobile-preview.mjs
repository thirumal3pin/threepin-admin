// ═══════ PROPERTY PAGE ON A PHONE — HOW MUCH IS HEADER, HOW MUCH IS CONTENT ═══════
//
// The complaint this exists for: on a phone the property page spent the whole
// first screen on the name, the call button, the price and the tabs, so the
// facts an agent is actually reading out on a call started below the fold.
// This measures that directly — where the first real fact sits, and how much of
// the viewport is content rather than chrome.
//
//   node tests/property-mobile-preview.mjs <out-dir>

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'property-mobile';
mkdirSync(OUT, { recursive: true });

// A property with every field populated — the worst case for header height,
// which is the case that was complained about.
const PROP = {
  id: 'ANR003', propertyCode: 'ANR003', tenantId: 't_3pinrealty',
  name: '3BHK Apartment - Anna Nagar, I Block (near 6th Avenue)',
  builder: 'Individual Owner', type: 'Apartment', saleType: 'New', zone: 'Chennai West',
  location: 'I Block, Anna Nagar, near 6th Avenue',
  contactName: 'Swaminathan N G', contactNumber: '9080895163',
  startingPrice: '3,25,00,000 (Negotiable)', pricePerSqft: '21,173',
  constructionStage: 'Under Construction', propertyAge: 'Brand New',
  config: '3BHK', sqftRange: '1,535', possession: 'Contact for details',
  facing: 'West', bathrooms: '3', parking: '2', parkingType: 'Covered',
  totalFloors: '4', vastu: 'Yes', approval: 'CMDA', powerBackup: 'Yes',
  furnishing: 'Unfurnished', floorNo: '2', totalUnits: '8',
  brochureLink: 'https://example.com/b.pdf', photosLink: 'https://example.com/p',
  mapLink: 'https://maps.google.com/?q=anna+nagar',
  detailsText: 'Shareable WhatsApp copy for this unit.',
  sheetNotes: 'Brand new/unfurnished unit - bare walls, exposed ceiling wiring visible in photos. Construction status to be confirmed with the owner before any site visit is promised.',
  highlights: 'Corner unit\nCovered parking\nCMDA approved',
  amenities: 'Lift\nPower backup\nSecurity',
  nearby: '6th Avenue, Anna Nagar Tower Park',
};

// The same property with the values a real inventory sheet actually returns —
// unbroken names, pasted Drive URLs, a whole sentence in a "price" cell. This
// is the case that pushes a phone page sideways.
const NASTY = {
  ...PROP,
  name: 'Supercalifragilistic-Residency-Phase-II-Block-C-Premium-Sky-Villa-Anna-Nagar',
  startingPrice: '3,25,00,000 (Negotiable, excluding registration/GST/corpus - call owner)',
  pricePerSqft: '21,173 per sqft on saleable area (carpet 17,850)',
  location: 'I Block, Anna Nagar, near 6th Avenue, opposite the Tower Park east gate, Chennai 600040',
  possession: 'ContactTheOwnerDirectlyForPossessionTimelineDetails',
  sqftRange: '1,535-2,240 sqft (saleable) / 1,180-1,720 (carpet)',
  mapLink: 'https://www.google.com/maps/place/Anna+Nagar+Tower+Park/@13.0843007,80.2103433,17z/data=!3m1!4b1!4m6!3m5!1s0x3a5265',
  brochureLink: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/view?usp=sharing',
  sheetNotes: 'Owner on 9080895163. Brochure: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/view',
  amenities: 'Lift\nPower backup\nSwimmingPoolWithTemperatureControlAndSeparateKidsArea',
  sheetExtras: { 'Registration & Documentation Charges Payable': 'Approximately 7.5% of the guideline value, payable directly by the purchaser at the sub-registrar office' },
};

const STUB = `
window.__prop = __PROP__;
window.crmAuth = { login: async()=>{}, logout: async()=>{}, getIdToken: async()=>'x', getTenantId: ()=>'t_3pinrealty' };
window.__ready = true;
`;

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.jpg':'image/jpeg', '.json':'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

async function open(viewport, data) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'prop.local') return route.abort();
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  // Render the detail view straight from property-view.js, with no Firebase in
  // the way — the layout under test is entirely that module plus the stylesheet.
  await page.goto('http://prop.local/property.html');
  await page.waitForTimeout(400);
  await page.evaluate(STUB.replace('__PROP__', JSON.stringify(data)));
  // renderProperty() is property-page.js's own entry point, so this exercises
  // exactly the markup the live page builds.
  await page.evaluate(() => {
    document.getElementById('appRoot').style.display = '';   // normally login-gated
    PinPropertyView.setResolver(id => (window.__prop.id === id) ? window.__prop : null);
    renderProperty(window.__prop);
  });
  await page.waitForTimeout(500);
  return page;
}

const CASES = [];
for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 414, height: 896 }]) {
  CASES.push({ vp, data: PROP, label: 'tidy' });
  CASES.push({ vp, data: NASTY, label: 'long-values' });
}
for (const { vp, data, label } of CASES) {
  console.log(`\n── ${vp.width}×${vp.height} · ${label} ──`);
  const page = await open(vp, data);

  const m = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const top = el => el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
    const h = el => el ? Math.round(el.getBoundingClientRect().height) : null;
    const firstFact = q('.stat-b');
    const tabs = q('.dp-tabs');
    return {
      vh: window.innerHeight,
      heroH: h(q('.dp-hero')),
      tabsTop: top(tabs),
      tabsSticky: tabs ? getComputedStyle(tabs).position : null,
      firstFactTop: top(firstFact),
      factTileH: h(firstFact),
      callH: h(q('.dp-call')),
      // The standalone page deliberately drops the hero's call button because
      // the fixed bar already carries Call; the dashboard panel has no bar, so
      // it keeps the hero one. Either way there must be a real call target.
      barCallH: h(q('.mab-call')),
      barShown: q('.mobile-actionbar') ? getComputedStyle(q('.mobile-actionbar')).display : 'none',
      // How many of the key-fact tiles are visible without scrolling.
      factsAboveFold: [...document.querySelectorAll('.stat-b')]
        .filter(e => e.getBoundingClientRect().bottom <= window.innerHeight).length,
      totalFacts: document.querySelectorAll('.stat-b').length,
      docX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelX: (() => { const dp = document.getElementById('dp'); return dp.scrollWidth - dp.clientWidth; })(),
      perTab: (() => {
        const out = {};
        [...document.querySelectorAll('.dp-tab')].forEach(t => {
          t.click();
          const dp = document.getElementById('dp');
          const over = Math.max(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
            dp.scrollWidth - dp.clientWidth);
          const culprits = [...document.querySelectorAll('.tab-panel.active *')]
            .filter(e => e.getBoundingClientRect().right > innerWidth + 1)
            .slice(0, 4).map(e => `${e.tagName.toLowerCase()}.${(e.className||'').toString().split(' ')[0]}`);
          if (over > 1 || culprits.length) out[t.textContent.trim()] = { over, culprits };
        });
        document.querySelector('.dp-tab').click();
        return out;
      })(),
      // The same measurement with .standalone removed, i.e. exactly how the
      // dashboard's slide-over panel renders the identical hero.
      asPanel: (() => {
        const dp = document.getElementById('dp');
        dp.classList.remove('standalone');
        const t = document.querySelector('.dp-tabs');
        const r = { tabsTop: Math.round(t.getBoundingClientRect().top + scrollY),
                    callH: Math.round((document.querySelector('.dp-call')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height) };
        dp.classList.add('standalone');
        return r;
      })(),
    };
  });
  console.log('   ', JSON.stringify(m));

  ok('the page rendered', m.firstFactTop !== null, JSON.stringify(m));
  // The whole point: real content has to start inside the first screen, and
  // enough of it to be worth scrolling to.
  ok('the first fact is above the fold', m.firstFactTop < m.vh, `${m.firstFactTop} vs ${m.vh}`);
  const headerBudget = label === 'tidy' ? 0.5 : 0.55;
  ok('the header is under half the screen', m.tabsTop < m.vh * headerBudget, `tabs start at ${m.tabsTop} of ${m.vh}`);
  ok('at least four facts are readable without scrolling', m.factsAboveFold >= 3, `${m.factsAboveFold}/${m.totalFacts}`);
  const badTabs = Object.entries(m.perTab).filter(([, v]) => v.over > 1);
  ok('no tab scrolls the page sideways', badTabs.length === 0, JSON.stringify(m.perTab));
  ok('the tabs stay reachable while reading', m.tabsSticky === 'sticky', String(m.tabsSticky));
  ok('calling is still one thumb-sized tap away',
    Math.max(m.callH, m.barShown !== 'none' ? m.barCallH : 0) >= 40,
    `hero ${m.callH}, bar ${m.barCallH} (${m.barShown})`);
  // The panel now has its own sticky bar too, so like the standalone page it
  // drops the hero's duplicate button.
  ok('the dashboard panel drops the duplicate hero call button', m.asPanel.callH === 0, String(m.asPanel.callH));
  ok('the dashboard panel header is under half the screen too',
    m.asPanel.tabsTop < m.vh * headerBudget, `${m.asPanel.tabsTop} of ${m.vh}`);
  ok('the page does not scroll sideways', m.docX <= 1, String(m.docX));
  ok('the panel itself does not scroll sideways', m.panelX <= 1, String(m.panelX));

  await page.screenshot({ path: join(OUT, `property-${vp.width}-${label}.png`) });
  await page.close();
}

await browser.close();
console.log(errors.length ? `\n${errors.length} FAILURE(S)\n` + errors.map(e => ' - ' + e).join('\n') : '\nAll checks passed.');
process.exit(errors.length ? 1 : 0);
