// Series: several properties, shot one by one, edited into one video, posted as one post.
//   node tests/posting-series.test.mjs
import {
  blankTracker, normalizeTracker, newSeries, isSeries, cleanMembers, memberStatus, setMemberSource, setBrochureSource,
  seriesOf, seriesIndex, gaps, progress, overall, matchesFilter, setListing, setChannel, bulkSchedule, planRows, parsePlan,
  tasks, toCsv, mondayOf, addDays, changedPaths, isSeriesName
} from '../track-assets/posting.js';

let failed = 0;
const check = (label, cond, detail) => { if (!cond) { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
const eq = (l, a, b) => check(l, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const NOW = 1789000000000, H = 3600000, DAY = 24 * H;

console.log('3 PIN Realty — posting series');

// Three T Nagar properties: two tracked (one with photos, one with a brochure), one only in the dashboard.
const a = blankTracker({ propertyCode: 'TNAG0003', title: '3BHK T Nagar', photosLink: 'https://drive.google.com/a', details: 'x' }, NOW, 'a@x');
const b = { ...blankTracker({ propertyCode: 'TNAG0005', title: 'Studio T Nagar' }, NOW + 1, 'a@x'), brochure: { done: true, at: NOW, by: 'a@x' } };
const INV = [{ id: 'TNAG0007', propertyCode: 'TNAG0007', name: 'Villa T Nagar', photosLink: 'https://drive.google.com/c', detailsText: 'villa' }];
const members = [{ trackerId: a.id, propertyCode: 'TNAG0003' }, { trackerId: b.id, propertyCode: 'TNAG0005' }, { propertyCode: 'TNAG0007', title: 'Villa T Nagar' }];

// ── Making one ──
check('A series needs a name', !newSeries({ title: ' ', members }, [], null, NOW, 'a@x').ok);
check('…and at least two properties', !newSeries({ title: 'T Nagar series', members: members.slice(0, 1) }, [], null, NOW, 'a@x').ok);
check('Channels without a date are refused', !newSeries({ title: 'T Nagar series', members }, ['igReel'], null, NOW, 'a@x').ok);
const made = newSeries({ title: 'T Nagar series', members }, [], null, NOW, 'a@x');
check('A series can be made first and scheduled later', made.ok && Object.values(made.tracker.channels).every(c => c.status === 'yet' && !c.day));
const s = made.tracker;
check('It is a series', isSeries(s) && s.kind === 'series' && s.title === 'T Nagar series');
eq('Its members are kept in order', s.members.map(m => m.propertyCode), ['TNAG0003', 'TNAG0005', 'TNAG0007']);
check('A series is never on 99 Acres', s.acres99.status === 'na');
check('…and refuses to be', !setListing(s, 'acres99', 'posted', {}, NOW).ok && !setListing(s, 'acres99', 'pending', {}, NOW).ok);
check('The website it does have', setListing(s, 'website', 'posted', { url: 'https://3pin.in/series/tnagar' }, NOW).ok);
const fri = mondayOf(NOW) + 4 * DAY;
const sched = newSeries({ title: 'T Nagar series', members }, ['igReel', 'yt'], { day: fri, at: fri + 18 * H }, NOW, 'a@x').tracker;
eq('With a date and time, the picked channels are Scheduled', [sched.channels.igReel.status, sched.channels.yt.status, sched.channels.igStory.status], ['scheduled', 'scheduled', 'yet']);
const planned = newSeries({ title: 'T Nagar series', members }, ['fbReel'], { day: fri }, NOW, 'a@x').tracker;
check('With only a date, they are Planned for that day', planned.channels.fbReel.status === 'yet' && planned.channels.fbReel.day === fri && planned.plannedDate === fri);

// ── Members ──
eq('The same property is in once (by row or by code)', cleanMembers([{ trackerId: 'x', propertyCode: 'LUX 49' }, { propertyCode: 'lux-49' }, { trackerId: 'x' }, {}]).length, 1);
check('A plain row never carries members', normalizeTracker({ members: [{ propertyCode: 'A' }] }).members.length === 0);
check('An older row reads as not a series', normalizeTracker({}).kind === '' && !isSeries(normalizeTracker({})));
const all = [a, b, s];
const ms = memberStatus(s, all, INV);
eq('Each property is read from its own row, else the dashboard', ms.map(m => [m.propertyCode, m.trackerId ? 'row' : 'dash', m.name]), [['TNAG0003', 'row', '3BHK T Nagar'], ['TNAG0005', 'row', 'Studio T Nagar'], ['TNAG0007', 'dash', 'Villa T Nagar']]);
eq('Photos: from the row, else the dashboard', ms.map(m => !!m.photosLink), [true, false, true]);
eq('Brochure: from where each property keeps it', ms.map(m => m.brochure), [false, true, false]);
check('A member found by code when its row id is not known', memberStatus({ kind: 'series', members: [{ propertyCode: 'tnag 0003' }] }, all, []).every(m => m.trackerId === a.id));

// ── What a series still lacks ──
setMemberSource(t => memberStatus(t, all, INV));
const g = gaps(s, NOW);
check('Photos are asked for each property that lacks them', g.some(x => x.kind === 'photos' && /TNAG0005/.test(x.text) && !/TNAG0003/.test(x.text)), JSON.stringify(g));
check('Brochures likewise', g.some(x => x.kind === 'brochure' && x.sev === 1 && /TNAG0003/.test(x.text) && /TNAG0007/.test(x.text) && !/TNAG0005/.test(x.text)));
check('No code, dashboard, 99 Acres or own photos/details asked of a series', !g.some(x => ['code', 'dashboard', 'acres99', 'details'].includes(x.kind)) && g.filter(x => x.kind === 'photos').length === 1);
check('The website is asked for', g.some(x => x.kind === 'website'));
check('Every channel is still to schedule', g.filter(x => x.kind === 'yet').length === 4);
const out = setChannel(s, 'igReel', 'live', { url: 'https://instagram.com/reel/s' }, NOW).tracker;
check('A missing brochure is severe once the series is going out', gaps(out, NOW).find(x => x.kind === 'brochure').sev === 3);
check('One property is not a series yet', gaps({ ...s, members: members.slice(0, 1) }, NOW).some(x => x.kind === 'members'));
check('…nor none', gaps({ ...s, members: [] }, NOW).some(x => x.kind === 'members' && /Add the properties/.test(x.text)));
check('The task list groups it', tasks([{ ...s, members: [] }], NOW).some(t => t.kind === 'members'));

// ── Progress: its posts and its website, not its properties' brochures ──
eq('Progress counts channels and website only', progress(s), { done: 0, total: 5, pct: 0 });
let done = s;
for (const k of ['igStory', 'igReel', 'fbReel', 'yt']) done = setChannel(done, k, 'live', { url: 'https://youtube.com/x' }, NOW).tracker;
done = setListing(done, 'website', 'posted', { url: 'https://3pin.in/s' }, NOW).tracker;
eq('All posted', progress(done).pct, 100);
check('…but not complete while a property has no brochure', overall(done, NOW) !== 'complete');
setBrochureSource(t => ({ done: true }));
check('Complete once every property has its brochure and photos', overall(done, NOW) === 'complete' || gaps(done, NOW).every(x => x.kind === 'photos'));
setBrochureSource(null);

// ── Filters ──
check('Series filter', matchesFilter(s, 'series', NOW) && !matchesFilter(a, 'series', NOW));
check('A series is not "no code", "not in dashboard" or "99 Acres not posted"', !matchesFilter(s, 'nocode', NOW) && !matchesFilter(s, 'nodash', NOW) && !matchesFilter(s, 'noacres', NOW));
check('"Brochure not created" and "Photos missing" read its properties', matchesFilter(s, 'nobrochure', NOW) && matchesFilter(s, 'noinputs', NOW));

// ── Membership, from the property's side ──
const idx = seriesIndex(all);
check('A property knows its series (by row)', seriesOf(all, a, idx).length === 1 && seriesOf(all, a, idx)[0].id === s.id);
check('…a dashboard member by code', seriesOf(all, { id: 'zz', propertyCode: 'TNAG 0007' }, idx).length === 1);
const rp = blankTracker({ repostOf: a.id, reference: 'again' }, NOW + 5, 'a@x');
check('…a repost of it too', seriesOf(all.concat(rp), rp).length === 1);
check('A series is not in a series', seriesOf(all, s, idx).length === 0);
const s2 = newSeries({ title: 'Studio series', members: [{ trackerId: b.id }, { propertyCode: 'TNAG0007' }] }, [], null, NOW + 9, 'a@x').tracker;
check('A property can be in more than one series', seriesOf([a, b, s, s2], b).length === 2);

// ── Its posts are its own ──
// Schedule the series Reel and TNAG0003's own Reel the same day: two rows, neither touches the other.
const r = bulkSchedule(all, [{ trackerId: s.id, keys: ['igReel'], day: fri }, { trackerId: a.id, keys: ['igReel'], day: fri }], {}, NOW, 'a@x');
eq('Series and member are scheduled separately', r.update.map(t => t.id).sort(), [a.id, s.id].sort());
check('…each its own Reel', r.update.every(t => t.channels.igReel.day === fri));
const again = bulkSchedule([out], [{ trackerId: out.id, keys: ['igReel'], day: fri + 7 * DAY }], {}, NOW, 'a@x');
check('Posting a series again is another round of the series', again.create.length === 1 && again.create[0].repostOf === out.id && isSeries(again.create[0]));
check('…which asks nothing of its properties again', !gaps(again.create[0], NOW).some(x => ['brochure', 'photos', 'members', 'website'].includes(x.kind)));

// ── The week plan ──
const MON = mondayOf(NOW);
const p = parsePlan('Monday -S- Lux49\nYoutube - T nagar series\nFriday - Studio Series', MON);
const rows = planRows(p.items, MON, [], NOW, 'a@x');
eq('A line that says series is a series', rows.map(t => isSeries(t)), [false, true, true]);
check('The word is matched whole', !isSeriesName('Seriesview Towers') && isSeriesName('studio SERIES') && isSeriesName('T nagar series 2'));
const tagged = p.items.map((it, i) => (i === 1 ? { ...it, tag: { propertyCode: 'TNAG0003', title: '3BHK' } } : it));
check('A series line tagged to a property is that property', !isSeries(planRows(tagged, MON, [], NOW, 'a@x')[1]));
const round2 = p.items.map((it, i) => (i === 1 ? { ...it, tag: { repostOf: s.id } } : it));
const r2 = planRows(round2, MON, [s], NOW, 'a@x')[1];
check('Tagged to an existing series: another round of it', r2.repostOf === s.id && isSeries(r2));
const wk2 = planRows(parsePlan('Youtube - T Nagar Series', MON + 7 * DAY).items, MON + 7 * DAY, [s], NOW, 'a@x')[0];
check('An untagged line naming an existing series: another round of it, not a new empty series', wk2.repostOf === s.id && isSeries(wk2));

// ── Saving touches only what changed ──
eq('Adding a member is one field', changedPaths(s, { ...s, members: s.members.concat({ propertyCode: 'TNAG0009' }) }), ['members']);

// ── CSV ──
const csv = toCsv([s, a]).split('\r\n');
check('CSV carries the series properties', csv[0].includes('Series of') && csv[1].includes('TNAG0003; TNAG0005; TNAG0007'));
check('…and its brochures as a count', /,1 of 3,/.test(csv[1]), csv[1]);
setMemberSource(null);

console.log(failed ? `\n${failed} failure(s)` : '\nAll good.');
process.exit(failed ? 1 : 0);
