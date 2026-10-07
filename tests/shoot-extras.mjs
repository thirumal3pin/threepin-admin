// Listing detail → Shoot: Voice (shot with voice / voice-over separately + "made"),
// and "Shoot for" (Instagram / YouTube / Collab, planned + done). Runs the real board
// with firebase-sync stubbed, and checks what is saved and what the tile warns about.
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ST = defaultStages(), sid = k => ST.find(s => s.key === k).id, T = 't';
const L = [{ id: 'v1', tenantId: T, title: 'Villa', location: 'ECR', stageId: sid('shoot_done'), media: { photos: true, floorPlan: true }, photosLink: 'https://drive.google.com/x', createdAt: Date.now() - 1e8, updatedAt: Date.now(), stageChangedAt: Date.now() }];
const STUB = `window.__saved=[];window.trackFirebase={saveListing:async l=>{window.__saved.push(JSON.parse(JSON.stringify(l)))},getInventory:async()=>(window.__inv||[]),getPropertyInternalNotes:async()=>'',getListingHistory:async()=>[],saveHistory:async()=>{},savePipeline:async()=>{},patchLead:async()=>{},savePosting:async()=>{}};
window.trackAuth={login:async()=>{},logout:async()=>{},getTenantId:()=>'t'};
setTimeout(()=>{window.onTrackAuthChange({email:'a@x'},'t');window.applyTrackPipelineSnapshot(${JSON.stringify(ST)});window.applyListingsSnapshot(${JSON.stringify(L)});window.applyTrackLeadsSnapshot([]);window.applyPostingSnapshot([]);window.__ready=true},0);`;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 950 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.route('**/*', r => {
  const u = new URL(r.request().url());
  if (u.hostname !== 'track.local') return r.abort();
  if (u.pathname === '/track-assets/firebase-sync.js') return r.fulfill({ contentType: 'text/javascript', body: STUB });
  const f = join(ROOT, decodeURIComponent(u.pathname));
  return existsSync(f)
    ? r.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(f)] || 'application/octet-stream', body: readFileSync(f) })
    : r.fulfill({ status: 404, body: '' });
});
await p.goto('http://track.local/propertytrack.html');
await p.waitForFunction(() => window.__ready); await p.waitForTimeout(300);
await p.evaluate(() => openDetail('v1')); await p.waitForTimeout(200);

let fails = 0;
const ok = (l, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : '  FAIL ') + l + (c ? '' : ' — ' + d)); };
const last = () => p.evaluate(() => window.__saved[window.__saved.length - 1]);
const tile = () => p.$eval('.tk-card[data-id="v1"]', c => c.textContent);
const settle = () => p.waitForTimeout(150);

console.log('Voice');
ok('starts Not decided, no voice-over tick', await p.$eval('.tk-voice select', s => s.value) === '' && !(await p.$('label:has-text("Voice-over made")')));
await p.selectOption('.tk-voice select', 'vo'); await settle();
ok('Voice-over separately: saved, and "Voice-over made" appears', (await last()).voice === 'vo' && !!(await p.$('label:has-text("Voice-over made")')));
ok('…the tile says voice-over not made', /voice-over not made/.test(await tile()));
await p.check('label:has-text("Voice-over made") input'); await settle();
ok('ticking it saves and clears the tile warning', (await last()).voDone === true && !/voice-over not made/.test(await tile()));
await p.selectOption('.tk-voice select', 'live'); await settle();
ok('Shot with voice: the voice-over tick goes and is reset', (await last()).voice === 'live' && (await last()).voDone === false && !(await p.$('label:has-text("Voice-over made")')));

console.log('Shoot for');
const rows = await p.$$eval('#dpFor .tk-brief-r', r => r.map(x => x.textContent.trim()));
ok('lists Instagram, YouTube, Collab', rows.length === 3 && /Instagram/.test(rows[0]) && /YouTube/.test(rows[1]) && /Collab/.test(rows[2]), JSON.stringify(rows));
await p.check('#dpFor input[aria-label="Instagram planned"]'); await settle();
await p.check('#dpFor input[aria-label="YouTube planned"]'); await settle();
const s = await last();
ok('several can be planned at once', s.forPlan.insta && s.forPlan.yt && !s.forPlan.collab);
ok('…the tile says what is still to make', /Instagram \+ YouTube not done/.test(await tile()));
await p.check('#dpFor input[aria-label="Instagram done"]'); await settle();
ok('Done ticks; the tile narrows to what is left', (await last()).forDone.insta && /YouTube not done/.test(await tile()) && !/Instagram/.test(await p.$eval('.tk-card[data-id="v1"] .tk-blockers', c => c.textContent)));
await p.check('#dpFor input[aria-label="Collab done"]'); await settle();
ok('ticking Done on something not planned plans it too', (await last()).forPlan.collab && (await last()).forDone.collab);
await p.uncheck('#dpFor input[aria-label="YouTube planned"]'); await settle();
const blk = () => p.$eval('.tk-card[data-id="v1"] .tk-blockers', c => c.textContent).catch(() => '');
ok('un-planning clears its Done and its warning — only the brochure is left', !(await last()).forPlan.yt && !(await last()).forDone.yt && (await blk()).trim() === 'no brochure', await blk());

console.log('Media ready');
const stageOf = () => p.evaluate(() => window.trackApi.listings().find(l => l.id === 'v1').stageId);
const colOf = () => p.$eval('.tk-card[data-id="v1"]', c => c.closest('.tk-col').querySelector('.tk-col-title').textContent);
ok('the column sits between Shoot done and Live', (await p.$$eval('.tk-col-title', t => t.map(e => e.textContent))).join('|').includes('Shoot done|Media ready|Live'));
ok('with the brochure still missing, the listing stays in Shoot done', await stageOf() === 'shoot_done');
await p.evaluate(() => window.trackApi.mutate('v1', x => { x.brochure = { ...(x.brochure || {}), doneAt: Date.now() }; }, 'Brochure created')); await settle();
ok('the brochure was the last thing → it moves to Media ready by itself', await stageOf() === 'media_ready' && await colOf() === 'Media ready', await stageOf());
ok('…said in a toast and in its history', /Media ready/.test(await p.$eval('#toast', t => t.textContent).catch(() => '')) && /automatically, everything the shoot was for is done/.test((await last()).lastEvent.text), (await last()).lastEvent.text);
ok('…with no warnings on the tile', !(await blk()));
await p.evaluate(() => setMedia('v1', 'floorPlan', false)); await settle();
ok('unticking something later keeps it in Media ready, and the tile says what went missing', await stageOf() === 'media_ready' && /1 of 2 media missing/.test(await blk()), await blk());
await p.evaluate(() => setMedia('v1', 'floorPlan', true)); await settle();
ok('…ticked again, the warning goes', await stageOf() === 'media_ready' && !(await blk()));
await p.evaluate(() => changeStage('v1', 'shoot_done')); await settle();
await p.evaluate(() => window.applyListingsSnapshot(window.trackApi.listings())); await settle();
ok('moved back to Shoot done by hand, it stays there (no bouncing back)', await stageOf() === 'shoot_done');
await p.evaluate(() => window.trackApi.mutate('v1', x => { x.remarks = 'reshoot the balcony'; }, 'Remarks edited')); await settle();
ok('…a note or remark on it does not send it forward again', await stageOf() === 'shoot_done');
await p.evaluate(() => setMedia('v1', 'floorPlan', false)); await settle();
await p.evaluate(() => setMedia('v1', 'floorPlan', true)); await settle();
ok('…finishing the last missing piece again does move it on', await stageOf() === 'media_ready');
const saved1 = await last();
ok('the milestone is saved as reached.media_ready (a nested date, not a dotted field name)', typeof (saved1.reached || {}).media_ready === 'number' && !Object.keys(saved1).some(k => k.startsWith('reached.')), JSON.stringify(Object.keys(saved1)));
await p.evaluate(() => { changeStage('v1', 'shoot_scheduled'); }); await settle();
await p.evaluate(() => { changeStage('v1', 'shoot_done'); }); await settle();
ok('brought forward into Shoot done with everything in hand → straight on to Media ready', await stageOf() === 'media_ready');
await p.evaluate(() => { changeStage('v1', 'shoot_done'); window.trackApi.mutate('v1', x => { x.brochure = { ...x.brochure, doneAt: null, unlockedAt: Date.now(), unlockedLink: '' }; }, 'Brochure details unlocked for a redo'); }); await settle();
ok('a brochure unlocked for a redo no longer counts: no ✓ on the tile, and it is not promoted', await stageOf() === 'shoot_done' && !/Brochure ✓/.test(await tile()) && /no brochure/.test(await blk()), await tile());
await p.evaluate(() => window.trackApi.mutate('v1', x => { x.brochure = { ...x.brochure, doneAt: Date.now() }; }, 'Brochure created')); await settle();
ok('…redone, it counts again and the listing moves on', await stageOf() === 'media_ready' && /Brochure ✓/.test(await tile()));
await p.evaluate(() => { changeStage('v1', 'shoot_done'); setMedia('v1', 'photos', false); changeStage('v1', 'media_ready'); }); await settle();
ok('moved into Media ready by hand with gaps: allowed, and the toast says what is missing', await stageOf() === 'media_ready' && /still missing: 1 of 2 media missing/.test(await p.$eval('#toast', t => t.textContent)), await p.$eval('#toast', t => t.textContent));

console.log('The brochure arriving from the pipeline');
const R = { id: 'v3', tenantId: T, title: 'Linked flat', stageId: 'shoot_done', propertyCode: 'EGM0001', media: { photos: true, floorPlan: true }, photosLink: 'https://drive.google.com/z', brochure: { code: 'EGM0001', requestedAt: Date.now() - 3600000, requestedCode: 'EGM0001' }, createdAt: 1, updatedAt: 1, stageChangedAt: 1 };
await p.evaluate(r => { window.__inv = [{ id: 'EGM0001', propertyCode: 'EGM0001', name: 'Egmore 3BHK', brochureLink: '' }]; window.applyListingsSnapshot([...window.trackApi.listings(), r]); }, R); await settle();
const v3 = () => p.evaluate(() => window.trackApi.listings().find(l => l.id === 'v3'));
ok('brochure requested, not delivered: waits in Shoot done', (await v3()).stageId === 'shoot_done');
await p.evaluate(() => { window.__inv = [{ id: 'EGM0001', propertyCode: 'EGM0001', name: 'Egmore 3BHK', brochureLink: 'https://drive.google.com/file/d/egm' }]; window.bpReconcile(true); }); await p.waitForTimeout(500);
ok('delivered (the usual last piece): ticked done AND moved to Media ready by itself', !!(await v3()).brochure.doneAt && (await v3()).stageId === 'media_ready', JSON.stringify((await v3()).stageId));
await p.evaluate(() => changeStage('v3', 'on_hold', { reason: 'owner_postponed' })); await settle();
await p.evaluate(() => changeStage('v3', 'shoot_done')); await settle();
ok('back from On hold into Shoot done with everything in hand: moves on to Media ready', (await v3()).stageId === 'media_ready');
await p.evaluate(() => changeStage('v3', 'shoot_done')); await settle();
ok('moved back by hand from Media ready: held in Shoot done', (await v3()).stageId === 'shoot_done' && (await v3()).heldBack === true);
await p.evaluate(() => window.bpReconcile(true)); await p.waitForTimeout(400);
await p.evaluate(() => window.trackApi.mutate('v3', x => { x.remarks = 'second look'; })); await settle();
ok('…a reconcile or a remark does not release it', (await v3()).stageId === 'shoot_done');
await p.evaluate(() => window.trackApi.mutate('v3', x => { x.brochure = { ...x.brochure, doneAt: null, unlockedAt: Date.now(), unlockedLink: 'https://drive.google.com/file/d/egm' }; }, 'Brochure details unlocked for a redo')); await settle();
await p.evaluate(() => window.trackApi.mutate('v3', x => { x.brochure = { ...x.brochure, requestedAt: Date.now(), requestedCode: 'EGM0001' }; }, 'Brochure requested')); await settle();
ok('held, brochure unlocked and asked for again: still waits', (await v3()).stageId === 'shoot_done');
await p.evaluate(() => { window.__inv = [{ id: 'EGM0001', propertyCode: 'EGM0001', name: 'Egmore 3BHK', brochureLink: 'https://drive.google.com/file/d/egm-v2' }]; window.bpReconcile(true); }); await p.waitForTimeout(500);
ok('…the new brochure arriving (the last missing piece) releases it to Media ready', (await v3()).stageId === 'media_ready' && !(await v3()).heldBack, JSON.stringify({ s: (await v3()).stageId, h: (await v3()).heldBack, d: (await v3()).brochure.doneAt }));
await p.evaluate(() => changeStage('v3', 'shoot_done')); await settle();
await p.evaluate(() => { openEditModal('v3'); document.getElementById('mm_propertyCode').value = ''; saveModal(); }); await p.waitForTimeout(400);
const un = await v3();
ok('unlinked in Edit: the old property\'s brochure goes with it (no ✓, link cleared, not locked)', !un.propertyCode && !un.brochure.doneAt && !un.brochureLink && !/Brochure ✓/.test(await p.$eval('.tk-card[data-id="v3"]', c => c.textContent)), JSON.stringify({ pc: un.propertyCode, b: un.brochure, bl: un.brochureLink }));

const U = { id: 'v4', tenantId: T, title: 'Unmap me', stageId: 'details', propertyCode: 'EGM0001', brochureLink: 'https://drive.google.com/file/d/egm-v2', brochure: { code: 'EGM0001', requestedAt: Date.now() - 60000, requestedCode: 'EGM0001', doneAt: Date.now() }, createdAt: 1, updatedAt: 1, stageChangedAt: 1 };
await p.evaluate(u => window.applyListingsSnapshot([...window.trackApi.listings(), u]), U); await settle();
await p.evaluate(() => { openMapProperty('v4'); pickProperty(''); }); await settle();
await p.evaluate(() => window.bpReconcile(true)); await p.waitForTimeout(500);
const v4 = await p.evaluate(() => window.trackApi.listings().find(l => l.id === 'v4'));
ok('"✕ Unmap" stays unmapped (the background check does not link it back) and drops the old brochure', !v4.propertyCode && !v4.brochure.doneAt && !v4.brochure.requestedAt && !v4.brochureLink, JSON.stringify(v4.brochure));

console.log('An existing board');
const OLD = ST.filter(s => s.key !== 'media_ready').map((s, i) => ({ ...s, order: i }));
const DONE = { id: 'v2', tenantId: T, title: 'Ready flat', stageId: 'shoot_done', media: { photos: true, floorPlan: true }, photosLink: 'https://drive.google.com/y', brochure: { doneAt: Date.now() }, createdAt: 1, updatedAt: 1, stageChangedAt: 1 };
await p.evaluate(d => window.applyListingsSnapshot([...window.trackApi.listings(), d]), DONE); await settle();
ok('a complete listing arriving by snapshot is not moved by this tab (whoever changed it did that)', await p.evaluate(() => window.trackApi.listings().find(l => l.id === 'v2').stageId) === 'shoot_done');
await p.evaluate(old => { window.__pipes = []; window.trackFirebase.savePipeline = async s => { window.__pipes.push(s); }; window.applyTrackPipelineSnapshot(old); }, OLD); await settle();
const saved = await p.evaluate(() => window.__pipes[0]);
ok('a board saved without Media ready gains it after Shoot done, and is saved once', saved && saved.map(s => s.name).join('|').includes('Shoot done|Media ready|Live') && saved.every((s, i) => s.order === i), JSON.stringify(saved && saved.map(s => s.name)));
await p.evaluate(s => window.applyTrackPipelineSnapshot(s), saved); await settle();
ok('…and a board that has it is not saved again', await p.evaluate(() => window.__pipes.length) === 1);
ok('when the column is added, listings already complete in Shoot done move into it once', await p.evaluate(() => window.trackApi.listings().find(l => l.id === 'v2').stageId) === 'media_ready');

ok('no page errors', !errs.length, errs.join(' | '));
await b.close();
if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
console.log('\nAll shoot-extras checks passed');
