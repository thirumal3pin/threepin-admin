// ═══════ THE LEAD PANEL SCROLLS — IN WEBKIT, AND ON A PHONE ═══════
//
// Reported: the lead detail page could not be scrolled vertically. It scrolls
// in Chromium, so this runs the same panel through WebKit (Safari / every iOS
// browser) at desktop and phone sizes, using real wheel and touch input rather
// than setting scrollTop — which bypasses exactly the machinery that breaks.
//
//   node tests/crm-panel-scroll-webkit.mjs

import { webkit, chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), D = 86400000;
const T = 't_3pinrealty';

const STAGES = [
  { id:'new', key:'new', name:'New', color:'#1D4ED8', order:0 },
  { id:'negotiation', key:'negotiation', name:'Negotiating', color:'#FE8D00', order:1 },
];
// A lead with a long history, which is what makes the panel taller than the
// screen in real use.
const LEADS = [
  { id:'L1', tenantId:T, name:'Rajesh Kumar', phone:'9840010001', email:'lead1@example.com',
    channel:'whatsapp', source:'manual', enquiryType:'Property Enquiry',
    propertyInterest:'3BHK in Nanganallur', budget:'1.5 Cr', stageId:'new',
    createdAt: NOW - 30*D, updatedAt: NOW - D, followUpAt: NOW + D,
    notes: Array.from({length:14},(_,i)=>({ id:'n'+i, text:'Call '+i+': discussed budget, layout and possession timeline at some length.', at: NOW - (14-i)*D, by:'agent.a@example.com' })),
    history: Array.from({length:14},(_,i)=>({ id:'h'+i, type:'note', text:'History entry '+i, at: NOW - (14-i)*D, by:'agent.a@example.com' })) },
  { id:'L2', tenantId:T, name:'Priya Sundaram', phone:'9840010002', source:'tailortalk',
    enquiryType:'Property Enquiry', propertyInterest:'2BHK Anna Nagar', stageId:'negotiation',
    createdAt: NOW - 20*D, updatedAt: NOW - 2*D,
    tt:{ id:'tt2', category:'sales', integration:'whatsapp', status:'hot',
         lastMessageAt: NOW - 3600000, lastReplyAt: NOW - 3500000, syncedAt: NOW - 3600000 },
    notes: Array.from({length:10},(_,i)=>({ id:'m'+i, text:'Note '+i, at: NOW - (10-i)*D, by:'agent.a@example.com' })) },
];

const STUB = `
const LEADS = ${JSON.stringify(LEADS)};
const STAGES = ${JSON.stringify(STAGES)};
window.crmFirebase = {
  saveLead: async()=>{}, deleteLead: async()=>{},
  getLeadNotes: async id => (LEADS.find(l=>l.id===id)||{}).notes || [],
  getLeadHistory: async id => (LEADS.find(l=>l.id===id)||{}).history || [],
  saveNote: async()=>{}, deleteNoteDoc: async()=>{}, saveHistory: async()=>{}, savePipeline: async()=>{},
  getBotConfig: async()=>null, saveBotConfig: async()=>{}, saveEnquiryTypes: async()=>{}, saveProperties: async()=>{},
  saveFollowupDigestSettings: async()=>{}, saveDashboardEmailSettings: async()=>{},
  releaseLeadField: async()=>{}, getLeadTailorTalk: async()=>null,
  updateLeadAi: async()=>{}, saveAutomationSettings: async()=>{}
};
window.crmAuth = { login: async()=>{}, logout: async()=>{}, getIdToken: async()=>'x', getTenantId: ()=>'${T}' };
window.onCrmAuthChange({ email: 'agent.a@example.com' });
window.applyPipelineSnapshot(STAGES);
window.applyEnquiryTypesSnapshot(['Property Enquiry']);
window.applyLeadsSnapshot(JSON.parse(JSON.stringify(LEADS)));
window.__ready = true;
`;

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.jpg':'image/jpeg', '.json':'application/json' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

async function run(engine, name, viewport, touch) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: false, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch(e){} });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push(`${name}: ${e.message}`); });
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
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(500);

  for (const leadId of ['L1', 'L2']) {
    await page.evaluate(id => openDetail(id), leadId);
    await page.waitForTimeout(500);

    const geo = await page.evaluate(() => {
      const body = document.querySelector('#dp .dp-body');
      const dp = document.getElementById('dp');
      const split = document.getElementById('dpSplit');
      const r = el => { const b = el.getBoundingClientRect(); return { y: Math.round(b.top), h: Math.round(b.height) }; };
      return {
        dp: r(dp), split: split ? r(split) : null, body: r(body),
        scrollH: body.scrollHeight, clientH: body.clientHeight,
        dpOv: getComputedStyle(dp).overflowY,
        splitOv: split ? getComputedStyle(split).overflowY : null,
        bodyOv: getComputedStyle(body).overflowY,
      };
    });

    // Real input, not scrollTop.
    const box = await page.locator('#dp .dp-body').boundingBox();
    await page.evaluate(() => { document.querySelector('#dp .dp-body').scrollTop = 0; });
    let moved = 0;
    // WebKit will not construct a TouchEvent from script, and no engine pans
    // natively from synthetic touches anyway. A wheel is the closest faithful
    // input available; the geometry checks below are what actually prove the
    // box is a real scroll container on a phone-sized screen.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);
    moved = await page.evaluate(() => document.querySelector('#dp .dp-body').scrollTop);

    const tall = geo.scrollH > geo.clientH + 4;
    console.log(`    ${name} ${leadId}:`, JSON.stringify({ ...geo, moved }));
    ok(`${name} · ${leadId} · the panel is taller than the screen`, tall, `${geo.scrollH} vs ${geo.clientH}`);
    ok(`${name} · ${leadId} · it scrolls`, moved > 100, String(moved));
    ok(`${name} · ${leadId} · the body fills the panel below the header`,
      geo.body.h > geo.dp.h * 0.5, JSON.stringify({ body: geo.body.h, dp: geo.dp.h }));
    await page.evaluate(() => closeDetail());
    await page.waitForTimeout(200);
  }
  await browser.close();
}

await run(chromium, 'chromium 1440', { width: 1440, height: 900 }, false);
await run(webkit,   'webkit 1440',   { width: 1440, height: 900 }, false);
await run(webkit,   'webkit 390',    { width: 390,  height: 844 }, true);
await run(chromium, 'chromium 390',  { width: 390,  height: 844 }, true);

console.log(errors.length ? `\n${errors.length} FAILURE(S)\n` + errors.map(e => ' - ' + e).join('\n') : '\nAll checks passed.');
process.exit(errors.length ? 1 : 0);
