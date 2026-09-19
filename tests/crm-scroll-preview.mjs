// Measures real scroll geometry in Chromium for the CRM list view and the
// other horizontal scrollers. Proves the fix rather than asserting it.
//   node scroll-check.mjs <out-dir>
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'scroll-out';
mkdirSync(OUT, { recursive: true });
const NOW = Date.now(), D = 86400000;
const T = 't_3pinrealty';

const STAGES = [
  { id:'new', key:'new', name:'New', color:'#1D4ED8', order:0 },
  { id:'options_shared', key:'options_shared', name:'Options sent', color:'#6D28D9', order:1 },
  { id:'negotiation', key:'negotiation', name:'Negotiating', color:'#FE8D00', order:2 },
  { id:'won', key:'won', name:'Won', color:'#137A3B', order:3 },
];
const LEADS = Array.from({ length: 40 }, (_, i) => ({
  id: 'L' + i, tenantId: T,
  name: ['Rajesh Kumar','Priya Sundaram','Arun Prakash','Meena Ramanathan','Vignesh Iyer'][i % 5] + ' ' + i,
  phone: '98400' + String(10000 + i), email: `lead${i}@example.com`,
  channel: ['call','whatsapp','instagram'][i % 3],
  source: ['manual','tailortalk','meta'][i % 3],
  enquiryType: 'Property Enquiry',
  propertyInterest: 'A rather long property interest string, Nanganallur ' + i,
  stageId: STAGES[i % 4].id,
  updatedBy: 'someone.with.a.long.address@example.com',
  followUpAt: NOW + (i % 7) * D,
  createdAt: NOW - 10 * D, updatedAt: NOW - (i % 5) * D,
  stageChangedAt: NOW - (i % 9) * D,
  // Every other lead is a TailorTalk chat, so the conversation pane has
  // something to show and the board's temperature chips are exercised.
  ...(i % 2 === 0 ? { tt: {
    id: 'tt' + i, category: 'sales', integration: 'whatsapp',
    status: ['hot', 'warm', 'cold'][i % 3],
    lastMessageAt: NOW - (i % 6) * 3600000,
    lastReplyAt: NOW - (i % 6) * 3600000 + 60000,
    syncedAt: NOW - 3600000,
    // A handful have a site visit on the books, for the visit sorts.
    ...(i % 6 === 0 ? { signals: { site_visit: { at: NOW - (i + 1) * D, quote: 'Can we see it this weekend?' } } } : {}),
  } } : {}),
  ...(i % 6 === 0 ? { ai: { visit: { status: 'scheduled', at: NOW + (i % 5 + 1) * D, property: 'VLCA00' + i } } } : {}),
}));

const STUB = `
const LEADS = ${JSON.stringify(LEADS)};
const STAGES = ${JSON.stringify(STAGES)};
window.__saved = [];
window.crmFirebase = {
  saveLead: async l => { window.__saved.push(l); },
  deleteLead: async()=>{}, getLeadNotes: async()=>[], getLeadHistory: async()=>[],
  saveNote: async()=>{}, deleteNoteDoc: async()=>{}, saveHistory: async()=>{}, savePipeline: async()=>{},
  getBotConfig: async()=>null, saveBotConfig: async()=>{}, saveEnquiryTypes: async()=>{}, saveProperties: async()=>{},
  saveFollowupDigestSettings: async()=>{}, saveDashboardEmailSettings: async()=>{},
  releaseLeadField: async()=>{}, getLeadTailorTalk: async()=>null,
  updateLeadAi: async()=>{}, saveAutomationSettings: async()=>{}
};
window.crmAuth = { login: async()=>{}, logout: async()=>{}, getIdToken: async()=>'x', getTenantId: ()=>'t_3pinrealty' };
window.onCrmAuthChange({ email: 'agent.a@example.com' });
window.applyPipelineSnapshot(STAGES);
window.applyEnquiryTypesSnapshot(['Property Enquiry','Seller Listing']);
window.applyLeadsSnapshot(JSON.parse(JSON.stringify(LEADS)));
window.__ready = true;
`;

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.jpg':'image/jpeg', '.json':'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

async function openPage(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch(e){} });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  page.on('console', m => { if (m.type()==='error' && !/Failed to load resource|net::ERR/.test(m.text())) { console.log('  CONSOLE ' + m.text()); errors.push('console: ' + m.text()); } });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'crm.local') return route.abort();
    if (url.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType:'text/javascript', body: STUB });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType:'application/json', body:'{"ok":true}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status:404, body:'' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://crm.local/crm.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  return page;
}

const geom = page => page.evaluate(() => {
  const sc = document.querySelector('#listView .list-view');
  const box = document.querySelector('#listView .lv-scroll');
  const th = document.querySelector('#listView th.lv-name');
  if (!sc) return null;
  const cs = getComputedStyle(sc);
  return {
    overflowX: cs.overflowX, overflowY: cs.overflowY,
    scrollWidth: sc.scrollWidth, clientWidth: sc.clientWidth,
    scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight,
    scrollLeft: sc.scrollLeft,
    boxCls: box ? box.className : null,
    nameSticky: th ? getComputedStyle(th).position : null,
    nameLeft: th ? getComputedStyle(th).left : null,
    hdrH: getComputedStyle(document.documentElement).getPropertyValue('--hdr-h').trim(),
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

// ── The lead panel split, across the screens this actually runs on ──
// 2560 = external monitor, 1440 = laptop, 1280 = small laptop, 900/390 = the
// two sides of the split breakpoint.
async function checkSplit(vp) {
  console.log(`\n── split @ ${vp.width}×${vp.height} ──`);
  const page = await openPage(vp);
  const wide = vp.width >= 1100;
  await page.evaluate(() => openDetail('L2'));      // L2 is a TailorTalk lead
  await page.waitForTimeout(500);

  const g = await page.evaluate(() => {
    const split = document.getElementById('dpSplit');
    const body = document.querySelector('#dp .dp-body');
    const side = document.getElementById('dpSide');
    const rz = document.getElementById('dpResizer');
    const r = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
    return {
      cls: split.className,
      isSplit: split.classList.contains('split'), isSheet: split.classList.contains('sheet'),
      body: r(body), side: r(side), rz: r(rz),
      sideShown: getComputedStyle(side).display !== 'none',
      rzShown: getComputedStyle(rz).display !== 'none',
      bodyScrolls: body.scrollHeight > body.clientHeight + 4,
      btnHidden: document.getElementById('dpConvBtn').hidden,
      docX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && e.getBoundingClientRect().width > 0)
        .slice(0, 6).map(e => `${e.tagName.toLowerCase()}.${(e.className||'').toString().split(' ')[0]}@${Math.round(e.getBoundingClientRect().right)}`),
    };
  });
  console.log('   ', JSON.stringify(g));
  if (g.wide.length) console.log('    OVERFLOWING:', JSON.stringify(g.wide));
  ok('the Conversation toggle is offered for a chat lead', !g.btnHidden, String(g.btnHidden));

  if (wide) {
    ok('wide screen splits into two panes', g.isSplit, g.cls);
    ok('the conversation sits beside the lead, not over it', g.sideShown && g.side.x > g.body.x, JSON.stringify({ body: g.body, side: g.side }));
    ok('both panes have real width', g.body.w > 300 && g.side.w > 250, JSON.stringify({ b: g.body.w, s: g.side.w }));
    ok('the divider is there to grab', g.rzShown && g.rz.w >= 8, JSON.stringify(g.rz));

    // Drag it and check both panes actually respond.
    const dragged = await page.evaluate(async () => {
      const rz = document.getElementById('dpResizer');
      const split = document.getElementById('dpSplit');
      const side = document.getElementById('dpSide');
      const before = side.getBoundingClientRect().width;
      const r = rz.getBoundingClientRect();
      rz.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 5 }));
      dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left - 160 }));
      dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise(r2 => setTimeout(r2, 120));
      return { before: Math.round(before), after: Math.round(side.getBoundingClientRect().width), stored: localStorage.getItem('crmDpSideW') };
    });
    ok('dragging the divider widens the conversation', dragged.after > dragged.before + 40, JSON.stringify(dragged));
    ok('the dragged width is remembered', !!dragged.stored, String(dragged.stored));

    const clamped = await page.evaluate(async () => {
      const rz = document.getElementById('dpResizer');
      const side = document.getElementById('dpSide'), body = document.querySelector('#dp .dp-body');
      const r = rz.getBoundingClientRect();
      rz.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 5 }));
      dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: -900 }));   // yank it off-screen
      dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise(r2 => setTimeout(r2, 120));
      return { body: Math.round(body.getBoundingClientRect().width), side: Math.round(side.getBoundingClientRect().width) };
    });
    ok('neither pane can be dragged away to nothing', clamped.body > 200 && clamped.side > 200, JSON.stringify(clamped));

    const kbd = await page.evaluate(async () => {
      const rz = document.getElementById('dpResizer');
      rz.focus();
      const before = rz.getAttribute('aria-valuenow');
      rz.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      return { before, after: rz.getAttribute('aria-valuenow'), focused: document.activeElement === rz };
    });
    ok('the divider is keyboard-adjustable', kbd.focused && kbd.after === '34', JSON.stringify(kbd));

    const dedup = await page.evaluate(() => ({
      inlineTabs: [...document.querySelectorAll('#dpTt .tt-tab')].map(t => t.textContent.trim()),
      paneHasChat: !!document.querySelector('#dpSideBody'),
    }));
    ok('the chat is not also duplicated under a tab', !dedup.inlineTabs.some(t => /Conversation/.test(t)), JSON.stringify(dedup.inlineTabs));
  } else {
    ok('narrow screen does not split', !g.isSplit, g.cls);
    ok('the conversation is closed until asked for', !g.sideShown, String(g.sideShown));
    const sheet = await page.evaluate(async () => {
      document.getElementById('dpConvBtn').click();
      await new Promise(r => setTimeout(r, 250));
      const side = document.getElementById('dpSide'), body = document.querySelector('#dp .dp-body');
      const s = side.getBoundingClientRect(), b = body.getBoundingClientRect();
      return {
        cls: document.getElementById('dpSplit').className,
        isSheet: document.getElementById('dpSplit').classList.contains('sheet'),
        covers: Math.abs(s.width - b.width) < 3 && s.width > 0,
        w: Math.round(s.width), vw: innerWidth,
        pressed: document.getElementById('dpConvBtn').getAttribute('aria-pressed'),
        tabs: [...document.querySelectorAll('#dpTt .tt-tab')].map(t => t.textContent.trim()),
      };
    });
    ok('tapping Conversation opens it as a sheet', sheet.isSheet && sheet.pressed === 'true', JSON.stringify(sheet));
    ok('the sheet takes the screen rather than sharing it', sheet.covers && sheet.w > sheet.vw * 0.8, JSON.stringify(sheet));
    const closed = await page.evaluate(async () => {
      document.getElementById('dpConvBtn').click();
      await new Promise(r => setTimeout(r, 250));
      return getComputedStyle(document.getElementById('dpSide')).display;
    });
    ok('tapping it again closes the sheet', closed === 'none', closed);
  }
  ok('the lead panel never scrolls the page sideways', g.docX <= 1, String(g.docX));
  await page.screenshot({ path: join(OUT, `split-${vp.width}.png`) });
  await page.close();
}

// ── Wide screens must use the width they are given ──
async function checkWidth(vp) {
  const page = await openPage(vp);
  await page.evaluate(() => toggleView('dashboard'));
  await page.waitForTimeout(700);
  const w = await page.evaluate(() => {
    const wrap = document.querySelector('.dash-wrap');
    const stats = document.querySelector('.dash-stats');
    return {
      wrap: wrap ? Math.round(wrap.getBoundingClientRect().width) : 0,
      cols: stats ? getComputedStyle(stats).gridTemplateColumns.split(' ').length : 0,
      vw: innerWidth,
    };
  });
  const used = w.wrap / w.vw;
  console.log(`    ${vp.width}px → dashboard ${w.wrap}px (${Math.round(used * 100)}% of the screen), ${w.cols} stat columns`);
  // Either it is using the screen, or it has hit the deliberate upper cap —
  // past ~2400px more width stops being more information.
  ok(`${vp.width}px: the dashboard uses the screen`, used > 0.9 || w.wrap >= 2380, `${w.wrap}px = ${Math.round(used * 100)}%`);
  ok(`${vp.width}px: more screen means more stat tiles per row`, w.cols >= (vp.width >= 1900 ? 6 : 4), String(w.cols));
  await page.close();
}

for (const vp of [{ width:2560, height:1440 }, { width:1920, height:1080 }, { width:1440, height:900 }, { width:1280, height:800 }, { width:900, height:1000 }, { width:390, height:844 }]) {
  await checkSplit(vp);
}
console.log('\n── wide-screen space ──');
for (const vp of [{ width:2560, height:1440 }, { width:1920, height:1080 }, { width:1440, height:900 }]) {
  await checkWidth(vp);
}

for (const vp of [{ width:1440, height:900 }, { width:1024, height:768 }, { width:390, height:844 }]) {
  console.log(`\n── ${vp.width}×${vp.height} ──`);
  const page = await openPage(vp);
  await page.evaluate(() => toggleView('list'));
  await page.waitForTimeout(600);

  const g = await geom(page);
  console.log('   ', JSON.stringify(g));
  ok('list view rendered', !!g);
  const heads = await page.evaluate(() => [...document.querySelectorAll('#listView thead th')].map(th => {
    const l = th.querySelector('.lv-th-label');
    return { cls: th.className, label: l ? l.textContent.replace(/\s+/g, ' ').trim() : '(none)', w: l ? Math.round(l.getBoundingClientRect().width) : 0 };
  }));
  console.log('    heads:', JSON.stringify(heads));
  ok('every column header renders its label', heads.slice(1).every(h => h.label !== '(none)' && h.w > 8), JSON.stringify(heads.filter(h => h.w <= 8)));
  ok('horizontal scrolling is possible', g.scrollWidth > g.clientWidth + 4, `scrollWidth ${g.scrollWidth} vs clientWidth ${g.clientWidth}`);
  ok('overflow-x is not hidden', g.overflowX !== 'hidden', g.overflowX);
  ok('--hdr-h was measured', /^\d+px$/.test(g.hdrH) && parseInt(g.hdrH) > 40, g.hdrH);
  ok('table has its own vertical scrollport (sticky header works)', g.scrollHeight > g.clientHeight + 4, `${g.scrollHeight} vs ${g.clientHeight}`);
  ok('name column is frozen', g.nameSticky === 'sticky' && parseFloat(g.nameLeft) > 10, `${g.nameSticky} @ ${g.nameLeft}`);
  ok('scroll affordance is on while content is hidden right', /has-more-x/.test(g.boxCls) && /can-scroll-x/.test(g.boxCls), g.boxCls);
  ok('page itself does not scroll sideways', g.docOverflowX <= 1, String(g.docOverflowX));

  // Actually scroll it to the far right and re-measure.
  await page.evaluate(() => { const sc = document.querySelector('#listView .list-view'); sc.scrollLeft = sc.scrollWidth; });
  await page.waitForTimeout(250);
  const g2 = await geom(page);
  // Assert against this viewport's actual overflow, not a fixed number — on a
  // wide screen only ~100px is hidden and a hardcoded threshold fails there.
  ok('it really scrolls', g2.scrollLeft >= (g.scrollWidth - g.clientWidth) - 1, `${g2.scrollLeft} of ${g.scrollWidth - g.clientWidth}`);
  ok('fade turns off at the right edge', !/has-more-x/.test(g2.boxCls), g2.boxCls);
  ok('shadow appears under the frozen column', /is-scrolled-x/.test(g2.boxCls), g2.boxCls);
  const nameVisible = await page.evaluate(() => {
    const td = document.querySelector('#listView tbody td.lv-name');
    const sc = document.querySelector('#listView .list-view');
    if (!td) return null;
    const a = td.getBoundingClientRect(), b = sc.getBoundingClientRect();
    return { left: Math.round(a.left - b.left), text: td.textContent.trim() };
  });
  ok('the lead name is still on screen when scrolled right', nameVisible && nameVisible.left >= 0 && nameVisible.left < 80, JSON.stringify(nameVisible));
  await page.screenshot({ path: join(OUT, `list-${vp.width}-right.png`), fullPage: false });

  // Sticky header: scroll the table down, header must stay put.
  await page.evaluate(() => { const sc = document.querySelector('#listView .list-view'); sc.scrollLeft = 0; sc.scrollTop = 400; });
  await page.waitForTimeout(250);
  const stick = await page.evaluate(() => {
    const sc = document.querySelector('#listView .list-view');
    const th = document.querySelector('#listView thead th.lv-name');
    const a = th.getBoundingClientRect(), b = sc.getBoundingClientRect();
    return { delta: Math.round(a.top - b.top), bg: getComputedStyle(th).backgroundColor };
  });
  ok('header stays pinned while the table scrolls', Math.abs(stick.delta) <= 2, JSON.stringify(stick));
  ok('pinned header is opaque', !/rgba\(0, 0, 0, 0\)/.test(stick.bg), stick.bg);
  await page.screenshot({ path: join(OUT, `list-${vp.width}-scrolled.png`) });

  // Column filter dropdown must not be clipped by the scroll container.
  await page.evaluate(() => { const sc = document.querySelector('#listView .list-view'); sc.scrollTop = 0; sc.scrollLeft = sc.scrollWidth; });
  await page.waitForTimeout(200);
  const popped = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#listView .lv-filter-btn')];
    const b = btns[btns.length - 1];
    if (!b) return null;
    b.click();
    return true;
  });
  await page.waitForTimeout(350);
  const pop = await page.evaluate(() => {
    const p = document.querySelector('#listView .lv-filter-pop');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { pos: getComputedStyle(p).position, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight };
  });
  ok('filter dropdown opens', !!pop, String(popped));
  if (pop) {
    ok('…and is fully inside the viewport', pop.left >= 0 && pop.right <= pop.w + 1 && pop.top >= 0 && pop.bottom <= pop.h + 1, JSON.stringify(pop));
  }
  await page.screenshot({ path: join(OUT, `list-${vp.width}-filter.png`) });

  // Other horizontal scrollers.
  await page.evaluate(() => toggleView('kanban'));
  await page.waitForTimeout(400);
  const others = await page.evaluate(() => {
    const out = {};
    for (const sel of ['.kanban', '.lf-bar']) {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; continue; }
      const cs = getComputedStyle(el);
      out[sel] = { sw: el.scrollWidth, cw: el.clientWidth, ox: cs.overflowX, ob: cs.overscrollBehaviorX };
    }
    out.doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return out;
  });
  console.log('    others:', JSON.stringify(others));
  ok('board scrolls sideways without the page doing so', others.doc <= 1, String(others.doc));
  ok('board contains its horizontal overscroll', others['.kanban'].ob === 'contain', others['.kanban'].ob);
  await page.screenshot({ path: join(OUT, `board-${vp.width}.png`) });

  // ── Kanban column headers must actually stick ──
  const kstick = await page.evaluate(() => {
    const kb = document.querySelector('.kanban');
    const hdr = document.querySelector('.kcol-hdr');
    if (!kb || !hdr) return null;
    const scrollable = kb.scrollHeight - kb.clientHeight;
    kb.scrollTop = 300;
    const a = hdr.getBoundingClientRect(), b = kb.getBoundingClientRect();
    return { scrollable, delta: Math.round(a.top - b.top), top: kb.scrollTop };
  });
  ok('board has its own vertical scrollport', kstick && kstick.scrollable > 4, JSON.stringify(kstick));
  ok('column header stays pinned while its column scrolls', kstick && Math.abs(kstick.delta) <= 2, JSON.stringify(kstick));

  // ── Per-column sort ──
  const sortUi = await page.evaluate(() => {
    const btn = document.querySelector('.kcol-sort-btn');
    if (!btn) return null;
    btn.click();
    const opts = [...document.querySelectorAll('.kcol-sort-opt')].map(o => o.textContent.trim());
    return { opts, labelled: !!btn.getAttribute('aria-label') };
  });
  ok('each column has a sort control', !!sortUi, 'no .kcol-sort-btn');
  ok('sort menu offers the board questions',
    sortUi && ['Most urgent', 'Recently moved', 'Recent message', 'Visit time', 'Visit asked', 'Follow-up due']
      .every(l => sortUi.opts.includes(l)), JSON.stringify(sortUi && sortUi.opts));

  const byName = await page.evaluate(() => {
    const id = stages[0].id;
    setBoardSort(id, 'name');
    const col = [...document.querySelectorAll('.kcol')][0];
    const names = [...col.querySelectorAll('.lcard-name')].map(n => n.textContent.trim());
    return { names, tag: !!col.querySelector('.kcol-sort-tag'), meta: !!col.querySelector('.lcard-sortmeta'), persisted: localStorage.getItem('crmBoardSort') };
  });
  const asc = [...byName.names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  ok('sorting a column by name really reorders it', JSON.stringify(byName.names) === JSON.stringify(asc), JSON.stringify(byName.names.slice(0, 4)));
  ok('the active sort is named on the column', byName.tag, String(byName.tag));
  ok('the choice is remembered', /name/.test(byName.persisted || ''), byName.persisted);

  const byFollowup = await page.evaluate(() => {
    const id = stages[0].id;
    setBoardSort(id, 'followup');
    const col = [...document.querySelectorAll('.kcol')][0];
    return {
      meta: [...col.querySelectorAll('.lcard-sortmeta')].map(m => m.textContent.trim()).slice(0, 3),
      order: [...col.querySelectorAll('.lcard')].map(c => {
        const id = c.dataset.lead; const l = leads.find(x => x.id === id);
        return l && l.followUpAt ? l.followUpAt : Infinity;
      }),
    };
  });
  ok('sorting by follow-up shows the date it sorted on', byFollowup.meta.length > 0 && /📅/.test(byFollowup.meta[0]), JSON.stringify(byFollowup.meta));
  ok('follow-ups come out soonest first', byFollowup.order.every((v, i, a) => i === 0 || a[i - 1] <= v), JSON.stringify(byFollowup.order.slice(0, 4)));
  await page.evaluate(() => resetAllBoardSorts());

  // ── Colour discipline: red only where it is earned ──
  const colour = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.lcard')];
    const red = [];
    cards.forEach(c => {
      const b = getComputedStyle(c).borderLeftColor;
      const w = parseFloat(getComputedStyle(c).borderLeftWidth);
      if (w >= 2.5) red.push({ id: c.dataset.lead, overdue: c.classList.contains('is-overdue'), b });
    });
    return {
      total: cards.length,
      railed: red.length,
      allEarned: red.every(r => r.overdue),
      agreesWithFilter: red.length === cards.filter(c => {
        const l = leads.find(x => x.id === c.dataset.lead);
        return l && isOverdueUi(l);
      }).length,
      staleClasses: cards.filter(c => /sev-(critical|high|medium|low)/.test(c.className)).length,
    };
  });
  console.log('    colour:', JSON.stringify(colour));
  ok('only overdue cards carry a rail', colour.allEarned, JSON.stringify(colour));
  ok('the rail agrees with the Overdue filter exactly', colour.agreesWithFilter, JSON.stringify(colour));
  ok('the old severity classes are gone', colour.staleClasses === 0, String(colour.staleClasses));
  ok('the rail is the exception, not the rule', colour.railed < colour.total, `${colour.railed}/${colour.total}`);

  // ── Keyboard: move a card between columns without a mouse ──
  const moved = await page.evaluate(() => {
    const card = document.querySelector('.lcard');
    const id = card.dataset.lead;
    const before = leads.find(l => l.id === id).stageId;
    card.focus();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
    const after = leads.find(l => l.id === id).stageId;
    return { before, after, refocused: document.activeElement && document.activeElement.dataset.lead === id };
  });
  ok('Alt+→ moves a card to the next column', moved.before !== moved.after, JSON.stringify(moved));
  ok('focus follows the card it moved', moved.refocused, String(moved.refocused));

  // ── Toolbars and tabs keep the promise their role makes ──
  const roving = await page.evaluate(async () => {
    const bar = document.getElementById('leadFilterBar');
    const items = [...bar.querySelectorAll('button')].filter(b => b.offsetParent !== null);
    items[0].focus();
    const startedOn = document.activeElement === items[0];
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    const movedRight = document.activeElement === items[1];
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    const atEnd = document.activeElement === items[items.length - 1];
    const tabStops = items.filter(b => b.tabIndex === 0).length;
    return { startedOn, movedRight, atEnd, tabStops, n: items.length };
  });
  ok('arrow keys move along a toolbar', roving.startedOn && roving.movedRight, JSON.stringify(roving));
  ok('End jumps to the last item', roving.atEnd, JSON.stringify(roving));
  ok('the toolbar is one tab stop, not one per chip', roving.tabStops === 1, `${roving.tabStops} of ${roving.n}`);

  // ── Modal: reachable header/footer, body scroll lock, Escape, focus ──
  const beforeFocus = await page.evaluate(() => {
    document.querySelector('.addl-btn').focus();
    return document.activeElement.className;
  });
  await page.evaluate(() => openAddLeadModal());
  await page.waitForTimeout(350);
  const modal = await page.evaluate(() => {
    const ov = document.getElementById('lModal');
    const box = ov.querySelector('.modal-box');
    const r = box.getBoundingClientRect();
    return {
      role: box.getAttribute('role'), modal: box.getAttribute('aria-modal'),
      labelled: box.getAttribute('aria-labelledby'),
      topVisible: r.top >= -1, bottomVisible: r.bottom <= innerHeight + 1,
      bodyLocked: document.body.classList.contains('layer-open'),
      bodyOverflow: getComputedStyle(document.body).overflow,
      focusInside: ov.contains(document.activeElement),
      appInert: document.getElementById('appRoot').hasAttribute('inert'),
    };
  });
  ok('modal is a labelled dialog', modal.role === 'dialog' && modal.modal === 'true' && !!modal.labelled, JSON.stringify(modal));
  ok('modal header and footer are both on screen', modal.topVisible && modal.bottomVisible, JSON.stringify(modal));
  ok('page behind the modal is scroll-locked', modal.bodyLocked && modal.bodyOverflow === 'hidden', modal.bodyOverflow);
  ok('focus moves into the modal', modal.focusInside, String(modal.focusInside));
  ok('page behind the modal is inert', modal.appInert, String(modal.appInert));

  // Property combobox must not be clipped by the scrolling modal body.
  const combo = await page.evaluate(() => {
    // Only a "Property Enquiry" turns the field into a combobox at all.
    const sel = document.getElementById('lmEnquiryType');
    if (sel) { sel.value = 'Property Enquiry'; sel.dispatchEvent(new Event('change')); }
    const inp = document.getElementById('lmInterest');
    if (!inp) return null;
    inp.focus();
    if (typeof openPropertyPop === 'function') openPropertyPop();
    const pop = document.getElementById('lmInterestPop');
    const body = document.querySelector('#lModal .modal-body');
    const p = pop.getBoundingClientRect(), b = body.getBoundingClientRect();
    return {
      pos: getComputedStyle(pop).position,
      display: getComputedStyle(pop).display,
      h: Math.round(p.height),
      clippedBelow: Math.round(p.bottom - b.bottom),
      inViewport: p.top >= -1 && p.bottom <= innerHeight + 1,
    };
  });
  if (combo && combo.display !== 'none') {
    ok('property dropdown escapes the modal body', combo.pos === 'fixed', combo.pos);
    ok('property dropdown fits in the viewport', combo.inViewport, JSON.stringify(combo));
  } else {
    console.log('     (property combobox not applicable here)');
  }

  // With the combobox open, the first Escape belongs to IT, not the modal —
  // closing the whole form because a dropdown was open would lose the entry.
  if (combo && combo.display !== 'none') {
    await page.evaluate(() => document.getElementById('lmInterest').focus());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const s = await page.evaluate(() => ({
      pop: getComputedStyle(document.getElementById('lmInterestPop')).display,
      modal: document.getElementById('lModal').classList.contains('open'),
    }));
    ok('Escape closes the dropdown and leaves the form open', s.pop === 'none' && s.modal, JSON.stringify(s));
  }

  // Escape must close only the top layer, and hand focus back.
  await page.evaluate(() => document.querySelector('#lModal .modal-box').focus?.());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const afterEsc = await page.evaluate(() => ({
    modalOpen: document.getElementById('lModal').classList.contains('open'),
    bodyLocked: document.body.classList.contains('layer-open'),
    appInert: document.getElementById('appRoot').hasAttribute('inert'),
    focus: document.activeElement.className,
  }));
  ok('Escape closes the modal', !afterEsc.modalOpen);
  ok('scroll lock is released', !afterEsc.bodyLocked && !afterEsc.appInert, JSON.stringify(afterEsc));
  ok('focus returns to the button that opened it', afterEsc.focus === beforeFocus, `${afterEsc.focus} vs ${beforeFocus}`);

  // Escape with a modal stacked over the detail panel must close only the modal.
  await page.evaluate(() => { openDetail('L1'); });
  await page.waitForTimeout(250);
  await page.evaluate(() => openEditLeadModal('L1'));
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const layered = await page.evaluate(() => ({
    modal: document.getElementById('lModal').classList.contains('open'),
    dp: document.getElementById('dp').classList.contains('open'),
  }));
  ok('Escape closes only the topmost layer', !layered.modal && layered.dp, JSON.stringify(layered));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('a second Escape closes the panel underneath',
    !(await page.evaluate(() => document.getElementById('dp').classList.contains('open'))));

  // ── The lead panel must actually scroll vertically ──
  // Reading a lead is the panel's whole job; if the body cannot scroll, the
  // timeline and notes below the fold are unreachable.
  await page.evaluate(() => openDetail('L1'));      // L1 has no TailorTalk chat
  await page.waitForTimeout(400);
  const vscroll = await page.evaluate(async () => {
    const body = document.querySelector('#dp .dp-body');
    const dp = document.getElementById('dp');
    const before = body.scrollTop;
    body.scrollTop = 400;
    await new Promise(r => setTimeout(r, 80));
    const inertAncestor = (() => {
      let n = dp;
      while (n && n !== document.documentElement) { if (n.hasAttribute && n.hasAttribute('inert')) return n.id || n.tagName; n = n.parentElement; }
      return null;
    })();
    return {
      scrollH: body.scrollHeight, clientH: body.clientHeight,
      before, after: body.scrollTop,
      dpOverflowY: getComputedStyle(dp).overflowY,
      bodyOverflowY: getComputedStyle(body).overflowY,
      splitCls: document.getElementById('dpSplit').className,
      inertAncestor,
      bodyLocked: document.body.classList.contains('layer-open'),
    };
  });
  console.log('    lead scroll (no chat):', JSON.stringify(vscroll));
  ok('the lead panel has something to scroll', vscroll.scrollH > vscroll.clientH + 4, JSON.stringify(vscroll));
  ok('the lead panel actually scrolls vertically', vscroll.after > vscroll.before + 100, `${vscroll.before} -> ${vscroll.after}`);
  ok('nothing above the panel is inert', !vscroll.inertAncestor, String(vscroll.inertAncestor));

  // Setting scrollTop bypasses input handling entirely, so it proves nothing
  // about a person using a wheel or a trackpad. This is a real input event.
  await page.evaluate(() => { document.querySelector('#dp .dp-body').scrollTop = 0; });
  const box = await page.locator('#dp .dp-body').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(250);
  const wheeled = await page.evaluate(() => ({
    body: document.querySelector('#dp .dp-body').scrollTop,
    win: window.scrollY,
  }));
  console.log('    after a real wheel:', JSON.stringify(wheeled));
  ok('a mouse wheel over the lead scrolls it', wheeled.body > 100, JSON.stringify(wheeled));

  // A browser holding a cached copy of the older document gets the new
  // stylesheet with markup that has no .dp-split wrapper. The panel must still
  // scroll in that combination, or the lead page is simply stuck until the
  // cache turns over.
  const legacy = await page.evaluate(async () => {
    const split = document.getElementById('dpSplit');
    const dp = document.getElementById('dp');
    // Unwrap .dp-body back to being a direct child of #dp, as it used to be.
    const body = split.querySelector('.dp-body');
    dp.appendChild(body);
    split.remove();
    await new Promise(r => setTimeout(r, 120));
    body.scrollTop = 0;
    body.scrollTop = 400;
    await new Promise(r => setTimeout(r, 80));
    return { scrollH: body.scrollHeight, clientH: body.clientHeight, after: body.scrollTop };
  });
  console.log('    legacy markup + new css:', JSON.stringify(legacy));
  ok('a cached older document still scrolls', legacy.after > 100 && legacy.scrollH > legacy.clientH + 4, JSON.stringify(legacy));
  // Put the wrapper back — the checks after this one expect the real markup.
  await page.evaluate(() => {
    const dp = document.getElementById('dp');
    const body = dp.querySelector('.dp-body');
    if (document.getElementById('dpSplit')) return;
    const split = document.createElement('div');
    split.className = 'dp-split';
    split.id = 'dpSplit';
    dp.appendChild(split);
    split.appendChild(body);
    const rz = document.createElement('div');
    rz.className = 'dp-resizer'; rz.id = 'dpResizer';
    rz.setAttribute('role','separator'); rz.tabIndex = 0; rz.setAttribute('aria-valuenow','34');
    split.appendChild(rz);
    const side = document.createElement('aside');
    side.className = 'dp-side'; side.id = 'dpSide';
    side.innerHTML = '<div class="dp-side-hdr"><div class="dp-side-title">Conversation</div>' +
      '<button type="button" class="dp-side-x" onclick="toggleConversationPane()">x</button></div>' +
      '<div class="dp-side-body" id="dpSideBody"></div>';
    split.appendChild(side);
  });
  await page.evaluate(() => closeDetail());
  await page.waitForTimeout(150);

  // And with the conversation pane open, the lead side must still scroll.
  await page.evaluate(() => openDetail('L2'));      // L2 is a TailorTalk lead
  await page.waitForTimeout(400);
  const vscroll2 = await page.evaluate(async () => {
    const body = document.querySelector('#dp .dp-body');
    body.scrollTop = 350;
    await new Promise(r => setTimeout(r, 80));
    const side = document.getElementById('dpSideBody');
    return { after: body.scrollTop, scrollH: body.scrollHeight, clientH: body.clientHeight,
             split: document.getElementById('dpSplit').classList.contains('split'),
             sideScrolls: side ? getComputedStyle(side).overflowY : null };
  });
  console.log('    lead scroll (with chat):', JSON.stringify(vscroll2));
  ok('the lead side still scrolls beside the conversation', vscroll2.after > 100, JSON.stringify(vscroll2));
  await page.evaluate(() => closeDetail());
  await page.waitForTimeout(200);

  // Keyboard access to a lead, in both views.
  const kb = await page.evaluate(() => {
    const card = document.querySelector('.lcard');
    const ok1 = card && card.tabIndex === 0;
    card && card.focus();
    const focused = document.activeElement === card;
    card && card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { ok1, focused, opened: document.getElementById('dp').classList.contains('open') };
  });
  ok('a lead card is focusable and opens with Enter', kb.ok1 && kb.focused && kb.opened, JSON.stringify(kb));
  await page.evaluate(() => closeDetail());
  await page.waitForTimeout(200);

  await page.close();
}

await browser.close();
console.log(errors.length ? `\n${errors.length} FAILURE(S)\n` + errors.map(e => ' - ' + e).join('\n') : '\nAll checks passed.');
process.exit(errors.length ? 1 : 0);
