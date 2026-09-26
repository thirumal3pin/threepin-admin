// ═══════ THE CONVERSATION PANE: SCROLLS, AND STAYS LIVE ═══════
//
// Reported: the conversation cannot be scrolled, and new TailorTalk messages
// do not appear until much later. Both are checked here with a real chat
// loaded, which the earlier harness did not have — it stubbed the state doc as
// null, so there was nothing to scroll and nothing to update.
//
//   node tests/crm-conversation-preview.mjs <out-dir>

import { chromium, webkit } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'conv-out';
mkdirSync(OUT, { recursive: true });
const NOW = Date.now(), D = 86400000, T = 't_3pinrealty';

const STAGES = [
  { id:'new', key:'new', name:'New', color:'#1D4ED8', order:0 },
  { id:'visit_pending', key:'visit_pending', name:'Visit planned', color:'#6D28D9', order:1 },
];
const LEADS = [
  { id:'L1', tenantId:T, name:'Kiran Sooryaa', phone:'9840010001', source:'tailortalk',
    channel:'whatsapp', enquiryType:'Property Enquiry', propertyInterest:'4BHK Iyyappanthangal',
    stageId:'visit_pending', createdAt: NOW - 3*D, updatedAt: NOW - D,
    tt:{ id:'tt1', category:'sales', integration:'whatsapp', status:'hot',
         lastMessageAt: NOW - 3600000, lastReplyAt: NOW - 3500000,
         lastEventAt: NOW - 3600000, syncedAt: NOW - 3600000 } },
];

// A conversation long enough to overflow the pane — the real complaint.
const CHAT = Array.from({ length: 40 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: i % 2 === 0
    ? 'Message ' + i + ' from the lead, asking about the property in some detail.'
    : 'Reply ' + i + ' from the AI agent, with sizes, price and what happens next. '.repeat(2),
  at: NOW - (40 - i) * 3600000,
}));

const STUB = `
const LEADS = ${JSON.stringify(LEADS)};
const STAGES = ${JSON.stringify(STAGES)};
window.__ttState = { chat: ${JSON.stringify(CHAT)}, values:{}, profile:{} };
window.__ttWatchers = [];
window.crmFirebase = {
  saveLead: async()=>{}, deleteLead: async()=>{}, getLeadNotes: async()=>[], getLeadHistory: async()=>[],
  saveNote: async()=>{}, deleteNoteDoc: async()=>{}, saveHistory: async()=>{}, savePipeline: async()=>{},
  getBotConfig: async()=>null, saveBotConfig: async()=>{}, saveEnquiryTypes: async()=>{}, saveProperties: async()=>{},
  saveFollowupDigestSettings: async()=>{}, saveDashboardEmailSettings: async()=>{},
  releaseLeadField: async()=>{},
  getLeadTailorTalk: async()=>JSON.parse(JSON.stringify(window.__ttState)),
  // The live subscription under test. Records every watcher so the test can
  // push a new message the way Firestore would.
  watchLeadTailorTalk: (id, cb) => {
    const entry = { id, cb };
    window.__ttWatchers.push(entry);
    cb(JSON.parse(JSON.stringify(window.__ttState)));
    return () => { window.__ttWatchers = window.__ttWatchers.filter(w => w !== entry); };
  },
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

async function run(engine, name, viewport) {
  console.log(`\n── ${name} ──`);
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
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
  await page.waitForTimeout(400);

  await page.evaluate(() => openDetail('L1'));
  await page.waitForTimeout(900);

  const wide = viewport.width >= 1100;
  const sel = wide ? '#dpSideBody' : '#dpTt';
  if (!wide) {
    await page.evaluate(() => setTtTab('conversation'));
    await page.waitForTimeout(400);
  }

  const g = await page.evaluate(s => {
    const box = document.querySelector(s);
    const chat = document.getElementById('dpTtChatScroll');
    if (!box) return null;
    return {
      msgs: document.querySelectorAll('.tt-msg').length,
      boxScrollH: box.scrollHeight, boxClientH: box.clientHeight, boxTop: box.scrollTop,
      boxOv: getComputedStyle(box).overflowY,
      chatOv: chat ? getComputedStyle(chat).overflowY : null,
      chatScrollH: chat ? chat.scrollHeight : null, chatClientH: chat ? chat.clientHeight : null,
    };
  }, sel);
  console.log('   ', JSON.stringify(g));
  ok('the conversation rendered', g && g.msgs > 5, JSON.stringify(g));

  // ── Where a reply goes ──
  // The CRM cannot send: its TailorTalk API reads leads, and the stored Meta
  // WhatsApp credentials are dead. What it can do is hand over to the right
  // conversation in one click, which is worth more than a compose box that
  // silently fails.
  if (wide) {
    const r = await page.evaluate(() => {
      const bar = document.querySelector('#dpSideReply');
      const btn = bar && bar.querySelector('.dp-reply-btn');
      if (!btn) return { none: true };
      const br = bar.getBoundingClientRect(), side = document.querySelector('#dpSide').getBoundingClientRect();
      return {
        href: btn.getAttribute('href'),
        text: bar.textContent.replace(/\s+/g, ' ').trim().slice(0, 130),
        // It sits at the foot of the pane, where a compose box belongs.
        atFoot: Math.abs(br.bottom - side.bottom) < 4,
        onScreen: br.width > 0 && br.right <= innerWidth + 1,
        tall: Math.round(btn.getBoundingClientRect().height)
      };
    });
    ok('the conversation offers a way to reply', !r.none, JSON.stringify(r));
    ok('...which carries the TailorTalk lead id, so it opens THIS chat',
      /dashboard\.tailortalk\.ai\/.+\/leads\?lead_id=.+/.test(r.href || ''), r.href);
    ok('...sits at the foot of the pane, where a compose box would', r.atFoot, JSON.stringify(r));
    ok('...is big enough to tap', r.tall >= 36, r.tall + 'px');
    ok('...and says the reply is typed in TailorTalk, not here',
      /TailorTalk/.test(r.text || ''), r.text);

    // The owner asked for a mini window rather than a trip to another tab.
    // An iframe is impossible — dashboard.tailortalk.ai answers with
    // x-frame-options: DENY and frame-ancestors 'none' — so the button opens
    // a sized popup beside the CRM, which keeps this tab exactly where it is.
    const popped = await page.evaluate(() => {
      const calls = [];
      const real = window.open;
      window.open = (u, name, feat) => { calls.push({ u, name, feat }); return { focus() {} }; };
      document.querySelector('.dp-reply-btn').click();
      window.open = real;
      return calls;
    });
    ok('...and opens a window rather than navigating away', popped.length === 1, JSON.stringify(popped));
    ok('...sized, and positioned beside this one',
      /width=\d+/.test(popped[0].feat || '') && /left=\d+/.test(popped[0].feat || ''), popped[0].feat);
    ok('...named, so a second lead reuses the same window',
      popped[0].name === 'tailortalkChat', popped[0].name);
    ok('...carrying this lead', /lead_id=/.test(popped[0].u || ''), popped[0].u);
    ok('...and this page did not move', page.url().includes('crm.local'), page.url());
  }

  // Exactly one box may be the scroller, and it must have somewhere to go.
  const boxScrolls = g.boxScrollH > g.boxClientH + 4;
  const chatScrolls = g.chatScrollH > g.chatClientH + 4;
  ok('the conversation has something to scroll', boxScrolls || chatScrolls, JSON.stringify(g));

  // Real input over the messages.
  const target = boxScrolls ? sel : '#dpTtChatScroll';
  // Inline on a phone the chat sits well down the lead page, so its box can be
  // below the viewport — a wheel there would land on the page, not the chat.
  await page.locator(target).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await page.locator(target).boundingBox();
  const my = Math.max(10, Math.min(box.y + box.height / 2, viewport.height - 40));
  await page.mouse.move(box.x + box.width / 2, my);
  await page.mouse.wheel(0, -900);            // up, towards older messages
  await page.waitForTimeout(300);
  const upTop = await page.evaluate(t => document.querySelector(t).scrollTop, target);
  await page.mouse.wheel(0, 1800);            // back down
  await page.waitForTimeout(300);
  const downTop = await page.evaluate(t => document.querySelector(t).scrollTop, target);
  console.log('    wheel:', JSON.stringify({ upTop, downTop }));
  ok('a wheel over the conversation moves it', downTop > upTop + 100, `${upTop} -> ${downTop}`);

  // Newest message first: a chat you have to scroll to the bottom of every
  // time is a chat that opens on the wrong end.
  await page.evaluate(() => openDetail('L1'));
  await page.waitForTimeout(900);
  if (!wide) { await page.evaluate(() => setTtTab('conversation')); await page.waitForTimeout(400); }
  const atBottom = await page.evaluate(s => {
    const box = document.querySelector(s);
    const chat = document.getElementById('dpTtChatScroll');
    const sc = (box.scrollHeight > box.clientHeight + 4) ? box : chat;
    return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
  }, sel);
  console.log('    opens at:', JSON.stringify(atBottom));
  ok('it opens on the newest message', atBottom.max <= 4 || atBottom.top > atBottom.max - 60, JSON.stringify(atBottom));

  // ── Live updates ──
  const live = await page.evaluate(async () => {
    const before = document.querySelectorAll('.tt-msg').length;
    const watching = window.__ttWatchers.length;
    // Push a message the way Firestore would, with no leads-snapshot bump —
    // which is exactly the case that used to leave the CRM showing stale chat.
    window.__ttState.chat.push({ role:'user', content:'BRAND NEW MESSAGE FROM THE LEAD', at: Date.now() });
    window.__ttWatchers.forEach(w => w.cb(JSON.parse(JSON.stringify(window.__ttState))));
    await new Promise(r => setTimeout(r, 500));
    const msgs = [...document.querySelectorAll('.tt-msg')];
    return {
      watching,
      before,
      after: msgs.length,
      hasNew: /BRAND NEW MESSAGE FROM THE LEAD/.test(document.body.textContent),
      // The chat renders a page of the most recent messages, so arriving at 41
      // shows 40 with the oldest rolled off — the new one must be the last.
      isLast: /BRAND NEW MESSAGE FROM THE LEAD/.test(msgs[msgs.length - 1].textContent),
    };
  });
  console.log('    live:', JSON.stringify(live));
  ok('the conversation is subscribed, not polled', live.watching > 0, String(live.watching));
  ok('a new message appears without a reload', live.hasNew, JSON.stringify(live));
  ok('…and it lands at the bottom of the thread', live.isLast, JSON.stringify(live));

  // And the watcher is released when the lead closes.
  const released = await page.evaluate(async () => {
    closeDetail();
    await new Promise(r => setTimeout(r, 300));
    return window.__ttWatchers.length;
  });
  ok('closing the lead releases the subscription', released === 0, String(released));

  // ── Duplicate timeline entries ──
  // Reported: "Handled: <step>" appearing twice, same text, same minute. A
  // double tap is the obvious way in on a phone, so this presses it twice in
  // quick succession and counts what actually lands.
  await page.evaluate(() => openDetail('L1'));
  await page.waitForTimeout(600);
  const dup = await page.evaluate(async () => {
    const l = leads.find(x => x.id === 'L1');
    l.ai = { next: { owner:'team', action:'Call Kiran to confirm Fri 18 Sep 3:30 PM visit to IYYA0001', kind:'confirm_visit', dueAt: Date.now() + 3600000, setAt: Date.now() - 1000 } };
    l.updatedAt = Date.now() - 2000;
    renderStandSection(l);
    await new Promise(r => setTimeout(r, 150));
    const btn = [...document.querySelectorAll('#dpStand .st-step .tt-btn')].find(b => b.textContent.trim() === 'Done');
    if (!btn) return { error: 'no Done button' };
    const before = (l.history || []).filter(h => /Handled:/.test(h.text)).length;
    btn.click();
    btn.click();                     // the double tap
    await new Promise(r => setTimeout(r, 400));
    const after = (leads.find(x => x.id === 'L1').history || []).filter(h => /Handled:/.test(h.text));
    return { before, after: after.length, texts: after.map(h => h.text) };
  });
  console.log('    double-tap Done:', JSON.stringify(dup));
  ok('a double tap logs one entry, not two', dup.after === 1, JSON.stringify(dup));

  // ── The history reads as one moment per action ──
  const tl = await page.evaluate(async () => {
    const l = leads.find(x => x.id === 'L1');
    l.notes = []; l.history = [];
    fuLogLeadId = 'L1';
    document.getElementById('fuLogNote').value = 'visited , need the feedback';
    const d = new Date(Date.now() + 86400000);
    document.getElementById('fuLogDate').value =
      d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    document.getElementById('fuLogTime').value = '15:42';
    saveFollowUpLog();
    await new Promise(r => setTimeout(r, 400));
    const cur = leads.find(x => x.id === 'L1');
    const rows = [...document.querySelectorAll('#timelinePanel .tl-item')];
    return {
      historyLines: (cur.history || []).map(h => h.text),
      notes: (cur.notes || []).map(n => n.text),
      rows: rows.length,
      stamps: rows.map(r => (r.querySelector('.tl-meta') || {}).textContent || '').filter(Boolean).length,
      stampsInFirstRow: rows[0] ? rows[0].querySelectorAll('.tl-meta').length : 0,
      firstRowText: rows[0] ? rows[0].textContent.replace(/\s+/g, ' ').trim() : '',
    };
  });
  console.log('    timeline:', JSON.stringify(tl));
  ok('the event line does not repeat the note', !tl.historyLines.some(t => /visited , need the feedback/.test(t)), JSON.stringify(tl.historyLines));
  ok('the note is kept as the note', tl.notes.length === 1, JSON.stringify(tl.notes));
  ok('the follow-up and its new date are one line', tl.historyLines.length === 1, JSON.stringify(tl.historyLines));
  ok('…which names the next date', /next/.test(tl.historyLines[0] || ''), tl.historyLines[0]);
  // The panel also carries TailorTalk day summaries, so count what matters:
  // the note and the follow-up must share ONE row with ONE timestamp, rather
  // than being two rows each repeating 02:42 PM and the same name.
  ok('the note and the follow-up are one row',
    /visited , need the feedback/.test(tl.firstRowText) && /Followed up/.test(tl.firstRowText), tl.firstRowText);
  ok('…with one timestamp, not one per line', tl.stampsInFirstRow === 1, String(tl.stampsInFirstRow));
  ok('…and the note leads it', /visited , need the feedback/.test(tl.firstRowText), tl.firstRowText);

  // A timeline carrying one of each kind, to look at and to check.
  const kinds = await page.evaluate(async () => {
    const l = leads.find(x => x.id === 'L1');
    const T = Date.now();
    l.notes = [{ id:'n1', text:'visited , need the feedback', createdAt: T - 600000, by:'thirumal@threepin.in' }];
    l.history = [
      { id:'h1', type:'followed-up', text:'Followed up · next <b>Sep 20, 03:42 PM</b>', at: T - 600000, by:'thirumal@threepin.in' },
      { id:'h2', type:'stage', text:'Stage changed from <b>Visit planned</b> to <b>Visited</b>', at: T - 900000, by:'thirumal@threepin.in' },
      { id:'h3', type:'followed-up', text:'Handled: <b>Call Kiran to confirm Fri 18 Sep 3:30 PM visit to IYYA0001</b>', at: T - 900000, by:'thirumal@threepin.in' },
      { id:'h4', type:'tailortalk', text:'TailorTalk stage: <b>Actively looking, next action: confirm the site visit date with the lead</b> → <b>Actively looking, next action is lead to confirm</b>', at: T - 4000000, by:'TailorTalk' },
      { id:'h5', type:'tailortalk', text:'AI paused — a team member has taken over the chat in TailorTalk', at: T - 4000000, by:'TailorTalk' },
      { id:'h6', type:'field', text:'Budget changed from <b>3.3 Cr</b> to <b>3.6 Cr</b>', at: T - 5000000, by:'thirumal@threepin.in' },
      { id:'h7', type:'stage', text:'🤖 Moved from <b>Options sent</b> to <b>Visit planned</b>', at: T - 6000000, by:'AI' },
    ];
    setTimelineFilter('all');
    renderTimeline(l);
    await new Promise(r => setTimeout(r, 300));
    const rows = [...document.querySelectorAll('#timelinePanel .tl-item')];
    return {
      labels: [...document.querySelectorAll('#timelinePanel .tl-kind')].map(k => k.textContent.trim()),
      rowsWithMeta: rows.filter(r => r.querySelector('.tl-meta')).length,
      rows: rows.length,
      // Each moment must state its time once, above the things that happened.
      metaFirst: rows.every(r => { const b = r.querySelector('.tl-body'); return !b.querySelector('.tl-meta') || b.firstElementChild.classList.contains('tl-meta'); }),
      deleteOutsideText: [...document.querySelectorAll('#timelinePanel .tl-text')].every(t => !t.querySelector('.tl-del')),
    };
  });
  console.log('    kinds:', JSON.stringify(kinds));
  ok('every line names its kind', kinds.labels.length >= 7, JSON.stringify(kinds.labels));
  ok('the kinds are told apart', new Set(kinds.labels).size >= 5, JSON.stringify([...new Set(kinds.labels)]));
  ok('an AI move reads as AI, not just a stage change', kinds.labels.includes('AI'), JSON.stringify(kinds.labels));
  ok('TailorTalk updates are labelled', kinds.labels.filter(x => x === 'TailorTalk').length >= 2, JSON.stringify(kinds.labels));
  ok('the time leads each moment', kinds.metaFirst, String(kinds.metaFirst));
  ok('the delete control stays out of the note text', kinds.deleteOutsideText, String(kinds.deleteOutsideText));
  await page.locator('#dpTimelineSec').screenshot({ path: join(OUT, `timeline-${name.replace(/[^a-z0-9]+/gi,'-')}.png`) });

  await page.screenshot({ path: join(OUT, `conversation-${name.replace(/[^a-z0-9]+/gi,'-')}.png`) });
  await browser.close();
}

await run(chromium, 'chromium 1440', { width: 1440, height: 900 });
await run(webkit,   'webkit 1440',   { width: 1440, height: 900 });
await run(chromium, 'chromium 390',  { width: 390,  height: 844 });

console.log(errors.length ? `\n${errors.length} FAILURE(S)\n` + errors.map(e => ' - ' + e).join('\n') : '\nAll checks passed.');
process.exit(errors.length ? 1 : 0);
