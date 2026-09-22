// ═══════ MATCHING — PREVIEW / SMOKE TEST ACROSS ALL THREE CONSOLES ═══════
//
// The engine has 176 unit assertions behind it. They cannot tell you whether
// the panel actually renders, whether the tab is reachable, or whether a
// script-order mistake left window.PinMatch undefined on one page. This does.
//
// Opens the REAL dashboard.html, crm.html and propertytrack.html in Chromium
// with each page's firebase-sync.js swapped for an in-memory stand-in, on one
// shared set of properties and leads built so that every state the panel has
// to draw is on screen at least once:
//
//   · a strong match, a partial one and a long shot
//   · a buyer ruled out by their own words ("said the price is high")
//   · a buyer ruled out by type (a plot buyer against a flat)
//   · a lead with nothing to match on — the "fill in Budget" empty state
//   · a listing that is not in the inventory yet (the Track board's case)
//
// Any page error, any console error and any missing element fails the run,
// and each console is shot at desktop and phone width.
//
//   node tests/match-preview.mjs <out-dir>

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] || 'tests/out/match';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const T = 't_3pinrealty';
const NOW = Date.now();
const D = 86400000;

// ═══════ THE FIXTURE ═══════
//
// Small and hand-built rather than the 131-property snapshot: this test is
// about the panel, and a fixture you can hold in your head is one whose
// expected output you can also hold in your head.

const PROPERTIES = [
  { id: 'p1', tenantId: T, propertyCode: 'ANR0099', name: 'Kanaka Residency', location: 'Anna Nagar, Chennai',
    zone: 'Chennai Central', config: '3BHK', startingPrice: '₹3.5 Crores', sqftRange: '1750-1900 Sq.Ft',
    type: 'Apartments', status: 'Ready to Move', availability: 'Available', facing: 'East', vastu: 'Yes',
    approval: 'CMDA', parkingType: 'Covered', totalFloors: 'Stilt + 5', parking: '2',
    amenities: 'Swimming Pool,Gym,Indoor Kids Play Area,Clubhouse',
    highlights: 'Gated Community,Covered Car Parking,Walking distance to schools',
    nearbyLandmark: 'Anna Nagar Metro Station 900m', connectivity: '5 Mins from Anna Nagar Roundtana',
    contactName: 'Site office', contactNumber: '90000 00001', createdAt: NOW - 20 * D },

  { id: 'p2', tenantId: T, propertyCode: 'ANR0042', name: 'Prestige Lakeview', location: 'Anna Nagar West, Chennai',
    zone: 'Chennai Central', config: '3BHK', startingPrice: '₹3.5 Crores', sqftRange: '1700-1850 Sq.Ft',
    type: 'Apartments', status: 'Ready to Move', availability: 'Available',
    amenities: 'Gym,Clubhouse', createdAt: NOW - 40 * D },

  { id: 'p3', tenantId: T, propertyCode: 'AMJ0007', name: 'Sterling Grand', location: 'Aminjikarai, Chennai',
    zone: 'Chennai Central', config: '2BHK/3BHK', startingPrice: '₹2.65 Crores', sqftRange: '1450-1700 Sq.Ft',
    type: 'Apartments', status: 'Under Construction', possession: 'Q2 - 2028', availability: 'Available',
    amenities: 'Gym,Park', createdAt: NOW - 8 * D },

  { id: 'p4', tenantId: T, propertyCode: 'MGD0014', name: 'Green Acres Layout', location: 'Mangadu, Chennai',
    zone: 'Chennai West', config: '----', startingPrice: '₹95 Lakhs', plotSize: '1200-2400 Sq.Ft',
    type: 'Plots', status: 'Ready to Move', approval: 'DTCP', availability: 'Available',
    highlights: '30 feet approach road,Gated layout', createdAt: NOW - 15 * D },

  { id: 'p5', tenantId: T, propertyCode: 'SHO0031', name: 'Ocean Crest', location: 'Sholinganallur, OMR, Chennai',
    zone: 'Chennai South', config: '3BHK', startingPrice: '₹2.8 Crores', sqftRange: '1600-1750 Sq.Ft',
    type: 'Apartments', status: 'Ready to Move', availability: 'Available',
    nearbyLandmark: '10 Mins from Sholinganallur Junction', createdAt: NOW - 5 * D }
];

const LEADS = [
  // The reference case: 17% over budget, everything else right → strong.
  { id: 'ld1', tenantId: T, name: 'Karthik Subramaniam', phone: '98765 43211', email: 'karthik.s@example.com',
    propertyInterest: '3 BHK in Anna Nagar', budget: '3 Cr', enquiryType: 'Buyer', stageId: 'options',
    createdAt: NOW - 20 * D, updatedAt: NOW - 2 * D, noteCount: 0 },

  // Ruled out by their own words — the case the whole objection layer exists for.
  { id: 'ld2', tenantId: T, name: 'Suresh Kumar', phone: '98765 43213',
    propertyInterest: '3 BHK in Anna Nagar', budget: '3 Cr', enquiryType: 'Buyer', stageId: 'visit_done',
    propertyCodes: ['p2'], createdAt: NOW - 30 * D, updatedAt: NOW - 3 * D, noteCount: 1,
    lastNote: { text: 'Site visit done at ANR0042. Liked the layout but said the price is high for his budget.', createdAt: NOW - 3 * D } },

  // A rich brief — the semantic layer should fire and be visible in the reasons.
  { id: 'ld3', tenantId: T, name: 'Divya Sundaram', phone: '98765 43216',
    propertyInterest: '3BHK near Anna Nagar, gated community, need a good school for the kids and a play area',
    budget: '3.6 Cr', enquiryType: 'Buyer', stageId: 'new', createdAt: NOW - 4 * D, updatedAt: NOW - 4 * D },

  // A plot buyer: must be ruled out against every flat, and matched to p4.
  { id: 'ld4', tenantId: T, name: 'Lakshmi Narayanan', phone: '98765 43214',
    propertyInterest: 'DTCP approved plot in Mangadu, 30 feet road', budget: '1 Cr',
    enquiryType: 'Buyer', stageId: 'new', createdAt: NOW - 12 * D, updatedAt: NOW - D },

  // Nothing to match on: the empty state that names the field to fill in.
  { id: 'ld5', tenantId: T, name: 'Anonymous enquiry', phone: '98765 43219',
    enquiryType: 'Buyer', stageId: 'new', createdAt: NOW - D, updatedAt: NOW - D },

  // A seller — never matched TO properties; matched the other way instead.
  { id: 'ld6', tenantId: T, name: 'Meena Krishnan', phone: '98765 43218',
    enquiryType: 'Seller Listing', propertyInterest: 'selling my 3 BHK in Anna Nagar, asking 3.4 Cr',
    stageId: 'new', createdAt: NOW - 6 * D, updatedAt: NOW - 2 * D },

  // A vendor is neither a buyer nor a seller and gets no matching at all.
  { id: 'ld7', tenantId: T, name: 'Vendor Co', phone: '98765 43220',
    enquiryType: 'Vendor', propertyInterest: 'photography and drone services',
    stageId: 'new', createdAt: NOW - 2 * D, updatedAt: NOW - 2 * D }
];

const STAGES = [
  { id: 'new', key: 'new', name: 'New', kind: 'open', color: '#1D4ED8' },
  { id: 'options', key: 'options', name: 'Options sent', kind: 'open', color: '#0891B2' },
  { id: 'visit_done', key: 'visit_done', name: 'Visited', kind: 'open', color: '#7C3AED' },
  { id: 'won', key: 'won', name: 'Won', kind: 'won', color: '#15803D' },
  { id: 'lost', key: 'lost', name: 'Lost', kind: 'lost', color: '#B91C1C' }
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2' };
const J = v => JSON.stringify(v);

const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label + (detail !== undefined ? ' — ' + detail : '')); }
};

// One page opener for all three consoles: route every request at a fake host
// to the repo on disk, and swap that console's firebase-sync.js for a stub.
async function open(host, page_, stubPath, stubBody, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${host} ${viewport.width}px pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // External fonts and Font Awesome are blocked by the router below; that
    // is the harness, not the page.
    if (/Failed to load resource|net::ERR|fonts\.googleapis|cdnjs/.test(t)) return;
    errors.push(`${host} ${viewport.width}px console: ${t}`);
  });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== host) return route.abort();
    if (url.pathname === stubPath) return route.fulfill({ contentType: 'text/javascript', body: stubBody });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto(`http://${host}/${page_}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  return page;
}

const shot = (page, name) => page.screenshot({ path: join(OUT, name + '.png'), fullPage: false });
const texts = (page, sel) => page.$$eval(sel, els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));

// ═══════════════════════════════════════════════════════════════════════
// 1. PROPERTIES CONSOLE — "who wants this?"
// ═══════════════════════════════════════════════════════════════════════

const DASH_STUB = `
window.dashboardFirebase = {
  saveProperty: async () => {}, deleteProperty: async () => {},
  getPropertyNotes: async () => [], savePropertyNote: async () => {}, deletePropertyNote: async () => {},
  getInternalNotes: async () => [], saveInternalNote: async () => {}, deleteInternalNote: async () => {},
  saveChanges: async () => {}, getChanges: async () => [],
  getLeads: async () => ${J(LEADS)},
  subscribeToProperty: () => () => {}
};
window.dashboardAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
setTimeout(() => {
  if (window.onDashboardAuthChange) window.onDashboardAuthChange({ email: 'agent.a@example.com' });
  if (window.onPinTenantReady) window.onPinTenantReady('${T}');
  window.applyPropertiesSnapshot(${J(PROPERTIES)});
  window.__ready = true;
}, 0);
`;

console.log('\nProperties console — Matching Buyers');
for (const vp of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  const page = await open('dash.local', 'dashboard.html', '/dashboard-assets/firebase-sync.js', DASH_STUB, vp);
  const tag = vp.width === 390 ? 'phone' : 'desktop';

  ok(`${tag}: the engine is loaded`, await page.evaluate(() => !!window.PinMatch && !!window.PinMatchPanel && !!window.PinAreaModel));

  // Open the 3.5 Cr Anna Nagar flat and go to the new tab.
  await page.evaluate(() => window.openDetail('p1'));
  await page.waitForTimeout(200);
  const tabs = await texts(page, '.dp-tab');
  ok(`${tag}: the Matching Buyers tab exists`, tabs.includes('Matching Buyers'), J(tabs));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.dp-tab')].find(t => /Matching Buyers/.test(t.textContent));
    b.click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('dpMatches');
    return el && /worth calling|No buyer|no leads/i.test(el.textContent || '');
  }, null, { timeout: 10000 });
  await page.waitForTimeout(250);

  const body = await page.$eval('#dpMatches', e => e.textContent.replace(/\s+/g, ' '));
  const rows = await texts(page, '#dpMatches .pm-row');

  if (vp.width === 1440) {
    ok('the strong match is offered', /Karthik/.test(body), body.slice(0, 200));
    ok('the rich brief is offered too', /Divya/.test(body));
    ok('and it scores in the nineties', /9\d%/.test(body), (body.match(/\d+%/g) || []).join(','));
    ok('the seller is never offered as a buyer', !/Meena/.test(body));
    ok('nor is the vendor', !/Vendor Co/.test(body));
    ok('the price-objecting buyer is not in the live list',
      !rows.slice(0, 2).some(r => /Suresh/.test(r)), J(rows.map(r => r.slice(0, 40))));
    ok('there is a ruled-out section', /ruled out/.test(body), body.slice(-200));

    // Expand it and check the reason quotes the buyer.
    await page.evaluate(() => document.querySelector('#dpMatches [data-pm-toggle="out"]').click());
    await page.waitForTimeout(200);
    const out = await page.$eval('#dpMatches', e => e.textContent.replace(/\s+/g, ' '));
    ok('the ruled-out buyer is named', /Suresh/.test(out));
    ok('and the reason quotes their own words', /price is high/.test(out), out.slice(-300));
    ok('the plot buyer is ruled out on type', /Lakshmi/.test(out) && /looking for somewhere to live|Plot/.test(out));

    // The score bar must actually be drawn, with a segment per attribute.
    const segs = await page.$$eval('#dpMatches .pm-row .pm-seg', e => e.length);
    ok('the score bar is drawn', segs > 0, String(segs));

    // The explainer is built from the engine's table.
    await page.evaluate(() => document.querySelector('#dpMatches [data-pm-toggle="how"]').click());
    await page.waitForTimeout(150);
    const how = await page.$eval('#dpMatches', e => e.textContent);
    ok('the "how is this scored" note opens', /How the score is worked out/.test(how));
    ok('and names the real weights', /Budget 28|Location 22/.test(how), how.slice(0, 260));
    await shot(page, 'dash-matches-desktop');

    // ── The search bar's two new halves ──
    await page.evaluate(() => window.closeDetail ? window.closeDetail() : document.getElementById('dp').classList.remove('open'));
    await page.waitForTimeout(150);

    // Close matches: a query with five conditions that nothing satisfies in
    // full. The old answer was "No properties match your search"; the useful
    // answer names what each near-miss is missing.
    await page.fill('#searchInput', '3 bhk in anna nagar ready to move vastu east facing');
    await page.waitForTimeout(400);
    const nmVisible = await page.evaluate(() => {
      const el = document.getElementById('nearMisses');
      return el && !el.hidden ? el.textContent.replace(/\s+/g, ' ') : '';
    });
    ok('close matches appear for an over-specified query', /almost match|come close/.test(nmVisible), nmVisible.slice(0, 180) || '(nothing)');
    ok('and each one names what it is missing', /missing /.test(nmVisible), nmVisible.slice(0, 240));
    // The label has to be the agent's spelling, not the engine's internal
    // token: "East facing", never "eastfacing"; "3 BHK", never "BHK 3".
    ok('in the words an agent uses, not the internal token',
      !/eastfacing|readytomove|BHK 3/.test(nmVisible), nmVisible.slice(0, 240));

    // Hybrid ranking must not change WHICH properties come back — only their
    // order. That is the contract that keeps the 748-assertion search suite
    // meaningful.
    const fusedIds = await page.evaluate(() => {
      const t = '3 bhk in anna nagar';
      const base = window.pinAllProperties();
      const lex = window.PinSearch.search(base, { text: t });
      const fused = window.PinMatch.fuse(lex, base, t);
      return { lex: lex.map(h => h.p.id).sort(), fused: fused.map(h => h.p.id).sort() };
    });
    ok('fusion re-orders the result set without changing it',
      JSON.stringify(fusedIds.lex) === JSON.stringify(fusedIds.fused), JSON.stringify(fusedIds));

    // Client brief: a whole sentence, including an objection, ranked.
    await page.fill('#searchInput', '');
    await page.waitForTimeout(250);
    await page.click('#briefBtn');
    await page.fill('#briefText', '3 BHK somewhere near Anna Nagar, budget around 3 crore, needs a good school for the kids and a gated community');
    await page.click('.brief-go');
    await page.waitForFunction(() => {
      const el = document.getElementById('briefResults');
      return el && !el.hidden && /worth sending|Nothing in the inventory/.test(el.textContent || '');
    }, null, { timeout: 10000 });
    await page.waitForTimeout(250);
    const brief = await page.$eval('#briefResults', e => e.textContent.replace(/\s+/g, ' '));
    ok('a client brief ranks the inventory', /worth sending/.test(brief), brief.slice(0, 160));
    ok('the brief is echoed back so it can be checked', /near Anna Nagar/.test(brief));
    ok('it offers the Anna Nagar flat first', /Kanaka|ANR0099/.test(brief.slice(0, 700)), brief.slice(0, 400));
    ok('the school/gated wording is credited in the reasons',
      /schools and family life|gated security/.test(brief), brief.slice(0, 900));
    ok('the grid is hidden while a brief is being matched',
      await page.$eval('#pgrid', e => e.style.display === 'none'));
    await shot(page, 'dash-brief-desktop');

    await page.click('#briefResults .pm-link');   // Clear
    await page.waitForTimeout(300);
    ok('clearing the brief brings the grid back',
      await page.$eval('#pgrid', e => e.style.display !== 'none'));
  } else {
    ok('phone: matches still render', rows.length > 0, String(rows.length));
    const wide = await page.evaluate(() => {
      const el = document.getElementById('dpMatches');
      return el.scrollWidth <= el.clientWidth + 2;
    });
    ok('phone: nothing overflows sideways', wide);
    await shot(page, 'dash-matches-phone');
  }
  await page.context().close();
}

// ═══════════════════════════════════════════════════════════════════════
// 1b. THE AREA MAP — the model's working, auditable
// ═══════════════════════════════════════════════════════════════════════
//
// Driven over the REAL 131-property inventory rather than the fixture above:
// this panel exists to show what was learned from a messy sheet, and five
// clean rows learn nothing worth looking at.

console.log('');
console.log('Properties console — Area map');
{
  const REAL = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/properties-snapshot.json'), 'utf8'))
    .map(p => ({ ...p, tenantId: T }));
  const stub = DASH_STUB.replace(/window\.applyPropertiesSnapshot\([\s\S]*?\);/, 'window.applyPropertiesSnapshot(' + J(REAL) + ');');
  const page = await open('dash.local', 'dashboard.html', '/dashboard-assets/firebase-sync.js', stub, { width: 1440, height: 1100 });

  await page.evaluate(() => window.openAreaMap());
  await page.waitForTimeout(700);
  const body = await page.$eval('#amBody', e => e.textContent.replace(/\s+/g, ' '));
  const count = await page.$eval('#amCount', e => e.textContent.replace(/\s+/g, ' '));

  ok('the area map opens', await page.$eval('#areaMapPanel', e => e.classList.contains('open')));
  // A full-bleed panel is a page, not a dialog: it has to sit BESIDE the app
  // rail, not under it. Every such panel needs adding to the inset rule in
  // shared-assets/appnav.css, and forgetting hides its left 250px.
  const inset = await page.evaluate(() => {
    const p = document.getElementById('areaMapPanel');
    const rail = document.getElementById('appRail');
    if (!p || !rail || getComputedStyle(rail).display === 'none') return { skip: true };
    return { panel: p.getBoundingClientRect().left, rail: rail.getBoundingClientRect().right };
  });
  ok('and sits beside the app rail, not underneath it',
    inset.skip || inset.panel >= inset.rail - 1, JSON.stringify(inset));
  ok('it reports how many areas it knows', /\d+ areas/.test(count), count);
  ok('it separates localities from streets and blocks', /streets & blocks|streets &amp; blocks/.test(body), body.slice(0, 200));
  ok('it says what it learned each fact from', /containment|stated distances/.test(body), body.slice(0, 400));

  // The two claims that matter most, because they are the ones that keep the
  // model honest: what it could not place, and what contradicted it.
  ok('it lists the contradictions it found', /disagree with the map/.test(body), body.slice(0, 600));
  ok('and says it has stopped trusting them', /stopped trusting/.test(body));
  ok('it owns up to what it cannot place', /cannot place/.test(body));
  ok('and states that unplaced means unknown, not far',
    /never as far away/.test(body), body.slice(0, 900));

  // The learned hierarchy has to be visible, name by name — this is the
  // answer to "I cannot map the areas".
  ok('a street shows the locality it sits inside',
    /inside Anna Nagar East|inside Korattur|inside Adyar/.test(body), body.slice(0, 1200));
  ok('an area worked out rather than known says so', /worked out/.test(body), body.slice(0, 1400));

  await page.evaluate(() => { const el = document.getElementById('areaMapPanel'); el.scrollTop = el.scrollHeight * 0.45; });
  await page.waitForTimeout(200);
  await shot(page, 'dash-areamap-list');
  await page.evaluate(() => { document.getElementById('areaMapPanel').scrollTop = 0; });
  await page.waitForTimeout(200);
  await shot(page, 'dash-areamap');

  // Search narrows it.
  await page.fill('#amSearch', 'anna nagar');
  await page.waitForTimeout(250);
  const filtered = await page.$eval('#amBody .am-list', e => e.textContent.replace(/\s+/g, ' '));
  ok('searching an area narrows the list', /Anna Nagar/.test(filtered) && !/Mylapore/.test(filtered), filtered.slice(0, 200));
  await page.context().close();
}

// ═══════════════════════════════════════════════════════════════════════
// 2. CRM — "what do we show them?"
// ═══════════════════════════════════════════════════════════════════════

const CRM_STUB = `
window.crmFirebase = {
  saveLead: async () => {}, deleteLead: async () => {}, savePipeline: async () => {},
  saveNote: async () => {}, deleteNote: async () => {}, saveHistory: async () => {},
  getLeadNotes: async id => (${J(LEADS)}.find(l => l.id === id) || {}).lastNote
      ? [{ id: 'n1', ...(${J(LEADS)}.find(l => l.id === id) || {}).lastNote }] : [],
  getLeadHistory: async () => [],
  getInventory: async () => ${J(PROPERTIES)},
  getLeadTailorTalk: async () => null,
  watchLeadTailorTalk: () => () => {},
  releaseLeadField: async () => {}, updateLeadAiFields: async () => {},
  saveSettings: async () => {}
};
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
setTimeout(() => {
  window.applyPipelineSnapshot(${J(STAGES)});
  if (window.applyEnquiryTypesSnapshot) window.applyEnquiryTypesSnapshot(['Buyer','Seller Listing','Vendor']);
  window.applyLeadsSnapshot(${J(LEADS)});
  window.__ready = true;
}, 0);
`;

console.log('\nCRM — Properties for this buyer');
for (const vp of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  const page = await open('crm.local', 'crm.html', '/crm-assets/firebase-sync.js', CRM_STUB, vp);
  const tag = vp.width === 390 ? 'phone' : 'desktop';

  ok(`${tag}: the engine is loaded in the CRM too`, await page.evaluate(() => !!window.PinMatch && !!window.PinSearch));

  await page.evaluate(() => window.openDetail('ld1'));
  await page.waitForFunction(() => {
    const el = document.getElementById('dpMatch');
    return el && /worth sending|Nothing in the inventory|Nothing to match/i.test(el.textContent || '');
  }, null, { timeout: 10000 });
  await page.waitForTimeout(300);

  const body = await page.$eval('#dpMatch', e => e.textContent.replace(/\s+/g, ' '));
  if (vp.width === 1440) {
    ok('the section is visible for a buyer', await page.$eval('#dpMatchSec', e => !e.hidden));
    ok('it offers the Anna Nagar flat', /Kanaka|ANR0099/.test(body), body.slice(0, 200));
    ok('the 21 km OMR flat is not in the live list', !/Ocean Crest/.test(body.split('ruled out')[0]));
    ok('and the plot is ruled out for a 3BHK buyer', /ruled out/.test(body));
    await shot(page, 'crm-matches-desktop');

    // ── The seller flip ──
    // A seller must never be matched TO properties: they are not buying one,
    // and every field on their record means the opposite of a buyer's. The
    // question runs the other way instead — who is already waiting for what
    // this owner is selling — which is the sentence that wins a listing.
    await page.evaluate(() => window.openDetail('ld6'));
    await page.waitForFunction(() => {
      const el = document.getElementById('dpMatch');
      return el && /waiting|Nothing about the property/i.test(el.textContent || '');
    }, null, { timeout: 10000 });
    await page.waitForTimeout(300);
    const sellerTitle = await page.$eval('#dpMatchSec .sec-title', e => e.textContent.trim());
    const sellerBody = await page.$eval('#dpMatch', e => e.textContent.replace(/\s+/g, ' '));
    ok('a seller gets buyers, not properties', /Buyers waiting/.test(sellerTitle), sellerTitle);
    ok('and it is buyers that are listed', /waiting/i.test(sellerBody), sellerBody.slice(0, 160));
    ok('the buyers for their Anna Nagar flat are found', /Karthik|Divya/.test(sellerBody), sellerBody.slice(0, 300));
    ok('no property is offered to the seller', !/Kanaka|ANR0099|Sterling Grand/.test(sellerBody), sellerBody.slice(0, 300));
    await shot(page, 'crm-seller-buyers');

    // A vendor is neither, and gets nothing.
    await page.evaluate(() => window.openDetail('ld7'));
    await page.waitForTimeout(500);
    ok('a vendor gets no matching section at all', await page.$eval('#dpMatchSec', e => e.hidden));

    // A lead with nothing on it names the field to fill in.
    await page.evaluate(() => window.openDetail('ld5'));
    await page.waitForTimeout(500);
    const bare = await page.$eval('#dpMatch', e => e.textContent.replace(/\s+/g, ' '));
    ok('a lead with no requirement says what to fill in', /Property \/ Locality|Budget/.test(bare), bare.slice(0, 200));

    // The plot buyer gets the plot.
    await page.evaluate(() => window.openDetail('ld4'));
    await page.waitForTimeout(500);
    const plot = await page.$eval('#dpMatch', e => e.textContent.replace(/\s+/g, ' '));
    ok('the plot buyer is offered the plot', /Green Acres|MGD0014/.test(plot.split('ruled out')[0]), plot.slice(0, 220));
    ok('and the road width they asked about is credited', /30 ft|approach road/i.test(plot), plot.slice(0, 400));
    await shot(page, 'crm-matches-plot');

    // The CRM and the Track board declare their palette through light-dark(),
    // so the panel gets dark mode for free by reading tokens instead of
    // hardcoding colours — but "for free" is a claim worth checking rather
    // than assuming. A panel that reads its ink from a token and its ground
    // from a literal is invisible in dark mode, and nobody on a light screen
    // would ever see it happen.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.evaluate(() => window.openDetail('ld1'));
    await page.waitForTimeout(600);
    const dark = await page.evaluate(() => {
      const row = document.querySelector('#dpMatch .pm-row');
      if (!row) return null;
      const cs = getComputedStyle(row);
      const num = document.querySelector('#dpMatch .pm-sc-n');
      const parse = c => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = c => { const [r, g, b] = parse(c); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      return { bg: lum(cs.backgroundColor), ink: lum(cs.color), score: num ? lum(getComputedStyle(num).color) : null };
    });
    ok('dark mode: the panel renders', dark !== null);
    if (dark) {
      ok('dark mode: the card ground really is dark', dark.bg < 0.3, JSON.stringify(dark));
      ok('dark mode: the text is legible against it', Math.abs(dark.ink - dark.bg) > 0.35, JSON.stringify(dark));
      ok('dark mode: the score is legible too', dark.score == null || Math.abs(dark.score - dark.bg) > 0.15, JSON.stringify(dark));
    }
    await shot(page, 'crm-matches-dark');
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  } else {
    ok('phone: the CRM panel renders', /worth sending|Nothing/.test(body));
    await shot(page, 'crm-matches-phone');
  }
  await page.context().close();
}

// ═══════════════════════════════════════════════════════════════════════
// 3. PROPERTY & MEDIA TRACK — "is this worth shooting?"
// ═══════════════════════════════════════════════════════════════════════

const LISTINGS = [
  // Deliberately NOT in the inventory: the whole point is matching before the
  // property exists as a row anywhere.
  { id: 'ls1', tenantId: T, title: '3BHK in Anna Nagar', propertyCode: '', location: 'Anna Nagar',
    config: '3 BHK', askingPrice: '₹3.4 Cr', sellerName: 'Meena Krishnan', sellerPhone: '98765 43218',
    leadId: 'ld6', stageId: 'details', remarks: 'Gated community, covered parking, east facing',
    media: {}, stageChangedAt: NOW - 2 * D, createdAt: NOW - 3 * D, updatedAt: NOW - D },
  // Nothing to go on — the "add a location" empty state.
  { id: 'ls2', tenantId: T, title: 'Owner enquiry', propertyCode: '', sellerName: 'Unknown',
    stageId: 'details', media: {}, stageChangedAt: NOW - D, createdAt: NOW - D, updatedAt: NOW - D }
];

const TRACK_STUB = `
window.trackFirebase = {
  saveListing: async () => {}, deleteListing: async () => {}, savePipeline: async () => {},
  patchLead: async () => {}, getLeadConversation: async () => null,
  getInventory: async () => ${J(PROPERTIES)},
  getListingHistory: async () => [], saveHistory: async () => {}
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'agent.a@example.com' }, '${T}');
  window.applyTrackPipelineSnapshot(${J(STAGES.map(s => ({ ...s, key: s.key === 'options' ? 'details' : s.key, id: s.key === 'options' ? 'details' : s.id })))});
  window.applyListingsSnapshot(${J(LISTINGS)});
  window.applyTrackLeadsSnapshot(${J(LEADS)});
  window.__ready = true;
}, 0);
`;

console.log('\nProperty & Media Track — Who is already waiting');
{
  const page = await open('track.local', 'propertytrack.html', '/track-assets/firebase-sync.js', TRACK_STUB, { width: 1440, height: 1000 });
  ok('the engine is loaded on the Track board', await page.evaluate(() => !!window.PinMatch && !!window.PinMatchPanel));

  await page.evaluate(() => window.openDetail('ls1'));
  await page.waitForFunction(() => {
    const el = document.getElementById('dpBuyersList');
    return el && /waiting|Nobody|Not enough/i.test(el.textContent || '');
  }, null, { timeout: 10000 });
  await page.waitForTimeout(300);

  const body = await page.$eval('#dpBuyersList', e => e.textContent.replace(/\s+/g, ' '));
  ok('buyers are counted before the shoot', /waiting/i.test(body), body.slice(0, 160));
  ok('the real buyer is listed', /Karthik|Divya/.test(body), body.slice(0, 260));
  ok('it says the listing is not in the inventory yet', /not in the inventory yet/.test(
    await page.$eval('#dpBuyers', e => e.textContent)));
  await shot(page, 'track-buyers-desktop');

  // The thin listing must explain itself rather than show an empty list.
  await page.evaluate(() => window.openDetail('ls2'));
  await page.waitForTimeout(500);
  const thin = await page.$eval('#dpBuyersList', e => e.textContent.replace(/\s+/g, ' '));
  ok('a listing with nothing on it says what to add', /Location|Configuration|Asking price/.test(thin), thin.slice(0, 200));
  await page.context().close();
}

// ═══════ RESULT ═══════
await browser.close();
console.log('\n' + '─'.repeat(64));
console.log(`screenshots → ${OUT}`);
if (errors.length) {
  console.log(`\n${errors.length} problem(s):`);
  errors.forEach(e => console.log('  ✗ ' + e));
  process.exit(1);
}
console.log('All good.');
