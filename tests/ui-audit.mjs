// ═══════ UI AUDIT — THE REAL INVENTORY, MEASURED ═══════
//
//   node tests/ui-audit.mjs <out-dir>
//
// Opens the real dashboard.html with the REAL 131-property snapshot, at the
// viewports the agents actually use, and MEASURES the things a design review
// otherwise just argues about:
//
//   · how much vertical space is spent before the first result
//   · whether any control is clipped or scrolled out of its own container
//   · whether anything overflows sideways
//   · tap targets under 30px, text under 11.5px
//   · text/background contrast, computed, against WCAG AA
//
// It exists because the owner reported "half page for title and filters" and
// a UI that "is not user friendly", and a screenshot is not a measurement.
// Anything this prints as FAIL is a defect with a number attached to it.

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] || 'tests/out/ui';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const T = 't_3pinrealty';
const J = v => JSON.stringify(v);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };

// The real thing, not a fixture. 131 rows and 11 property types — the type
// row having ten-plus chips is precisely what broke the header.
const PROPERTIES = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/properties-snapshot.json'), 'utf8'))
  .map(p => Object.assign({ tenantId: T }, p));

const FIREBASE_STUB = `
window.dashboardFirebase = {
  saveProperty: async () => {}, deleteProperty: async () => {},
  getPropertyNotes: async () => [], savePropertyNote: async () => {}, deletePropertyNote: async () => {},
  getInternalNotes: async () => [], saveInternalNote: async () => {}, deleteInternalNote: async () => {},
  saveChanges: async () => {}, getChanges: async () => [],
  getLeads: async () => [], subscribeToProperty: () => () => {}
};
window.dashboardAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
setTimeout(() => {
  if (window.onDashboardAuthChange) window.onDashboardAuthChange({ email: 'agent.a@example.com' });
  if (window.onPinTenantReady) window.onPinTenantReady('${T}');
  window.applyPropertiesSnapshot(${J(PROPERTIES)});
  window.__ready = true;
}, 0);
`;

const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label + (detail !== undefined ? ' — ' + detail : '')); }
};
const note = (label, detail) => console.log('  ·    ' + label + (detail !== undefined ? ' — ' + detail : ''));

const browser = await chromium.launch();

async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|net::ERR|fonts\.googleapis|cdnjs|maps\.googleapis/.test(t)) return;
    errors.push(`${viewport.width}px console: ${t}`);
  });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'dash.local') return route.abort();
    if (url.pathname === '/dashboard-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_STUB });
    if (url.pathname === '/api/public-config') return route.fulfill({ contentType: 'application/json', body: '{"googleMapsApiKey":""}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://dash.local/dashboard.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(500);
  return page;
}

// ═══════ THE MEASUREMENTS ═══════
// Everything here runs in the page, so it reads computed style and real
// geometry rather than what the stylesheet says it ought to be.
const PROBE = () => {
  const vh = innerHeight, vw = innerWidth;
  const R = s => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
  const nameOf = n => (n.id ? '#' + n.id : (typeof n.className === 'string' && n.className ? '.' + n.className.split(/\s+/)[0] : n.tagName));

  // Contrast, the actual WCAG formula, against the nearest painted ancestor.
  const lum = c => {
    const f = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const rgb = s => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x));
    if (p.length > 3 && p[3] < 0.95) return null;
    return p.slice(0, 3);
  };
  const bgOf = el => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c) return c;
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  const out = { vw, vh, clipped: [], small: [], tiny: [], lowContrast: [], innerScrollers: [], overflowX: 0 };

  // ── 1. What does the agent lose to chrome before the first result? ──
  const hdr = R('#hdr');
  const firstCard = document.querySelector('#pgrid .card') || document.querySelector('#pgrid > *');
  out.headerH = hdr ? Math.round(hdr.height) : null;
  out.headerPct = hdr ? Math.round(hdr.height / vh * 100) : null;
  out.firstResultY = firstCard ? Math.round(firstCard.getBoundingClientRect().top) : null;
  out.firstResultPct = firstCard ? Math.round(firstCard.getBoundingClientRect().top / vh * 100) : null;

  // ── 1b. WHERE the header height goes, so compaction is aimed, not guessed ──
  const hdrEl = document.querySelector('#hdr');
  out.headerRows = hdrEl ? [...hdrEl.children].map(c => {
    const r = c.getBoundingClientRect();
    return { el: nameOf(c), h: Math.round(r.height), visible: r.height > 0 };
  }).filter(x => x.visible) : [];

  // ── 1c. DOES THE PAGE USE THE MONITOR IT IS ON? ──
  // #main was capped at 1480px, so a 2560 screen showed the same four columns
  // as a 1920 one with about 1,100px of empty margin beside them. And because
  // a grid row is as tall as its tallest card with the footer pinned to the
  // bottom, any unclamped line on one card became a hole above the footer on
  // every other card in that row.
  const grid = document.querySelector('#pgrid');
  const cards = grid ? [...grid.querySelectorAll('.card')] : [];
  out.grid = null;
  if (grid && cards.length) {
    const gr = grid.getBoundingClientRect();
    const tops = new Map();
    cards.forEach(c => { const t = Math.round(c.getBoundingClientRect().top); tops.set(t, (tops.get(t) || 0) + 1); });
    const voids = [];
    for (const c of cards.slice(0, 24)) {
      const st = c.querySelector('.card-stats'), ft = c.querySelector('.card-foot');
      if (st && ft) voids.push(Math.round(ft.getBoundingClientRect().top - st.getBoundingClientRect().bottom));
    }
    voids.sort((a, b) => a - b);
    out.grid = {
      perRow: Math.max(...tops.values()),
      cardW: Math.round(cards[0].getBoundingClientRect().width),
      unusedRight: Math.round(vw - gr.right),
      voidMax: voids.length ? voids[voids.length - 1] : 0,
      // Content escaping its own card — a grid item that will not shrink
      // below its content pushes the box beside it past the card edge.
      spill: cards.slice(0, 40).filter(c => {
        const cr = c.getBoundingClientRect();
        return [...c.querySelectorAll('*')].some(x => { const b = x.getBoundingClientRect(); return b.width && b.right > cr.right + 1; });
      }).length
    };
  }

  // ── 2. Clipped controls ──
  // An interactive element whose box escapes a clipping ancestor. This is what
  // made the List / Split / Map row render as half-height letters.
  for (const el of document.querySelectorAll('button, a, input, select, [role=button]')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let n = el.parentElement, bad = null;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      const pr = n.getBoundingClientRect();
      const hidesY = cs.overflowY === 'hidden', scrollsY = /auto|scroll/.test(cs.overflowY);
      const hidesX = cs.overflowX === 'hidden', scrollsX = /auto|scroll/.test(cs.overflowX);
      const outY = r.bottom > pr.bottom + 1.5 || r.top < pr.top - 1.5;
      const outX = r.right > pr.right + 1.5 || r.left < pr.left - 1.5;

      // A container the user CAN scroll is not clipping anything — it is a
      // list. Reaching it ends the walk, because every ancestor above it will
      // also look like it is cutting off row 90 of 131, which is how this
      // check first reported 122 clipped controls in a scrollable map list.
      if ((scrollsY && n.scrollHeight > n.clientHeight + 2) ||
          (scrollsX && n.scrollWidth > n.clientWidth + 2)) break;

      if (outY && (hidesY || scrollsY)) bad = n;
      else if (outX && hidesX) bad = n;
      if (bad) break;
      n = n.parentElement;
    }
    if (bad) out.clipped.push({ el: nameOf(el), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28), by: nameOf(bad) });
  }

  // ── 3. A container inside the header that scrolls vertically ──
  // Two scrollbars, and filters that scroll away from the results they filter.
  for (const n of document.querySelectorAll('#hdr, #hdr *')) {
    const cs = getComputedStyle(n);
    if (/auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) {
      out.innerScrollers.push(nameOf(n) + ' (' + n.scrollHeight + 'px of content in ' + n.clientHeight + 'px)');
    }
  }

  // ── 4. Sideways overflow of the page itself ──
  out.overflowX = Math.max(0, document.documentElement.scrollWidth - vw);

  // ── 5. Targets too small to hit, text too small to read, too faint to see ──
  for (const el of document.querySelectorAll('button, a, input, select, [role=button]')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    // WCAG 2.5.8 exempts a link sitting inline in a sentence — its target is
    // the line of text, and padding it out would break the paragraph. So the
    // minimum applies to button-SHAPED controls: anything laid out as a box,
    // or carrying its own background or border.
    const unpainted = cs.borderStyle === 'none' &&
      /^rgba\(0, 0, 0, 0\)$|transparent/.test(cs.backgroundColor);
    if (cs.display === 'inline' && unpainted) continue;

    // A checkbox or radio inside a <label> is toggled by clicking anywhere on
    // the label, so the label's box IS the target. Measuring the 18px box
    // itself measures the wrong rectangle and would push us to draw a
    // 24px checkbox to satisfy a number.
    const lbl = el.closest('label');
    const box = (lbl && /checkbox|radio/.test(el.type || '')) ? lbl.getBoundingClientRect() : r;

    if (box.height < 30 || box.width < 24) out.small.push({ t: ((el.textContent || '').trim() || nameOf(el)).slice(0, 24), w: Math.round(box.width), h: Math.round(box.height) });
  }
  for (const el of document.querySelectorAll('#main *, #hdr *')) {
    if (el.children.length || (el.textContent || '').trim().length < 3) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const t = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 26);
    if (fs < 11.5) out.tiny.push({ t, px: fs });
    const fg = rgb(cs.color);
    if (fg) {
      const cr = ratio(fg, bgOf(el));
      const big = fs >= 18.66 || (fs >= 14 && parseInt(cs.fontWeight, 10) >= 700);
      if (cr < (big ? 3 : 4.5)) out.lowContrast.push({ t, px: Math.round(fs), ratio: Math.round(cr * 100) / 100 });
    }
  }

  const dedupe = (a, k) => { const s = new Set(); return a.filter(x => { const v = k(x); if (s.has(v)) return false; s.add(v); return true; }); };
  out.tiny = dedupe(out.tiny, x => x.px + '|' + x.t);
  out.lowContrast = dedupe(out.lowContrast, x => x.ratio + '|' + x.t).sort((a, b) => a.ratio - b.ratio);
  out.small = dedupe(out.small, x => x.t + x.w + x.h);
  out.clipped = dedupe(out.clipped, x => x.el + x.text);
  return out;
};

// The screens this is actually used on, plus the two that break layouts:
// the smallest phone still in service, and a phone turned sideways, where
// the viewport is shorter than any header wants to be.
// Measured with the map open. The list probe above runs on the card grid and
// would never have seen any of this.
const MAP_PROBE = () => {
  const vw = innerWidth, vh = innerHeight;
  const nameOf = n => (n.id ? '#' + n.id : (typeof n.className === 'string' && n.className ? '.' + n.className.split(/\s+/)[0] : n.tagName));
  const shell = document.querySelector('#mapShell');
  const r = shell ? shell.getBoundingClientRect() : null;
  const list = document.querySelector('#mapList');
  const lr = list ? list.getBoundingClientRect() : null;
  const out = {
    shellVisible: !!(shell && !shell.hidden && getComputedStyle(shell).display !== 'none' && r.height > 0),
    shellH: r ? Math.round(r.height) : 0,
    shellBottomOver: r ? Math.round(Math.max(0, r.bottom - vh)) : 0,
    vh,
    overflowX: Math.max(0, document.documentElement.scrollWidth - vw),
    // Not "does the CSS say auto" — does it ACTUALLY scroll, and does it fit
    // inside the shell. A list declaring overflow-y:auto while laid out at
    // its full 8929px inside a 570px shell satisfies the first and fails the
    // second, and showed three of 130 properties.
    listScrolls: !!(list && /auto|scroll/.test(getComputedStyle(list).overflowY)
      && list.scrollHeight > list.clientHeight + 2),
    listFitsShell: !!(list && r && lr.height <= r.height + 2),
    listH: lr ? Math.round(lr.height) : 0,
    // "Hidden" means the agent can neither see it nor tab into it — which
    // covers display:none, visibility:hidden, and a zero-width track. Testing
    // only for display:none was testing one implementation of hiding rather
    // than the thing that matters.
    listHidden: !!(list && (() => {
      const cs = getComputedStyle(list);
      return cs.display === 'none' || cs.visibility === 'hidden' || !lr.height || !lr.width;
    })()),
    canvasW: 0, canvasH: 0, paneW: 0, paneH: 0,
    clipped: []
  };
  for (const el of document.querySelectorAll('#mapShell button, #mapShell input, #mapShell select, #mapModeSwitch button')) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    let n = el.parentElement;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      const pr = n.getBoundingClientRect();
      const scrolls = /auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2;
      if (scrolls) break;
      if (cs.overflowY === 'hidden' && (b.bottom > pr.bottom + 1.5 || b.top < pr.top - 1.5)) {
        out.clipped.push({ text: (el.textContent || nameOf(el)).trim().slice(0, 24), by: nameOf(n) });
        break;
      }
      n = n.parentElement;
    }
  }
  // The map's own canvas, and the pane it is meant to fill. A map that is
  // laid out at the width it had in the PREVIOUS mode leaves the rest of the
  // pane grey, which is what "map view is not working" looks like.
  const pane = document.querySelector('#mapPane') || document.querySelector('#mapCanvasHost');
  // #mapCanvasHost, not .mv-canvas: the canvas is only created once a key
  // loads a real map, and this harness deliberately runs without one. The
  // host is what must have size either way — a map cannot be drawn into a
  // box of zero width whether or not the key is present.
  const canvas = document.querySelector('#mapCanvasHost');
  if (pane) { const pr2 = pane.getBoundingClientRect(); out.paneW = Math.round(pr2.width); out.paneH = Math.round(pr2.height); }
  if (canvas) { const cr = canvas.getBoundingClientRect(); out.canvasW = Math.round(cr.width); out.canvasH = Math.round(cr.height); }

  return out;
};

const VIEWS = [
  { name: 'phone-360', viewport: { width: 360, height: 740 } },
  { name: 'phone-390', viewport: { width: 390, height: 844 } },
  { name: 'phone-landscape-844', viewport: { width: 844, height: 390 }, shortScreen: true },
  { name: 'tablet-768', viewport: { width: 768, height: 1024 } },
  { name: 'tablet-1024', viewport: { width: 1024, height: 768 } },
  { name: 'laptop-1280', viewport: { width: 1280, height: 800 } },
  { name: 'laptop-1366', viewport: { width: 1366, height: 768 } },
  { name: 'laptop-1440', viewport: { width: 1440, height: 900 } },
  { name: 'laptop-1536', viewport: { width: 1536, height: 864 } },
  { name: 'desktop-1920', viewport: { width: 1920, height: 950 } },
  { name: 'desktop-2560', viewport: { width: 2560, height: 1329 } }
];

const report = {};
for (const v of VIEWS) {
  console.log('');
  console.log('─'.repeat(66));
  console.log('  ' + v.name + '   ' + v.viewport.width + '×' + v.viewport.height);
  console.log('─'.repeat(66));
  const page = await open(v.viewport);
  const m = await page.evaluate(PROBE);
  report[v.name] = m;

  note('header height', m.headerH + 'px = ' + m.headerPct + '% of the viewport');
  note('first result at', m.firstResultY + 'px = ' + m.firstResultPct + '% down the page');
  note('header spends it on', (m.headerRows || []).map(r => r.el + ' ' + r.h + 'px').join(' + '));

  // The owner's complaint, as a number. A header over a third of the screen
  // IS "half the page for title and filters".
  // A 390px-tall viewport cannot give a search box, filters and a view
  // switch the same share as a 950px one, so the budget is a share of the
  // screen OR a hard pixel ceiling — whichever is kinder. What must not
  // happen at any height is the header eating the results entirely.
  const headerBudget = v.shortScreen ? 55 : 32;
  ok('the header leaves most of the screen for properties',
    m.headerPct !== null && (m.headerPct <= headerBudget || m.headerH <= 260),
    m.headerPct + '% of the viewport (' + m.headerH + 'px)');
  ok('a result is visible without scrolling', m.firstResultY !== null && m.firstResultY < m.vh - 80,
    'first card starts at ' + m.firstResultY + 'px of ' + m.vh);
  ok('no control is clipped by its container', m.clipped.length === 0,
    m.clipped.length + ': ' + m.clipped.slice(0, 4).map(c => '"' + c.text + '" cut by ' + c.by).join('; '));
  ok('the header does not scroll inside itself', m.innerScrollers.length === 0, m.innerScrollers.join('; '));
  ok('the page does not overflow sideways', m.overflowX === 0, m.overflowX + 'px');
  ok('every control is big enough to hit', m.small.length === 0,
    m.small.length + ': ' + m.small.slice(0, 5).map(s => '"' + s.t + '" ' + s.w + '×' + s.h).join(', '));
  ok('no text below 11.5px', m.tiny.length === 0,
    m.tiny.slice(0, 6).map(t => t.px + 'px "' + t.t + '"').join(', '));
  ok('all text meets WCAG AA contrast', m.lowContrast.length === 0,
    m.lowContrast.length + ' failing, worst: ' + m.lowContrast.slice(0, 4).map(c => c.ratio + ':1 "' + c.t + '"').join(', '));

  if (m.grid) {
    note('property grid', m.grid.perRow + ' per row, cards ' + m.grid.cardW + 'px, '
      + m.grid.unusedRight + 'px unused at the right, worst card gap ' + m.grid.voidMax + 'px');
    // A wide monitor should show more properties, not the same four with a
    // margin either side.
    ok('the grid uses the width of the screen', m.grid.unusedRight <= 140,
      m.grid.unusedRight + 'px of the viewport is unused beside the grid');
    ok('nothing spills out of a card', m.grid.spill === 0, m.grid.spill + ' card(s)');
    ok('no card carries a large empty gap', m.grid.voidMax <= 80,
      m.grid.voidMax + 'px between the stats and the footer');
  }

  await page.screenshot({ path: join(OUT, v.name + '.png'), fullPage: false });

  // ── THE MAP VIEW, at this same size ──
  // Everything above tested the list. The map is half the feature and the
  // audit had never opened it, which is how a 420px empty shell shipped.
  const hasMap = await page.$('#mapModeSwitch');
  if (hasMap) {
    // BOTH map modes. This said `width <= 720 ? 2 : 2`, which is Split every
    // time — map-only mode had never once been opened by a test, which is
    // how it shipped broken while Split worked.
    // By NAME, not by position: the narrow switch renders only List and Map,
    // so nth-child(3) does not exist on a phone.
    for (const modeName of ['split', 'map-only']) {
      const want = modeName === 'split' ? 'split' : 'map';
      const btn = await page.$(`#mapModeSwitch [data-view="${want}"]`);
      if (!btn) continue;               // Split genuinely does not exist when narrow
      await btn.click();
      await page.waitForTimeout(750);
      const mm = await page.evaluate(MAP_PROBE);
      report[v.name] = report[v.name] || {};
      report[v.name]['map_' + modeName] = mm;
      const tag = ' [' + modeName + ']';
      ok('the map shell is on screen' + tag, mm.shellVisible && mm.shellH > 200,
        JSON.stringify({ visible: mm.shellVisible, h: mm.shellH }));
      ok('the map has a box with real width to draw into' + tag,
        mm.canvasW > 120 && mm.canvasH > 120,
        'canvas host ' + mm.canvasW + 'x' + mm.canvasH + ' in a pane of ' + mm.paneW + 'x' + mm.paneH);
      ok('the map pane is as wide as the shell allows' + tag,
        mm.paneW > 120, 'pane ' + mm.paneW + 'px');
      ok('the map fits the screen' + tag, mm.shellH <= mm.vh + 2,
        'a ' + mm.shellH + 'px map on a ' + mm.vh + 'px screen');
      ok('no sideways overflow' + tag, mm.overflowX === 0, mm.overflowX + 'px');
      ok('no map control is clipped' + tag, mm.clipped.length === 0,
        mm.clipped.slice(0, 3).map(c => '"' + c.text + '" by ' + c.by).join('; '));
      if (modeName === 'split') {
        ok('the list beside the map really scrolls' + tag,
          mm.listScrolls || mm.listHidden, JSON.stringify({ scrolls: mm.listScrolls, hidden: mm.listHidden }));
        ok('...and sits inside the shell' + tag,
          mm.listFitsShell || mm.listHidden, 'list ' + mm.listH + 'px in a ' + mm.shellH + 'px shell');
      } else {
        ok('map-only really hides the list' + tag, mm.listHidden || !mm.listH,
          'list is ' + mm.listH + 'px tall');
      }
      await page.screenshot({ path: join(OUT, v.name + '-' + modeName + '.png'), fullPage: false });
    }
    {
      const mm = report[v.name].map_split;
      void mm;
    }
    // Back to the list for the scrolled shot below.
    await page.click('#mapModeSwitch .mv-mode:nth-child(1)');
    await page.waitForTimeout(350);
  }
  // Scrolled too, because "it is fixed, not moving when scrolled down" was
  // half of what the owner reported.
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, v.name + '-scrolled.png'), fullPage: false });
  await page.context().close();
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();

console.log('');
console.log('─'.repeat(66));
console.log('screenshots + report.json → ' + OUT);
if (errors.length) {
  console.log('');
  console.log(errors.length + ' problem(s):');
  errors.forEach(e => console.log('  · ' + e));
  process.exit(1);
}
console.log('All good.');
