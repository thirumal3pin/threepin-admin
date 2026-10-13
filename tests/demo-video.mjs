// A walkthrough video of Shoot & Media — from a seller's property to its post going live — recorded
// on the real propertytrack.html with sample data (Firebase swapped for an in-memory stand-in: no
// live data is read or written). Captions explain each step; a dot shows the pointer.
//   node tests/demo-video.mjs [out-dir]          → <out-dir>/shoot-media-demo.webm
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'User manual/demo';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), H = 3600000, DAY = 24 * H, T = 't_3pin';
const day0 = (() => { const d = new Date(NOW); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const ST = defaultStages(), sid = k => ST.find(s => s.key === k).id;
const L = o => ({ tenantId: T, media: {}, tags: [], createdAt: NOW - 3 * DAY, updatedAt: NOW - DAY, stageChangedAt: NOW - DAY, ...o });

// Three properties at three points of the journey — the work runs in parallel.
const LISTINGS = [
  L({ id: 'pA', title: '3BHK Apartment, Anna Nagar', propertyCode: 'ANNA0012', stageId: sid('details'), stageChangedAt: NOW - 6 * DAY, sellerName: 'Meenakshi', sellerPhone: '9840011111',
      address: 'Flat 4B, 2nd Avenue, Anna Nagar', locality: 'Anna Nagar', tags: ['Premium'] }),
  L({ id: 'pB', title: 'Commercial floor, Kodambakkam', propertyCode: 'KDBM0001', stageId: sid('shoot_done'), sellerName: 'Rajiv', sellerPhone: '9941880088',
      shootAt: NOW - DAY, shootDoneAt: NOW - DAY, shootAssignee: 'Rajesh', ownerInformed: true, photosLink: 'https://drive.google.com/kdbm',
      media: { photos: true, video: true }, forPlan: { yt: true }, forVoice: { yt: 'live' },
      cuts: { yt: { status: 'active', by: 'Rajesh', planAt: day0, dueAt: day0 + DAY, startedAt: NOW - 2 * H, doneAt: 0, note: '', log: [], shared: false } } }),
  L({ id: 'pC', title: 'Villa, ECR', propertyCode: 'ECR0009', stageId: sid('media_ready'), sellerName: 'Prakash', sellerPhone: '9884022222',
      shootAt: NOW - 4 * DAY, shootDoneAt: NOW - 4 * DAY, shootAssignee: 'Rajesh', ownerInformed: true, photosLink: 'https://drive.google.com/ecr',
      media: { photos: true, floorPlan: true }, forPlan: { igStory: true }, forDone: { igStory: true }, forVoice: { igStory: 'live' },
      cuts: { igStory: { status: 'done', by: 'Rajesh', planAt: NOW - 3 * DAY, dueAt: 0, startedAt: NOW - 3 * DAY, doneAt: NOW - 3 * DAY + 2 * H, note: '', log: [], shared: false } },
      brochure: { code: 'ECR0009' } })
];
const mk = o => ({ tenantId: T, channels: {}, brochure: { done: true }, acres99: { status: 'pending' }, website: { status: 'pending' }, createdAt: NOW - 3 * DAY, ...o });
const TRACKERS = [
  mk({ id: 'rC', propertyCode: 'ECR0009', title: 'Villa, ECR', photosLink: 'https://drive.google.com/ecr', details: 'Villa, ECR', channels: { igStory: { status: 'scheduled', at: day0 + DAY + 18 * H } } }),
  mk({ id: 'rB', propertyCode: 'KDBM0001', title: 'Commercial floor, Kodambakkam', photosLink: 'https://drive.google.com/kdbm', details: 'x', channels: { yt: { status: 'yet', day: day0 + 2 * DAY } }, plannedDate: day0 + 2 * DAY })
];
const INV = [
  { id: 'ECR0009', propertyCode: 'ECR0009', name: 'Villa, ECR', location: 'ECR', photosLink: 'https://drive.google.com/ecr', detailsText: 'villa', brochureUrl: 'https://x/ecr.pdf' }
];
const CFG = { editors: ['Rajesh'], voiceBy: 'Swami', voiceByEmail: 'swami@3pin.in' };
const STUB = `
window.__saved = []; window.__listings = []; window.__inv = ${JSON.stringify(INV)};
window.trackFirebase = {
  savePosting: async (t) => { window.__saved.push(JSON.parse(JSON.stringify(t))); },
  savePostings: async ws => { for (const w of ws) window.__saved.push(JSON.parse(JSON.stringify(w.t))); },
  deletePosting: async () => {},
  saveListing: async l => { window.__listings.push(JSON.parse(JSON.stringify(l))); },
  deleteListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  saveTrackConfig: async () => {},
  getInventory: async () => JSON.parse(JSON.stringify(window.__inv)), getListingHistory: async () => [], saveHistory: async () => {}, deleteHistory: async () => {},
  getPropertyInternalNotes: async () => '', getLeadConversation: async () => null
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'thirumal@3pin.in' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(ST)});
  window.applyTrackTeamSnapshot({ a: { email: 'rajesh@3pin.in' }, b: { email: 'swami@3pin.in' }, c: { email: 'thirumal@3pin.in' } });
  window.applyTrackConfigSnapshot(${JSON.stringify(CFG)});
  window.applyListingsSnapshot(${JSON.stringify(LISTINGS)});
  window.applyTrackLeadsSnapshot([]);
  window.applyPostingSnapshot(${JSON.stringify(TRACKERS)});
  window.__ready = true;
}, 0);`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

// The overlay: a caption bar, a title card and a pointer dot (recordings show no pointer of their own).
const OVERLAY = () => {
  const css = document.createElement('style');
  css.textContent = `
  #dm-cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483646;max-width:980px;width:max-content;
    background:rgba(17,17,17,.92);color:#fff;border-radius:16px;padding:14px 22px;font:500 17px/1.45 system-ui,Segoe UI,Arial;
    box-shadow:0 10px 30px rgba(0,0,0,.25);opacity:0;transition:opacity .35s;pointer-events:none}
  #dm-cap b{display:block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#FE8D00;margin-bottom:3px}
  #dm-cap.on{opacity:1}
  #dm-title{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:#111;color:#fff;font:600 44px/1.2 system-ui,Segoe UI,Arial;text-align:center;opacity:0;transition:opacity .5s;pointer-events:none;gap:14px}
  #dm-title small{font-weight:400;font-size:20px;color:#bbb;max-width:900px}
  #dm-title i{font-style:normal;color:#FE8D00}
  #dm-title.on{opacity:1}
  #dm-dot{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(254,141,0,.35);border:2px solid #FE8D00;
    z-index:2147483647;pointer-events:none;transition:transform .12s;left:-50px;top:-50px}
  #dm-dot.down{transform:scale(.7);background:rgba(254,141,0,.7)}`;
  document.head.appendChild(css);
  const cap = Object.assign(document.createElement('div'), { id: 'dm-cap' });
  const title = Object.assign(document.createElement('div'), { id: 'dm-title' });
  const dot = Object.assign(document.createElement('div'), { id: 'dm-dot' });
  document.body.append(cap, title, dot);
  addEventListener('mousemove', e => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => dot.classList.add('down'), true);
  addEventListener('mouseup', () => dot.classList.remove('down'), true);
  window.__cap = (t, s) => { cap.innerHTML = t ? `<b>${t}</b>${s || ''}` : ''; cap.classList.toggle('on', !!t); };
  window.__title = (t, s) => { title.innerHTML = t ? `<div>${t}</div>${s ? `<small>${s}</small>` : ''}` : ''; title.classList.toggle('on', !!t); };
};

const browser = await chromium.launch();
const VIDEO_DIR = join(OUT, '_raw');
rmSync(VIDEO_DIR, { recursive: true, force: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } } });
const p = await ctx.newPage();
p.on('dialog', d => d.type() === 'prompt' ? d.accept(d.message().includes('voice-over') ? '30 sec, Tamil — script on WhatsApp' : '') : d.accept());
p.on('pageerror', e => console.log('pageerror:', e.message));
await p.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('crmTheme', 'light'); } catch (e) {} });
await p.route('**/*', route => {
  const url = new URL(route.request().url());
  if (/cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) return route.continue();
  if (url.hostname !== 'track.local') return route.abort();
  if (url.pathname === '/track-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
  const file = join(ROOT, decodeURIComponent(url.pathname));
  if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
});
await p.goto('http://track.local/propertytrack.html');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
await p.evaluate(OVERLAY);
await p.waitForTimeout(600);

// ── helpers: a visible pointer, captions, a highlight ring, chapter cards ──
const wait = ms => p.waitForTimeout(ms);
const cap = async (t, s, ms = 2800) => { await p.evaluate(([t, s]) => window.__cap(t, s), [t, s]); if (ms) await wait(ms); };
const title = async (t, s, ms = 3600) => { await p.evaluate(() => window.__cap('')); await p.evaluate(([t, s]) => window.__title(t, s), [t, s]); await wait(ms); await p.evaluate(() => window.__title('')); await wait(600); };
// A chapter: its number, name, and the three things a person needs — what it is, what to do, how.
const chapter = (n, name, what, todo, how, ms = 6500) => title(`<i>Stage ${n}</i><br>${name}`,
  `<b style="color:#fff">What it is</b> — ${what}<br><br><b style="color:#fff">What to do</b> — ${todo}<br><br><b style="color:#fff">How</b> — ${how}`, ms);
async function ring(sel, ms = 1800) {
  const b = await p.locator(sel).first().boundingBox().catch(() => null);
  if (!b) return;
  await p.evaluate(([x, y, w, h]) => window.__ring(x, y, w, h), [b.x, b.y, b.width, b.height]);
  if (ms) { await wait(ms); await p.evaluate(() => window.__ring()); }
}
async function point(sel) {
  const el = p.locator(sel).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const b = await el.boundingBox();
  if (!b) throw new Error('Not on screen: ' + sel);
  await p.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 18), { steps: 22 });
  await wait(250);
}
async function click(sel, after = 700) { await point(sel); await p.mouse.down(); await wait(90); await p.mouse.up(); await wait(after); }
async function fill(sel, text) { await click(sel, 200); await p.fill(sel, ''); await p.type(sel, text, { delay: 40 }); await wait(400); }
// The menu on the left: the visible item with that name (the CRM has a "Board" of its own).
async function nav(label, fallback) {
  const items = p.locator('.rail-nav a:visible, .rail-nav button:visible').filter({ hasText: new RegExp('^\\s*' + label + '\\s*$') });
  if (await items.count()) {
    const b = await items.last().boundingBox();
    if (b) { await p.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 22 }); await wait(200); await p.mouse.down(); await wait(80); await p.mouse.up(); await wait(1000); return; }
  }
  await p.evaluate(fallback); await wait(1000);
}
const dateIn = ts => { const d = new Date(ts), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
await p.evaluate(() => {
  const r = Object.assign(document.createElement('div'), { id: 'dm-ring' });
  r.style.cssText = 'position:fixed;z-index:2147483645;border:3px solid #FE8D00;border-radius:12px;box-shadow:0 0 0 6px rgba(254,141,0,.18);pointer-events:none;opacity:0;transition:all .3s';
  document.body.appendChild(r);
  window.__ring = (x, y, w, h) => { if (x === undefined) { r.style.opacity = 0; return; } Object.assign(r.style, { left: x - 6 + 'px', top: y - 6 + 'px', width: w + 12 + 'px', height: h + 12 + 'px', opacity: 1 }); };
});
const scrollBoard = (left, smooth = true) => p.evaluate(([l, s]) => { const b = document.querySelector('.tk-board'); if (b) b.scrollTo({ left: l, behavior: s ? 'smooth' : 'auto' }); }, [left, smooth]);

// ══════════════════ THE WALKTHROUGH ══════════════════
await title('Shoot &amp; Media — how we work', 'From a seller’s property to its post going live: the shoot, the edit, the voice-over and the posts — on one board.<br><br><i>A walkthrough for the 3 PIN Realty team</i>', 4600);

// ── The board ──
await title('<i>Start here</i><br>The board', 'One card per property. Columns are stages — a card moves right as the work gets done, mostly by itself.', 4200);
await scrollBoard(0, false);
await ring('.tk-board', 0); await cap('The columns', 'New listing → Details &amp; docs → Shoot scheduled → Shoot done → Media ready → Live. A column’s count and “late” sit on top.', 3800);
await p.evaluate(() => window.__ring());
await point('.tk-card[data-id="pA"]'); await ring('.tk-card[data-id="pA"]', 0);
await cap('Reading a card', 'Top: its code and days in this stage (red when late). Then the name, one line of area · type · price.', 3600);
await ring('.tk-card[data-id="pA"] .tk-card-row, .tk-card[data-id="pA"] .tk-next', 0);
await cap('The next step', 'One line says what is next for this stage — here, the shoot is not booked yet.', 3200);
await p.evaluate(() => window.__ring());
await ring('#tkFilterBar', 0);
await cap('Find anything', 'Search by name, owner or code. Filter by stage, agent, tags or brochure. Board · List · Editor switches the view.', 3800);
await p.evaluate(() => window.__ring());
await scrollBoard(760); await wait(1400);
await cap('Work in parallel', 'Kodambakkam is being edited, the ECR villa’s Story is booked to post — each card shows where it stands.', 3600);
await scrollBoard(0); await wait(1000);

// ── Stage 1 · Details & docs ──
await chapter(1, 'Details &amp; docs', 'the owner said yes; we gather the property’s details.',
  'complete the details, the address and the owner’s contact; then book the shoot.',
  'open the card — the panel holds everything; a red “Missing” line says what is left.');
await click('.tk-card[data-id="pA"]', 1200);
await cap('The card’s panel', 'Seller, contact, the property, Shoot for, the edit, notes and the timeline — everything on one card.', 3800);
await p.evaluate(() => closeDetail()); await wait(600);

// ── Stage 2 · Book the shoot ──
await chapter(2, 'Book the shoot', 'a date, a time and who shoots.',
  'book it, then tell the owner and tick “Owner told”.',
  '“Book →” on the card (or “Book the shoot” in the panel). Booking moves the card to Shoot scheduled.');
await click('.tk-card[data-id="pA"] .tk-link:has-text("Book")', 900);
await ring('#shModal .tk-box', 0);
await click('#shDate', 200); await p.fill('#shDate', dateIn(NOW + DAY)); await wait(400);
await click('#shTime', 200); await p.fill('#shTime', '10:30'); await wait(300);
await point('#shWho'); await p.selectOption('#shWho', { label: 'Rajesh' }).catch(async () => { await p.selectOption('#shWho', { index: 1 }); }); await wait(700);
await cap('Booking', 'Day, time, who shoots and the site contact. Reschedule or cancel later from the same place.', 2600);
await p.evaluate(() => window.__ring());
await click('#shModal .tk-btn.primary:has-text("Save")', 1300);
await cap('Booked', 'It moved to Shoot scheduled by itself.', 2400);
await click('.tk-card[data-id="pA"]', 1100);
await p.evaluate(() => { const i = document.querySelector('#dp input[onchange*="ownerInformed"]'); if (i) i.scrollIntoView({ block: 'center' }); }); await wait(600);
await ring('#dp input[onchange*="ownerInformed"]', 0);
await cap('Owner told', 'Call the owner, then tick it. Until then the card warns “owner not told”.', 1500);
await click('#dp input[onchange*="ownerInformed"]', 1300);
await p.evaluate(() => { window.__ring(); closeDetail(); }); await wait(600);

// ── Stage 3 · Shoot day ──
await chapter(3, 'Shoot day', 'the shooter’s run sheet: today, coming up and missed.',
  'go, shoot, and on the way out tick what was captured.',
  'Shoots in the menu (it opens first on the shooter’s phone) → “Done”; or “Shoot done →” on the card.');
await nav('Shoots', () => toggleView('shoots'));
await cap('Shoots', 'Each shoot with its address, directions, the brief (photos, video…) and Open · Reschedule · Cancel.', 4200);
await nav('Board', () => toggleView('board', true));
await click('.tk-card[data-id="pA"]', 1000);
await click('#dp .tk-btn:has-text("Shoot done")', 1000);
await ring('#wrapModal .tk-box', 0);
await cap('Shoot done', 'Tick what you got — anything asked for and not ticked stays flagged. Paste the Drive folder now.', 1400);
await click('#wrap_photos', 300); await click('#wrap_video', 300);
await fill('#wrapPhotos', 'https://drive.google.com/drive/folders/anna-nagar');
await p.evaluate(() => window.__ring());
await click('#wrapModal .tk-btn.primary', 1300);
await cap('Shot', 'The card is in Shoot done — ready for the edit.', 2400);

// ── Stage 4 · Shoot for ──
await chapter(4, 'Where it goes — Shoot for', 'the outlets this shoot is for: Insta Story, Insta Reel, FB Reel, YouTube, Collab.',
  'tick each outlet; for each, say if the video has its voice or needs a voice-over made separately.',
  'open the card → Shoot for. Each outlet becomes its own edit.');
await click('.tk-card[data-id="pA"]', 1000);
await p.evaluate(() => document.getElementById('dpFor').scrollIntoView({ block: 'center', behavior: 'smooth' })); await wait(900);
await ring('#dpFor', 0);
await click('#dpFor input[aria-label="Insta Reel planned"]', 700);
await click('#dpFor input[aria-label="YouTube planned"]', 700);
await point('#dpFor select[aria-label="Insta Reel voice"]'); await p.selectOption('#dpFor select[aria-label="Insta Reel voice"]', 'vo'); await wait(900);
await point('#dpFor select[aria-label="YouTube voice"]'); await p.selectOption('#dpFor select[aria-label="YouTube voice"]', 'live'); await wait(900);
await cap('Reel: V/O separately · YouTube: with voice', 'The “Edit” column shows each outlet’s edit — it moves only by the editor’s steps, never by a tick.', 3600);
await p.evaluate(() => { window.__ring(); closeDetail(); }); await wait(600);

// ── Stage 5 · The edit ──
await chapter(5, 'The edit', 'the editor’s own board: what to shoot, edit, deliver and post — nearest deadline first.',
  'Plan (who, which day, deliver by) → Start editing → Edit done. Each a click; nothing skips a step.',
  'Editor in the menu (it opens first for the editors), or Board · List · Editor.');
await nav('Editor', () => toggleView('editor'));
await ring('.ed-board', 0);
await cap('The Editor view', 'Shoot planned → Shot → Planned to edit → Editing → Edit done → Post scheduled → Posted.', 3800);
await p.evaluate(() => window.__ring());
await ring('.ed-track', 0);
await cap('The editors’ track', 'Who is editing what right now and for how long, what is assigned, done this week. Tap a name: only their work and past edits.', 4200);
await p.evaluate(() => window.__ring());
await click('.tk-card[data-id="pA"] .tk-btn:has-text("Plan edits")', 1000);
await ring('#edModal .tk-box', 0);
await cap('Plan the edit', 'Tick the outlets, pick the editor, the edit day and when to deliver (by default the day before the post).', 1500);
await point('#edWho'); await p.selectOption('#edWho', { label: 'Rajesh' }).catch(() => {}); await wait(500);
await click('#edDue', 200); await p.fill('#edDue', dateIn(NOW + 2 * DAY)); await wait(500);
await p.evaluate(() => window.__ring());
await click('#edModal .tk-btn.primary', 1400);
await cap('One card per outlet', 'The Reel and YouTube now move on their own — edited and posted on different days if needed.', 3400);
await click('.tk-card[data-id="pA"][data-cut="igReel"] .tk-btn:has-text("Start editing")', 1300);
await cap('Editing', 'The clock starts; it shows live on the editor’s tile.', 2600);

// ── Stage 6 · Voice-over ──
await chapter(6, 'The voice-over', 'the editor needs the rough cut first — then Swami records the voice-over.',
  'editor: “Ask for V/O” with a note. Swami: make it, tick “V/O made”.',
  'on the card (Editor view or board) or in the card’s Shoot for. Swami’s list is in his Daily task.');
await click('.tk-card[data-id="pA"][data-cut="igReel"] .tk-vo-ask', 1500);
await ring('.tk-card[data-id="pA"][data-cut="igReel"] .tk-vo', 0);
await cap('Swami is asked', 'Amber on every card, with his name and how long ago — and in his Daily task, with the note.', 3800);
await p.evaluate(() => window.__ring());
await ring('.ed-sum', 0);
await cap('Who waits on whom', 'The summary counts V/Os asked and still to ask; Checklist → “V/O needed or asked” lists them.', 3400);
await p.evaluate(() => window.__ring());
await point('.ed-bar select'); await p.evaluate(() => setEdPerson('Swami')); await wait(900);
await ring('.ed-board', 0);
await cap('Swami’s view', 'Person → Swami: only the cards waiting on his voice-over. The same list is in his Daily task in the CRM.', 4000);
await p.evaluate(() => { window.__ring(); setEdPerson('Swami'); }); await wait(800);
await click('.tk-card[data-id="pA"][data-cut="igReel"] .tk-vo-done', 1200);
await cap('V/O made', 'The editor finishes the cut.', 1400);
await click('.tk-card[data-id="pA"][data-cut="igReel"] .tk-btn:has-text("Edit done")', 1400);
await cap('Edit done', 'Ready to post. YouTube is still to edit — each outlet at its own pace.', 3000);

// ── Stage 7 · Posting ──
await chapter(7, 'Posting', 'every post, by day and outlet — Insta, FB, YouTube, the website.',
  'plan the post’s day and time; when it is out, mark it live with its link.',
  '“Plan post” on the card opens Posting’s schedule; or Posting in the menu. A post goes live only once its edit is done.');
await click('.tk-card[data-id="pA"][data-cut="igReel"]', 1100);
await p.evaluate(() => document.getElementById('dpEdit').scrollIntoView({ block: 'center', behavior: 'smooth' })); await wait(900);
await ring('#dpEdit', 0);
await cap('Plan the post from the card', 'Same schedule as Posting — one place for every post.', 1500);
await p.evaluate(() => window.__ring());
await click('#dpEdit .tk-btn:has-text("Plan post")', 1100);
await click('#pgAt', 200); await p.fill('#pgAt', `${dateIn(NOW + DAY)}T18:30`); await wait(600);
await click('#pgSave', 1400);
await cap('Scheduled', 'The card shows the post day; the Reel moves to “Post scheduled”.', 2600);
await p.evaluate(() => closeDetail()); await wait(800);
await nav('Posting', () => toggleView('posting'));
await p.evaluate(() => window.pgMode && window.pgMode('week')); await wait(900);
await cap('Posting — the week', 'Every post by day. Paste the week plan, add schedules, series (several properties in one video) and reposts.', 4000);
const row = await p.evaluate(() => window.pgPostsFor(window.trackApi.listings().find(l => l.id === 'pA')).rowId);
await cap('It went out', 'Mark it live and paste the link.', 1200);
await p.evaluate(id => pgChannel(id, 'igReel', 'live'), row); await wait(900);
await fill('#pgUrl', 'https://www.instagram.com/reel/anna-nagar');
await click('#pgSave', 1500);
await cap('Live', 'The board card moves to Live by itself; the Editor view shows the Reel as Posted for a week.', 3200);

// ── Monitoring ──
await title('<i>Every day</i><br>Monitoring', 'Where is everything, who is waiting on whom, what is late — at a glance.', 3600);
await nav('Board', () => toggleView('board', true));
await p.locator('.tk-card[data-id="pA"]').scrollIntoViewIfNeeded().catch(() => {}); await wait(900);
await point('.tk-card[data-id="pA"]').catch(() => {}); await ring('.tk-card[data-id="pA"]', 0);
await cap('The journey, recorded', 'Details → booked → shot → edited → V/O → posted → Live. Every step is on the card’s timeline.', 3600);
await p.evaluate(() => window.__ring());
await p.locator('.tk-card[data-id="pB"]').scrollIntoViewIfNeeded().catch(() => {}); await wait(900);
await ring('.tk-card[data-id="pB"]', 0);
await cap('Late and stuck', 'A red edge: sitting longer than the stage should take. A red ⚠ line: what is stuck — no address, owner not told, photos missing.', 4200);
await p.evaluate(() => window.__ring());
await nav('Editor', () => toggleView('editor'));
await p.evaluate(() => { localStorage.setItem('track.sheetOpen', '1'); const d = document.querySelector('.sh-wrap'); if (d && !d.open) { d.open = true; d.dispatchEvent(new Event('toggle')); } }); await wait(900);
await p.evaluate(() => { const d = document.querySelector('.sh-wrap'); if (d) d.scrollIntoView({ block: 'start', behavior: 'smooth' }); }); await wait(1300);
await ring('.sh-wrap', 0);
await cap('Property sheet', 'Every shot property, outlet by outlet: edited or not, its V/O, posted — below the Editor view and Posting.', 4400);
await p.evaluate(() => { window.__ring(); window.scrollTo({ top: 0, behavior: 'smooth' }); }); await wait(900);
await ring('.ed-bar', 0);
await cap('Filters for the day', 'Person: one editor’s (or Swami’s) work. Checklist: edits planned without a post, posts without an edit, V/Os.', 4000);
await p.evaluate(() => window.__ring());
await cap('Settings → Configurations', 'Who the editors are, who makes voice-overs, delivery defaults, stage targets and tags — set once for the team.', 3800);

// ── Who does what ──
await title('Who does what', '<b style="color:#fff">Agent</b> — completes details, books the shoot, tells the owner<br><b style="color:#fff">Shooter</b> — shoots, ticks Shoot done, pastes the Drive folder<br><b style="color:#fff">Editor</b> — plans, edits, asks for the V/O, Edit done<br><b style="color:#fff">Swami</b> — voice-overs, from his Daily task<br><b style="color:#fff">Posting</b> — schedules, marks posts live with the link<br><br><i>The board moves the cards by itself — everyone sees where everything stands.</i>', 9000);

await ctx.close();
await browser.close();
const raw = readdirSync(VIDEO_DIR).find(f => f.endsWith('.webm'));
const dest = join(OUT, 'shoot-media-demo.webm');
rmSync(dest, { force: true });
renameSync(join(VIDEO_DIR, raw), dest);
rmSync(VIDEO_DIR, { recursive: true, force: true });
console.log('Video:', dest);
