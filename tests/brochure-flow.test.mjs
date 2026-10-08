import fs from 'node:fs';
// Brochure from a listing — the rules, under the situations a property manager actually meets.
//   node tests/brochure-flow.test.mjs
import {
  codeKey, normCode, looksLikeCode, isUrl, findCode, similarCodes, codeSuggestions,
  fillFromProperty, brochureCheck, brochureTitle, brochureState, reconcileBrochures, listingCode, isLocked, FORM_ACTION, FORM_FIELDS, formBody,
  awaitingBrochure, recordFetched, unmapPatch, queueEntryFor, takenMessage
} from '../track-assets/brochure-flow.js';

let failed = 0;
const check = (l, c, d) => { if (!c) { failed++; console.log('  FAIL  ' + l + (d !== undefined ? ' — ' + d : '')); } };
const eq = (l, a, b) => check(l, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = n => console.log('\n── ' + n);
const NOW = 1789000000000;

const INV = [
  { id: 'THVA001', propertyCode: 'THVA001', name: 'LUX 49 - Manvi Homes', location: 'Thiruvanmiyur', config: '4BHK', startingPrice: '₹5.50 Cr', photosLink: 'https://drive.google.com/drive/folders/lux', brochureLink: 'THVA001_LUX49.pdf', detailsText: 'Ultra-luxury boutique living' },
  { id: 'EGM0001', propertyCode: 'EGM0001', name: 'Egmore 3BHK', location: 'Egmore', photosLink: 'https://drive.google.com/drive/folders/egm', brochureLink: 'https://drive.google.com/file/d/egm', detailsText: 'Egmore details' },
  { id: 'EGM0002', propertyCode: 'EGM0002', name: 'Egmore Villa', location: 'Egmore' },
  { id: 'TNAG0002', propertyCode: 'TNAG0002', name: 'T Nagar 2BHK' },
  { id: '17', propertyCode: '', name: 'Old listing, no code' },
  { id: '44', propertyCode: '44', name: 'Older numeric id' }
];

console.log('3 PIN Realty — brochure from a listing');

section('Codes are compared the way people type them');
check('Case, spaces and dashes do not matter', codeKey(' thva-001 ') === 'THVA001' && codeKey('THVA 001') === 'THVA001');
check('Written down in capitals, no spaces', normCode(' egm 0001 ') === 'EGM0001');
check('A proper code loses its dash too (the pipeline files THVA001)', normCode('thva-001') === 'THVA001');
check('Something that is not a code is only tidied, not rewritten', normCode('12 / 34') === '12/34');
check('Letters then digits is a code', looksLikeCode('TNAG0002') && looksLikeCode('thva001'));
check('Not a code: digits only, letters only, empty', !looksLikeCode('44') && !looksLikeCode('ABC') && !looksLikeCode(''));
check('A bare file name is not a link', !isUrl('THVA001_LUX49.pdf') && isUrl('https://drive.google.com/file/d/x'));

section('Typing a code that already exists');
const f1 = findCode('egm0001', INV, [], 'me');
check('Found in the dashboard, whatever the case', f1.inventory && f1.inventory.id === 'EGM0001');
check('Not claimed by another listing yet', f1.listing === null);
const lst = [{ id: 'L1', title: 'Villa', propertyCode: 'EGM0002' }, { id: 'L2', title: 'Plot', brochure: { code: 'NEW0009', requestedAt: NOW } }];
check('Claimed by another listing (mapped)', findCode('EGM0002', INV, lst, 'me').listing.id === 'L1');
check('Claimed by another listing (brochure asked for, not yet in the dashboard)', findCode('new 0009', INV, lst, 'me').listing.id === 'L2');
check('A listing does not clash with itself', findCode('EGM0002', INV, lst, 'L1').listing === null);
check('Older numeric ids never match a typed code', findCode('44', INV, [], 'me').inventory === null);
check('Nothing typed, nothing found', findCode('', INV, lst, 'me').inventory === null);

section('Near-misses — the THVA0001 / THVA001 slip');
eq('An extra zero is caught', similarCodes('THVA0001', INV).map(p => p.propertyCode), ['THVA001']);
eq('A missing zero is caught', similarCodes('TNAG002', INV).map(p => p.propertyCode), ['TNAG0002']);
eq('Two letters swapped, same number, is caught', similarCodes('TNGA0002', INV).map(p => p.propertyCode), ['TNAG0002']);
eq('A letter left out, same number, is caught', similarCodes('THV001', INV).map(p => p.propertyCode), ['THVA001']);
eq('The next number in a series is a new property, not a slip', similarCodes('TNAG0003', INV), []);
eq('…nor is THVA002 after THVA001', similarCodes('THVA002', INV), []);
eq('…nor EGM0003 after EGM0001 and EGM0002', similarCodes('EGM0003', INV), []);
eq('A letter slip with a different number is not a near-miss', similarCodes('TNGA0003', INV), []);
eq('The exact code is not its own near-miss', similarCodes('THVA001', INV).map(p => p.propertyCode), []);
eq('A genuinely new code has none', similarCodes('ADYR0001', INV), []);
eq('Garbage has none', similarCodes('hello', INV), []);

section('Suggestions while typing');
eq('Prefix first, A–Z', codeSuggestions('egm', INV).map(p => p.propertyCode), ['EGM0001', 'EGM0002']);
eq('Then codes that contain it', codeSuggestions('001', INV).map(p => p.propertyCode), ['EGM0001', 'THVA001']);
eq('Old numeric ids are never suggested', codeSuggestions('4', INV).map(p => p.propertyCode), []);
eq('Nothing typed, nothing suggested', codeSuggestions('', INV), []);

section('Linking fills the blanks, never what was typed by hand');
const typed = { title: 'Egmore flat (owner wording)', photosLink: '', description: '', location: 'Egmore West' };
const fp = fillFromProperty(typed, INV[1], 'Owner: call after 6pm');
check('Hand-typed title and location are kept', !('title' in fp.patch) && !('location' in fp.patch));
check('Description comes from the dashboard', fp.patch.description === 'Egmore details');
check('Photos and brochure links come across', fp.patch.photosLink === INV[1].photosLink && fp.patch.brochureLink === INV[1].brochureLink);
check('Internal notes come across when blank', fp.patch.internalNotes === 'Owner: call after 6pm');
check('…and the fields are named for the toast', fp.filled.includes('Description') && fp.filled.includes('Brochure'));
const lux = fillFromProperty({ title: 'New listing' }, INV[0], '');
check('"New listing" placeholder title is replaced', lux.patch.title === 'LUX 49 - Manvi Homes');
check('A bare brochure file name is NOT copied as a link', !('brochureLink' in lux.patch));
check('A photos link typed on the listing is never replaced by the dashboard\'s', !('photosLink' in fillFromProperty({ photosLink: 'https://drive.google.com/drive/folders/mine' }, INV[1], '').patch));
const rc = reconcileBrochures([{ id: 'P', propertyCode: 'EGM0001', title: 'x', photosLink: 'https://drive.google.com/drive/folders/mine', brochure: { doneAt: NOW } }], INV, NOW);
check('…and a reconcile leaves it alone too', !rc.some(u => 'photosLink' in u.patch), JSON.stringify(rc));
const rcFill = reconcileBrochures([{ id: 'Q', propertyCode: 'EGM0001', title: 'x', brochure: { doneAt: NOW } }], INV, NOW);
check('What a reconcile fills in is said in the timeline', rcFill.length === 1 && /Filled from the dashboard: .*photos link/.test(rcFill[0].history || ''), JSON.stringify(rcFill));
const evil = [{ id: 'X1', propertyCode: 'ABCD0001<img src=x onerror=alert(1)>', brochureLink: '' }];
const rcEvil = reconcileBrochures([{ id: 'E', brochure: { code: evil[0].propertyCode, requestedAt: NOW, requestedCode: evil[0].propertyCode } }], evil, NOW);
check('A code from the dashboard is escaped in the timeline', rcEvil.length === 1 && !/<img/.test(rcEvil[0].history) && /&lt;img/.test(rcEvil[0].history), JSON.stringify(rcEvil));
check('A request that never landed stops being waited for after two days', awaitingBrochure({ brochure: { requestedAt: NOW } }, NOW + 47 * 3600000) && !awaitingBrochure({ brochure: { requestedAt: NOW } }, NOW + 49 * 3600000));
check('Existing internal notes are not replaced', !('internalNotes' in fillFromProperty({ internalNotes: 'mine' }, INV[1], 'theirs').patch));

section('Ready to generate?');
const good = { id: 'L9', title: '4BHK Kottivakkam', photosLink: 'https://drive.google.com/drive/folders/k', description: 'Villa near ECR', brochure: { code: 'KOTV0007' } };
eq('All four in place: ready', brochureCheck(good, INV, []).ok, true);
eq('Each missing piece is named', brochureCheck({ id: 'x', title: 'New listing' }, INV, []).missing, ['Property code', 'Title', 'Photos link', 'Description']);
check('A malformed code is refused', brochureCheck({ ...good, brochure: { code: '12345' } }, INV, []).missing.some(m => /letters, then numbers/.test(m)));
check('A non-link photos field is refused', brochureCheck({ ...good, photosLink: 'see whatsapp' }, INV, []).missing.some(m => /https/.test(m)));
check('A code already in the dashboard (not linked) is refused with the way out', brochureCheck({ ...good, brochure: { code: 'egm0001' } }, INV, []).missing.some(m => /Link to EGM0001/.test(m)));
check('…but fine once the listing IS linked to it', brochureCheck({ ...good, propertyCode: 'EGM0001', brochure: {} }, INV, []).ok);
check('A code another listing uses is refused', brochureCheck({ ...good, brochure: { code: 'NEW0009' } }, INV, lst).missing.some(m => /already used by “Plot”/.test(m)));
check('A near-miss warns but does not block', (() => { const r = brochureCheck({ ...good, brochure: { code: 'THVA0001' } }, INV, []); return r.ok && r.warnings.some(w => /THVA001/.test(w)); })());
check('A non-Drive photos link warns', brochureCheck({ ...good, photosLink: 'https://dropbox.com/x' }, INV, []).warnings.some(w => /Drive/.test(w)));

section('What goes to the form');
eq('"CODE - Title", code tidied', brochureTitle({ title: '4BHK Kottivakkam', brochure: { code: 'kotv 0007' } }), 'KOTV0007 - 4BHK Kottivakkam');
eq('Mapped code wins over the draft code', listingCode({ propertyCode: 'EGM0001', brochure: { code: 'X1' } }), 'EGM0001');

section('Where the brochure stands');
eq('Nothing yet', brochureState({}, INV), 'none');
eq('Asked for, property not in the dashboard yet', brochureState({ brochure: { code: 'NEW1', requestedAt: NOW } }, INV), 'requested');
eq('Built (file name on the sheet) but not delivered', brochureState({ brochure: { code: 'THVA001', requestedAt: NOW } }, INV), 'building');
eq('Delivered link on the dashboard property', brochureState({ propertyCode: 'EGM0001' }, INV), 'ready');
eq('Delivered link on the listing itself', brochureState({ brochureLink: 'https://drive.google.com/file/d/1' }, INV), 'ready');

section('After asking: linking and ticking done on their own');
const asked = [
  { id: 'A', title: 'Egmore flat', brochure: { code: 'egm0001', requestedAt: NOW - 1e6 } },       // now in the dashboard, delivered
  { id: 'B', title: 'LUX', brochure: { code: 'THVA001', requestedAt: NOW - 1e6 } },                // in the dashboard, not delivered
  { id: 'C', title: 'New plot', brochure: { code: 'ADYR0001', requestedAt: NOW - 1e6 } },          // not there yet
  { id: 'D', title: 'Mapped long ago', propertyCode: 'EGM0001', location: 'Egmore', description: 'x', photosLink: 'https://drive.google.com/drive/folders/egm', brochureLink: 'https://drive.google.com/file/d/egm', brochure: { doneAt: NOW - 9e9 } },  // already done, fully filled
  { id: 'E', title: 'Typed code, never asked', brochure: { code: 'EGM0002' } }                    // must not be linked silently
];
// D holds EGM0001, which A asks for — one property, one listing — so D is checked on its own.
const r = reconcileBrochures(asked.filter(x => x.id !== 'D'), INV, NOW);
const A = r.find(u => u.id === 'A'), B = r.find(u => u.id === 'B');
check('Delivered: linked to the code', A && A.patch.propertyCode === 'EGM0001');
check('…brochure link and photos pulled in', A.patch.brochureLink === INV[1].brochureLink && A.patch.photosLink === INV[1].photosLink);
check('…and marked done, with a note for the timeline', A.patch.brochure.doneAt === NOW && /marked done/.test(A.history));
check('Built but not delivered: linked, NOT marked done', B && B.patch.propertyCode === 'THVA001' && !B.patch.brochure);
check('Not in the dashboard yet: left alone', !r.some(u => u.id === 'C'));
check('Already done: not touched again', !reconcileBrochures(asked.filter(x => x.id === 'D'), INV, NOW).length);
check('A code typed but never sent is not touched at all — no link, no photos copied in', !r.some(u => u.id === 'E'));
eq('Running it again changes nothing', reconcileBrochures(asked.filter(x => x.id !== 'D').map(x => { const u = r.find(y => y.id === x.id); return u ? { ...x, ...u.patch } : x; }), INV, NOW + 1), []);
{
  // The "duplicate — use a different code" case: typing or picking a code that already has a
  // delivered brochure must not copy that property in and freeze the panel as created.
  const typedDup = { id: 'F', title: 'My own flat', brochure: { code: 'EGM0001' } };
  eq('A typed code with a delivered brochure: nothing copied, not marked done', reconcileBrochures([typedDup], INV, NOW), []);
  check('…the panel stays editable and does not claim that brochure', !isLocked(typedDup, INV) && brochureState(typedDup, INV) === 'none');
  const moved = { id: 'G', title: 'Plot', brochure: { code: 'EGM0002', requestedCode: 'KOTV0007', requestedAt: NOW - 1e6 } };
  eq('Asked for under one code, a different code typed since: not linked to the typed one', reconcileBrochures([moved], INV, NOW), []);
  const unlinked = { id: 'H', title: 'Was EGM0001', brochure: { code: '', requestedCode: 'EGM0001', requestedAt: NOW - 1e6 } };
  eq('Unlinked in Edit after asking (code cleared): not linked back', reconcileBrochures([unlinked], INV, NOW), []);
  const OLD = [...INV, { id: '123', propertyCode: '123', name: 'Older property', brochureLink: 'https://drive.google.com/file/d/123' }];
  const numeric = reconcileBrochures([{ id: 'I', title: 'Old', propertyCode: '123' }], OLD, NOW);
  check('Linked to an older property with a bare-number id: kept in step like any other', numeric.length === 1 && numeric[0].patch.brochure.doneAt === NOW);
  eq('…but a bare number merely typed is never matched', reconcileBrochures([{ id: 'J', brochure: { code: '123', requestedAt: NOW } }], OLD, NOW), []);
}

section('Re-reading the dashboard only while a brochure is on its way');
check('Asked for, not in yet: waiting', awaitingBrochure({ brochure: { requestedAt: NOW } }, NOW + 60000));
check('Linked, never asked: not waiting', !awaitingBrochure({ propertyCode: 'EGM0001', brochure: { code: 'EGM0001' } }, NOW + 60000));
check('Asked for and delivered: not waiting', !awaitingBrochure({ brochureLink: 'https://drive.google.com/file/d/1', brochure: { requestedAt: NOW } }, NOW + 60000));
check('Done: not waiting', !awaitingBrochure({ brochure: { requestedAt: NOW, doneAt: NOW } }, NOW + 60000));
check('A redo asked for after unlocking: waiting, though the old link is still there', awaitingBrochure({ brochureLink: 'https://drive.google.com/file/d/1', brochure: { requestedAt: NOW + 5, unlockedAt: NOW } }, NOW + 60000));
check('Unlocked, redo not asked for yet: not waiting', !awaitingBrochure({ brochureLink: 'https://drive.google.com/file/d/1', brochure: { requestedAt: NOW - 5, unlockedAt: NOW } }, NOW + 60000));

section('Locked once created; unlocking for a redo');
{
  const delivered = { id: 'U', propertyCode: 'EGM0001', brochureLink: INV[1].brochureLink, brochure: { doneAt: NOW } };
  check('Done: locked', isLocked(delivered, INV));
  check('Delivered link but never ticked: still locked', isLocked({ propertyCode: 'EGM0001' }, INV));
  check('Asked for, not delivered: editable', !isLocked({ brochure: { code: 'NEW1', requestedAt: NOW } }, INV));
  const unlocked = { ...delivered, brochure: { doneAt: null, unlockedAt: NOW, unlockedLink: INV[1].brochureLink } };
  check('Unlocked: editable even though the old brochure is still there', !isLocked(unlocked, INV));
  check('…and the background check does not re-tick it for the OLD brochure', !reconcileBrochures([unlocked], INV, NOW + 1).some(u => u.patch.brochure && u.patch.brochure.doneAt));
  const NEWINV = INV.map(p => p.propertyCode === 'EGM0001' ? { ...p, brochureLink: 'https://drive.google.com/file/d/egm-v2' } : p);
  check('A NEW brochure delivered after the redo: locked again', isLocked(unlocked, NEWINV));
  check('…and the background check ticks it', reconcileBrochures([unlocked], NEWINV, NOW + 2).some(u => u.patch.brochure && u.patch.brochure.doneAt === NOW + 2));
}

section('Same form as the Create brochure page');
{
  const page = fs.readFileSync(new URL('../dashboard-assets/brochure-form.js', import.meta.url), 'utf8');
  check('Same form address', page.includes(FORM_ACTION));
  check('Same field ids', Object.values(FORM_FIELDS).every(id => page.includes(id)));
  const b = formBody({ title: 'Villa', brochure: { code: 'kotv0007' }, photosLink: 'https://drive.google.com/x', description: 'Desc', internalNotes: '' });
  check('Title goes as CODE - Title', b.get(FORM_FIELDS.title) === 'KOTV0007 - Villa');
  check('Empty internal notes are not sent (no blank Queue cell)', !b.has(FORM_FIELDS.internal));
  check('A code typed with a dash goes as the pipeline files it', formBody({ title: 'Villa', brochure: { code: 'thva-001' } }).get(FORM_FIELDS.title) === 'THVA001 - Villa');
}

section('Unmapping takes back what the mapping brought — and only that');
{
  const P = { propertyCode: 'VLCA003', name: 'Velachery 2BHK', detailsText: 'From the dashboard', photosLink: 'https://drive.google.com/p' };
  // Mapped with a typed title and description; the mapping filled photos and internal notes.
  const before = { title: 'Anna Nagar', description: 'Typed by me', photosLink: '', internalNotes: '' };
  const fetched = recordFetched(null, before, { photosLink: P.photosLink, internalNotes: 'Owner: Raman' });
  eq('Recorded: each filled field, with what it held before', fetched, { photosLink: { value: P.photosLink, was: '' }, internalNotes: { value: 'Owner: Raman', was: '' } });
  const x = { ...before, photosLink: P.photosLink, internalNotes: 'Owner: Raman', propertyCode: 'VLCA003', fetched, brochure: { code: 'VLCA003', doneAt: 5 } };
  const u = unmapPatch(x, P);
  eq('Not generated here: the fetched fields go, the typed ones stay', [u.patch.photosLink, u.patch.internalNotes, 'title' in u.patch, 'description' in u.patch], ['', '', false, false]);
  check('…the old property\'s brochure goes too, and the record is cleared', u.patch.brochureLink === '' && u.patch.fetched === null && u.brochure.doneAt === null);
  const edited = unmapPatch({ ...x, internalNotes: 'Owner: Raman — call after 6' }, P);
  check('A fetched field changed by hand since is theirs and stays', !('internalNotes' in edited.patch) && edited.patch.photosLink === '');
  const t = recordFetched(null, { title: 'New listing' }, { title: 'Velachery 2BHK' });
  eq('A title filled over "New listing" goes back to it', unmapPatch({ title: 'Velachery 2BHK', fetched: t }, P).patch.title, 'New listing');
  const gen = unmapPatch({ ...x, brochure: { code: 'VLCA003', requestedAt: 99 } }, P);
  check('Generated from this listing: every detail stays (only the code and the old brochure go)', !('photosLink' in gen.patch) && !('internalNotes' in gen.patch) && gen.patch.brochureLink === '' && gen.brochure.requestedAt === null);
  const legacy = unmapPatch({ title: 'Anna Nagar', description: 'From the dashboard', photosLink: P.photosLink, propertyCode: 'VLCA003' }, P);
  check('Mapped before fields were recorded: what is identical to the old property goes', legacy.patch.description === '' && legacy.patch.photosLink === '' && !('title' in legacy.patch));
  const again = recordFetched(fetched, { photosLink: P.photosLink }, { photosLink: 'https://drive.google.com/new' });
  eq('Filled again later (the dashboard changed it): still remembers what it held first', again.photosLink, { value: 'https://drive.google.com/new', was: '' });
}

section('Unmapping: what was typed is never taken, even when it matches the property');
{
  const P = { propertyCode: 'PRES0001', name: 'Prestige Lakeside', detailsText: 'Lake view', photosLink: 'https://drive.google.com/pres' };
  // Typed "Prestige Lakeside" and pasted its Drive link before mapping; the mapping only filled the location.
  const x = { title: 'Prestige Lakeside', photosLink: P.photosLink, location: 'Kelambakkam', propertyCode: 'PRES0001', fetched: recordFetched(null, { location: '' }, { location: 'Kelambakkam' }) };
  const u = unmapPatch(x, P);
  check('The typed title and pasted link stay; only the fetched location goes', !('title' in u.patch) && !('photosLink' in u.patch) && u.patch.location === '', JSON.stringify(u.patch));
  check('Mapping that filled nothing: nothing is taken', Object.keys(unmapPatch({ ...x, fetched: {} }, P).patch).sort().join() === 'brochureLink,fetched');
  const named = unmapPatch({ title: 'Prestige Lakeside', fetched: recordFetched(null, { title: '' }, { title: 'Prestige Lakeside' }) }, P);
  eq('A card that got its only name from the mapping is not left blank', named.patch.title, 'New listing');
  const cleared = recordFetched(recordFetched(null, { photosLink: 'mine' }, { photosLink: P.photosLink }), { photosLink: '' }, { photosLink: P.photosLink });
  eq('Cleared by a person, then filled again: unmapping goes back to their blank', cleared.photosLink.was, '');
}

section('One property, one seller, one listing');
{
  const INV1 = [{ id: 'EGM0001', propertyCode: 'EGM0001', brochureLink: 'https://drive.google.com/file/d/egm' }];
  const others = [{ id: 'A', title: 'Egmore flat', propertyCode: 'EGM0001' }, { id: 'B', title: 'Asked for it', brochure: { code: 'EGM0001', requestedCode: 'EGM0001', requestedAt: 5 } }];
  check('The message names the listing that has it', /already mapped to “Egmore flat”/.test(takenMessage('EGM0001', others[0])));
  eq('A brochure arriving for a property another listing has: not linked to it', reconcileBrochures(others, INV1, 10).filter(u => u.id === 'B' && u.patch.propertyCode), []);
}

section('The queue status for a listing');
{
  const LOG = [
    { title: 'KOTV0007 - Villa', at: 1000, status: { state: 'queued', label: 'In queue' } },
    { title: 'KOTV0007 - Villa', at: 5000, status: { state: 'generated', label: 'Generated — being sent' } },
    { title: 'EGM0001 - Egmore', at: 6000, status: { state: 'delivered', label: 'Delivered' } }
  ];
  eq('Asked for here: the newest entry for its code, not one from before it was asked', queueEntryFor({ brochure: { code: 'kotv0007', requestedAt: 4000 } }, LOG).at, 5000);
  check('…nothing from before the request', queueEntryFor({ brochure: { code: 'KOTV0007', requestedAt: 90000 } }, LOG) === null);
  eq('Mapped: the property\'s brochure asked for from the Create brochure page', queueEntryFor({ propertyCode: 'EGM0001' }, LOG).status.state, 'delivered');
  check('A code merely typed, never asked for: no status', queueEntryFor({ brochure: { code: 'EGM0001' } }, LOG) === null);
  check('No log yet: no status', queueEntryFor({ propertyCode: 'EGM0001' }, null) === null);
}

console.log(failed ? `\n${failed} failure(s)` : '\nAll good.');
process.exit(failed ? 1 : 0);
