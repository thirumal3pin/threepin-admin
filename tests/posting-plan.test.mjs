// Weekly plan → rows, and rows that start as a reference.   node tests/posting-plan.test.mjs
import {
  parsePlan, planRows, planned, setCode, displayName, gaps, tasks, mondayOf, startOfDay, addDays, nameOf, blankTracker,
  setChannel, normalizeTracker, overall, toCsv, progress, weekAgenda, linkLooksLike, platformOf, rowFocus, familyOf, channelHistory, familyCounts, bulkSchedule, CHANNEL_KEYS as CHANNEL_KEYS_T
} from '../track-assets/posting.js';

let failed = 0;
const check = (l, c, d) => { if (!c) { failed++; console.log('  FAIL  ' + l + (d !== undefined ? ' — ' + d : '')); } };
const eq = (l, a, b) => check(l, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// Monday 6 Oct 2025, local time
const MON = new Date(2025, 9, 6).getTime();
const day = n => addDays(MON, n);
const NOW = new Date(2025, 9, 6, 9, 0).getTime();

console.log('3 PIN Realty — weekly plan');

const WEEK1 = `HIS WEEK

Monday -S - Lux49 - 4Bhk

Tuesday - Velachery 2Bhk

Wednesday -S- Eden villas rent

Thursday - Kodambakkam commercial rent

Friday -S- Brigade stellaris velachery

Saturday - T nagar pushkar 3Bhk

Sunday - Nandanam 3Bhk brand new

Youtube - T nagar series`;

// ── the real text ──
const p1 = parsePlan(WEEK1, MON);
eq('Eight lines become eight rows, heading skipped', [p1.items.length, p1.skipped], [8, []]);
eq('Monday is a Story for Lux49 4Bhk', [p1.items[0].reference, p1.items[0].story, p1.items[0].day === MON], ['Lux49 - 4Bhk', true, true]);
eq('No S means no channel', [p1.items[1].reference, p1.items[1].story], ['Velachery 2Bhk', false]);
eq('Wednesday -S- reads as a Story', [p1.items[2].reference, p1.items[2].story, p1.items[2].day === day(2)], ['Eden villas rent', true, true]);
eq('Stories are Mon, Wed, Fri', p1.items.filter(i => i.story).map(i => (new Date(i.day).getDay())), [1, 3, 5]);
eq('Sunday lands on Sunday', new Date(p1.items[6].day).getDay(), 0);
eq('Youtube line is a week item', [p1.items[7].kind, p1.items[7].reference, p1.items[7].day], ['youtube', 'T nagar series', 0]);
check('"Shriram king life" is not mistaken for an S marker', parsePlan('Sunday - Shriram king life', MON).items[0].story === false && parsePlan('Sunday - Shriram king life', MON).items[0].reference === 'Shriram king life');

const p2 = parsePlan(`THIS WEEK
Monday - Porur 4BHK Story
Tuesday - WTC 118th floor
Wednesday -S- Ashok nagar individual house rent
Saturday - Mogappair 2 prop
Youtube - Shriram King life`, MON);
eq('Third week parses', p2.items.map(i => i.reference), ['Porur 4BHK Story', 'WTC 118th floor', 'Ashok nagar individual house rent', 'Mogappair 2 prop', 'Shriram King life']);

// messy input
eq('Blank and empty input', [parsePlan('', MON).items.length, parsePlan(null, MON).items.length, parsePlan('   \n\n', MON).items.length], [0, 0, 0]);
const odd = parsePlan('Mon: Adyar flat\nTUESDAY – S – OMR duplex\nwed Anna nagar 3bhk\nfoo bar baz\nThursday -', MON);
eq('Colon, en dash, short day names and caps all work', odd.items.map(i => [i.reference, i.story]), [['Adyar flat', false], ['OMR duplex', true], ['Anna nagar 3bhk', false]]);
eq('Unrecognised lines are reported, not lost or guessed', odd.skipped, ['foo bar baz', 'Thursday -']);
check('A day with nothing after it is skipped, not an empty row', !odd.items.some(i => !i.reference));
check('Windows line endings are fine', parsePlan('Monday - A\r\nTuesday - B\r\n', MON).items.length === 2);
// A property whose name starts like a day is not a day.
{
  const names = parsePlan('Sunshine Apartments\nMonarch Villa\nSaturn Towers - 3BHK\nWednesdays special', MON);
  eq('"Sunshine Apartments" and "Monarch Villa" are not read as days', [names.items.length, names.skipped.length], [0, 4]);
  const real = parsePlan('Monday -S- Lux49\nTues - X\nThurs X\nSun - Sunshine Apartments\nSat: Y', MON);
  eq('Real day names and short forms still work', real.items.map(i => [new Date(i.day).getDay(), i.reference, i.story]),
    [[1, 'Lux49', true], [2, 'X', false], [4, 'X', false], [0, 'Sunshine Apartments', false], [6, 'Y', false]]);
}

// ── rows ──
const rows = planRows(p1.items, MON, [], NOW, 'admin@x');
eq('Eight rows', rows.length, 8);
check('Rows have no code and no title', rows.every(r => !r.propertyCode && !r.title));
check('Ids are unique', new Set(rows.map(r => r.id)).size === 8);
check('Ids are random, never a property code', rows.every(r => /^pt_/.test(r.id)));
check('Story days are carried on the Story channel', rows[0].channels.igStory.day === MON && rows[0].channels.igStory.status === 'yet');
check('A day without S carries only the planned date', rows[1].plannedDate === day(1) && rows[1].channels.igStory.day === 0);
check('The YouTube row has the other social channels N/A', rows[7].channels.igReel.status === 'na' && rows[7].channels.yt.status === 'yet' && rows[7].weekOf === MON);
eq('Re-pasting the same week adds nothing', planRows(p1.items, MON, rows, NOW, 'a').length, 0);
eq('A different week with the same reference is new', planRows(parsePlan('Monday - Lux49 - 4Bhk', addDays(MON, 7)).items, addDays(MON, 7), rows, NOW, 'a').length, 1);
eq('Re-paste adds only the new line', planRows(parsePlan(WEEK1 + '\nMonday - Extra one', MON).items, MON, rows, NOW, 'a').length, 1);
check('Name falls back from title to reference to code', nameOf(rows[0]) === 'Lux49 - 4Bhk' && nameOf({ title: 'T', reference: 'R' }) === 'T' && nameOf({ propertyCode: 'C1' }) === 'C1' && nameOf({}) === 'Untitled');

// ── what the team is asked to do ──
{
  const today = NOW;
  const g0 = gaps(rows[0], today);   // Mon story planned for today, no time yet
  check('A Story planned for today is a to-do, not routine', g0.find(g => g.kind === 'yet' && g.key === 'igStory').sev === 2);
  check('…and a row with no code asks for one', g0.some(g => g.kind === 'code'));
  check('A plan-only row is not nagged about channels the plan did not mention', !g0.some(g => g.kind === 'yet' && g.key === 'igReel'));
  const g1 = gaps(rows[1], today);
  check('A planned day with no channel is its own task', g1.some(g => g.kind === 'plan' && g.sev === 1));
  check('Planned in the past with nothing is severe', gaps(rows[0], addDays(MON, 2)).find(g => g.kind === 'yet').sev === 3 && gaps(rows[1], addDays(MON, 3)).find(g => g.kind === 'plan').sev === 3);
  check('Once the Story has a time the plan gap clears', !gaps(setChannel(rows[0], 'igStory', 'scheduled', { at: MON + 18 * 3600000 }, NOW).tracker, today).some(g => g.kind === 'yet' && g.key === 'igStory'));
  check('Scheduling keeps the planned day', setChannel(rows[0], 'igStory', 'scheduled', { at: MON + 18 * 3600000 }, NOW).tracker.channels.igStory.day === MON);
  check('A YouTube week row only asks about YouTube-ish things', !gaps(rows[7], today).some(g => g.kind === 'yet' && g.key !== 'yt'));
  check('Late plan makes the row need attention', overall(rows[0], addDays(MON, 2)) === 'attention');
  const t = tasks(rows, today);
  check('Tasks include code and plan groups', t.some(g => g.kind === 'code' && g.items.length === 8) && t.some(g => g.kind === 'plan' && g.items.length === 4));
}

// ── planned list ──
{
  const pl = planned(rows, NOW);
  check('Planned count: stories + day-only rows (YouTube week row excluded)', pl.length === 7, pl.length);
  check('Sorted by day', pl.every((r, i) => i === 0 || pl[i - 1].day <= r.day));
  check('Late flag only for days already passed', planned(rows, addDays(MON, 3)).filter(r => r.late).length === 3, planned(rows, addDays(MON, 3)).filter(r => r.late).length);
}

// ── giving it a code later ──
{
  check('Setting a code works, in capitals', setCode(rows, rows[0].id, 'lux049').ok && setCode(rows, rows[0].id, 'lux049').code === 'LUX049');
  check('Empty code refused', !setCode(rows, rows[0].id, '  ').ok);
  const coded = [{ ...rows[1], propertyCode: 'LUX049' }, ...rows];
  check('A code already used elsewhere is refused (any case/spacing)', !setCode(coded, rows[0].id, 'lux 049').ok && !setCode(coded, rows[0].id, 'LUX049').ok);
  check('Keeping your own code is fine', setCode(coded, coded[0].id, 'LUX049').ok);
  const withCode = { ...rows[0], propertyCode: 'LUX049', title: 'Lux49 4BHK' };
  check('Once it has a code the code gap clears and channel nags start', !gaps(withCode, NOW).some(g => g.kind === 'code') && gaps(withCode, NOW).some(g => g.kind === 'yet' && g.key === 'igReel'));
}

// ── helpers ──
check('Monday of any day in the week is the Monday', [0, 1, 2, 6].every(n => mondayOf(day(n) + 5 * 3600000) === MON));
check('Sunday belongs to the week that started the Monday before', mondayOf(day(6)) === MON && mondayOf(day(7)) === day(7));
check('startOfDay zeroes the time', startOfDay(NOW) === MON);
check('Old rows without any plan fields still behave', gaps({ propertyCode: 'X' }, NOW).every(g => g.kind !== 'plan' && g.kind !== 'code') && progress({ propertyCode: 'X' }).total === 7);
check('CSV carries the plan columns', toCsv([rows[0]]).split('\r\n')[0].startsWith('Planned date,Reference,Repost of,Property code') && toCsv([rows[0]]).includes('Lux49 - 4Bhk'));
check('Normalising keeps plan fields', normalizeTracker({ reference: ' R ', plannedDate: '5', weekOf: 'x' }).reference === 'R' && normalizeTracker({ plannedDate: '5' }).plannedDate === 5 && normalizeTracker({ weekOf: 'x' }).weekOf === 0);

// ── tagging a plan line to a property, and reposts ──
{
  // A property that went out last week, fully done.
  let orig = blankTracker({ propertyCode: 'VLC002', title: 'Velachery 2BHK', photosLink: 'https://d.com/v', details: 'x', propertyId: 'VLC002' }, NOW - 9e8, 'a');
  orig = { ...orig, brochure: { done: true }, acres99: { status: 'posted', url: 'https://99acres.com/v' }, website: { status: 'na' } };
  for (const k of ['igStory', 'igReel', 'fbReel', 'yt']) orig = setChannel(orig, k, 'live', { url: 'https://x.com/' + k }, NOW).tracker;
  check('The original is complete', overall(orig, NOW) === 'complete');

  const p = parsePlan('Monday -S- Velachery 2BHK\nTuesday - Lux49 4Bhk\nWednesday - Adyar villa', MON);
  p.items[0].tag = { repostOf: orig.id };                                                   // second round
  p.items[1].tag = { propertyCode: 'LUX049', title: 'Lux49 4BHK', propertyId: 'LUX049' };   // in the dashboard already, first post
  const r = planRows(p.items, MON, [orig], NOW, 'a');
  const [repost, first, plain] = r;

  check('Repost row points at the original', repost.repostOf === orig.id && !repost.propertyCode);
  check('Repost does not ask again for brochure, photos, listings, code or dashboard',
    !gaps(repost, NOW).some(g => ['brochure', 'photos', 'details', 'acres99', 'website', 'code', 'dashboard'].includes(g.kind)));
  check('Repost only asks for its own planned Story', gaps(repost, NOW).map(g => g.kind + ':' + g.key).join() === 'yet:igStory', gaps(repost, NOW).map(g => g.kind + ':' + g.key).join());
  eq('Repost progress counts only its own posts', progress(repost), { done: 0, total: 1, pct: 0 });
  let done = setChannel(repost, 'igStory', 'live', { url: 'https://instagram.com/s/2' }, NOW).tracker;
  check('Repost is complete once its own post is live with a link', overall(done, NOW) === 'complete');
  check('The original is untouched by the repost', overall(orig, NOW) === 'complete' && orig.channels.igStory.url === 'https://x.com/igStory');
  check('A repost name shows the property it repeats', displayName(repost, [orig, ...r]) === 'Velachery 2BHK' && displayName({ repostOf: orig.id, reference: 'Velachery 2BHK new price' }, [orig]) === 'Velachery 2BHK — Velachery 2BHK new price');
  check('A repost whose original was deleted still has a name', displayName({ repostOf: 'gone', reference: 'X' }, []) === 'Repost');
  check('A repost with nothing planned is not "complete" by default', overall({ repostOf: orig.id }, NOW) !== 'complete');

  check('A line tagged to a dashboard property starts with its code, title and link', first.propertyCode === 'LUX049' && first.title === 'Lux49 4BHK' && first.propertyId === 'LUX049' && first.reference === 'Lux49 4Bhk');
  check('…so the code task is not raised for it', !gaps(first, NOW).some(g => g.kind === 'code' || g.kind === 'dashboard'));
  check('An untagged line is a plain reference row', !plain.propertyCode && !plain.repostOf && gaps(plain, NOW).some(g => g.kind === 'code'));
  check('Repost rows never block a code being used on the original', setCode([orig, repost], orig.id, 'VLC002').ok);
  check('Code clash ignores spacing and dashes', !setCode([orig, plain], plain.id, 'vlc-002').ok);

  // Same coded property tagged twice in one paste → the second line is a repost of the first
  const twice = parsePlan('Monday - A\nThursday - A again', MON);
  twice.items.forEach(i => { i.tag = { propertyCode: 'NEW9', title: 'N9' }; });
  const tw = planRows(twice.items, MON, [], NOW, 'a');
  check('Tagging the same new code on two lines: two rows, the second a repost of the first',
    tw.length === 2 && tw[0].id !== tw[1].id && tw[0].propertyCode === 'NEW9' && tw[1].repostOf === tw[0].id && !tw[1].propertyCode);
  check('…and the first row id is not the code', tw[0].id !== 'NEW9');
  const again = parsePlan('Friday - A third time', MON);
  again.items[0].tag = { propertyCode: 'new 9' };
  check('A code already on a saved row makes the line a repost of that row', planRows(again.items, MON, tw, NOW, 'a')[0].repostOf === tw[0].id);
}

// ── week at a glance ──
{
  const items = parsePlan(WEEK1, MON).items;
  let rows = planRows(items, MON, [], NOW, 'a');
  // Tuesday's Velachery gets a Reel at 6pm and a Story at 7pm; Monday's Lux49 Story goes live.
  const tueI = rows.findIndex(r => r.reference === 'Velachery 2Bhk');
  rows[tueI] = setChannel(rows[tueI], 'igReel', 'scheduled', { at: day(1) + 18 * 3600000 }, NOW).tracker;
  rows[tueI] = setChannel(rows[tueI], 'igStory', 'scheduled', { at: day(1) + 19 * 3600000 }, NOW).tracker;
  rows[0] = setChannel(rows[0], 'igStory', 'live', { url: 'https://i.com/s', at: MON + 9 * 3600000 }, NOW).tracker;
  const a = weekAgenda(rows, MON, NOW);
  eq('Seven days, Monday first', a.days.map(d => new Date(d.day).getDay()), [1, 2, 3, 4, 5, 6, 0]);
  eq('Monday: the Lux49 Story, live', a.days[0].items.map(i => [i.key, i.state]), [['igStory', 'live']]);
  eq('Tuesday: Reel then Story, in time order — both are shown', a.days[1].items.map(i => i.key), ['igReel', 'igStory']);
  eq('Wednesday: a planned Story (no time yet)', a.days[2].items.map(i => [i.key, i.state]), [['igStory', 'planned']]);
  eq('Thursday: planned, type not decided', a.days[3].items.map(i => [i.key, i.state]), [[null, 'undecided']]);
  eq('The YouTube series is a week item, not on a day', [a.weekItems.length, a.weekItems[0].key], [1, 'yt']);
  eq('Counts by type', a.counts, { igStory: 4, igReel: 1, fbReel: 0, yt: 1, undecided: 3 });
  const next = weekAgenda(rows, addDays(MON, 7), NOW);
  check('Next week is empty', next.days.every(d => !d.items.length) && !next.weekItems.length);
  check('A day already passed with no type is "late"', weekAgenda(rows, MON, addDays(MON, 5)).days[3].items[0].state === 'late');
  check('A scheduled time that passed is "due"', weekAgenda(rows, MON, day(2)).days[1].items.every(i => i.state === 'due'));
  check('Reposts and rows outside the week are handled', weekAgenda([{ repostOf: 'x', channels: { igReel: { status: 'scheduled', at: day(4) } } }], MON, NOW).days[4].items.length === 1);
}

// ── why a row is in its week ──
{
  let t = blankTracker({ propertyCode: 'VLCA002', title: 'Velachery 3BHK' }, NOW, 'a');
  t = setChannel(t, 'igStory', 'live', { url: 'https://i.com/s', at: day(-6) }, day(-6)).tracker;     // last week
  t = { ...t, channels: { ...t.channels, igStory: { ...t.channels.igStory, liveAt: day(-6) } } };
  t = setChannel(t, 'fbReel', 'scheduled', { at: day(2) + 18 * 3600000 }, NOW).tracker;               // Wed this week
  const f = rowFocus(t, MON);
  eq('Only the FB Reel goes out this week', f.keys, ['fbReel']);
  eq('…on Wednesday', f.days.map(d => [new Date(d.day).getDay(), d.keys]), [[3, ['fbReel']]]);
  eq('Last week, only the Story', rowFocus(t, addDays(MON, -7)).keys, ['igStory']);
  let many = blankTracker({ propertyCode: 'ADB014' }, NOW, 'a');
  for (const k of ['igStory', 'igReel']) many = setChannel(many, k, 'scheduled', { at: MON + 15 * 3600000 }, NOW).tracker;
  many = setChannel(many, 'yt', 'scheduled', { at: day(4) + 15 * 3600000 }, NOW).tracker;
  const fm = rowFocus(many, MON);
  eq('Several posts: grouped by day, soonest first', fm.days.map(d => [new Date(d.day).getDay(), d.keys]), [[1, ['igStory', 'igReel']], [5, ['yt']]]);
  const planOnly = planRows(parsePlan('Wednesday -S- Eden villas rent\nThursday - Kodambakkam rent\nYoutube - T nagar series', MON).items, MON, [], NOW, 'a');
  eq('A planned Story counts on its planned day', rowFocus(planOnly[0], MON).keys, ['igStory']);
  eq('A day with no type chosen highlights nothing (the date says the day)', rowFocus(planOnly[1], MON).keys, []);
  eq('The weekly YouTube line highlights YouTube', rowFocus(planOnly[2], MON).keys, ['yt']);
  eq('Without a week given, the row\'s own week is used', rowFocus(t).keys.length > 0, true);
  eq('A row with nothing dated has no focus', rowFocus(blankTracker({ propertyCode: 'X' }, NOW, 'a')).keys, []);
}

// ── a property across its rounds ──
{
  const TWO_MONTHS = 60 * 86400000;
  let orig = blankTracker({ propertyCode: 'VLC002', title: 'Velachery 2BHK' }, NOW - TWO_MONTHS, 'a');
  orig = setChannel(orig, 'igReel', 'live', { url: 'https://instagram.com/reel/aug', at: NOW - TWO_MONTHS }, NOW - TWO_MONTHS).tracker;
  orig = { ...orig, channels: { ...orig.channels, igReel: { ...orig.channels.igReel, liveAt: NOW - TWO_MONTHS } } };
  orig = setChannel(orig, 'igStory', 'live', { url: 'https://instagram.com/s/aug', at: NOW - TWO_MONTHS }, NOW - TWO_MONTHS).tracker;
  const r1 = setChannel(blankTracker({ reference: 'Velachery 2Bhk', repostOf: orig.id, plannedDate: day(3) }, NOW, 'a'), 'igReel', 'scheduled', { at: day(3) + 18 * 3600000 }, NOW).tracker;
  const r2 = setChannel(blankTracker({ reference: 'Velachery 2Bhk again', repostOf: orig.id, plannedDate: day(10) }, NOW + 1, 'a'), 'igReel', 'scheduled', { at: day(10) + 18 * 3600000 }, NOW).tracker;
  const other = blankTracker({ propertyCode: 'X1' }, NOW, 'a');
  const all = [r2, other, orig, r1];
  eq('Family: original first, then reposts in date order', familyOf(all, r1.id).map(t => t.id), [orig.id, r1.id, r2.id]);
  eq('…same family asked from the original', familyOf(all, orig.id).map(t => t.id), [orig.id, r1.id, r2.id]);
  eq('A property with no reposts is a family of one', familyOf(all, other.id).map(t => t.id), [other.id]);
  const h = channelHistory(all, r1.id, 'igReel');
  eq('Reel history: live two months ago, then the two reposts', h.map(x => [x.status, x.repost]), [['live', false], ['scheduled', true], ['scheduled', true]]);
  check('…the first one carries its link', h[0].url === 'https://instagram.com/reel/aug');
  eq('Story history: only the original', channelHistory(all, r1.id, 'igStory').map(x => x.status), ['live']);
  eq('Facebook never used: empty history', channelHistory(all, r1.id, 'fbReel'), []);
  const c = familyCounts(all, orig.id);
  eq('Scorecard: Reel 1× live, 2 coming', c.igReel, { live: 1, coming: 2 });
  eq('Scorecard: Story 1× live', c.igStory, { live: 1, coming: 0 });
  eq('A repost whose original was deleted is its own family', familyOf([r1], r1.id).map(t => t.id), [r1.id]);
}

// ── Add schedule: one date, several entries ──
{
  const FRI = day(4), FRI6 = day(4) + 18 * 3600000;
  // A tracked property that went out as a Reel before, and a fresh plan row nobody has touched.
  let done = blankTracker({ propertyCode: 'VLC002', title: 'Velachery 2BHK' }, NOW - 9e8, 'a');
  done = setChannel(done, 'igReel', 'live', { url: 'https://instagram.com/reel/1', at: NOW - 9e8 }, NOW - 9e8).tracker;
  const fresh = blankTracker({ reference: 'Eden villas rent' }, NOW, 'a');
  const all = [done, fresh];
  const r = bulkSchedule(all, [
    { trackerId: done.id, keys: ['igReel', 'igStory'] },                  // Reel already went out → repost round
    { trackerId: fresh.id, keys: ['igStory'] },                            // untouched → scheduled on its own row
    { inv: { propertyCode: 'LUX049', title: 'Lux49 4BHK', propertyId: 'LUX049', photosLink: 'https://d.com/l' }, keys: ['yt'] },
    { ref: 'Adyar villa', keys: [] },                                      // type not decided yet
    { ref: '   ', keys: ['igReel'] }                                       // empty line is ignored
  ], { day: FRI }, NOW, 'admin');
  eq('Nothing went wrong', r.errors, []);
  eq('Three new rows, one updated', [r.create.length, r.update.length], [3, 1]);
  const repost = r.create.find(x => x.repostOf === done.id);
  check('Posting again a property that went out before makes a repost round', !!repost && repost.channels.igReel.day === FRI && repost.channels.igStory.day === FRI);
  check('…and leaves its earlier live Reel alone (not in the update list)', !r.update.some(x => x.id === done.id));
  check('An untouched row is planned on its own row', r.update[0].id === fresh.id && r.update[0].channels.igStory.day === FRI && r.update[0].plannedDate === FRI);
  const lux = r.create.find(x => x.propertyCode === 'LUX049');
  check('A dashboard property comes in with its code, title and photos', lux && lux.title === 'Lux49 4BHK' && lux.propertyId === 'LUX049' && lux.channels.yt.day === FRI);
  const adyar = r.create.find(x => x.reference === 'Adyar villa');
  check('Typed text becomes a reference row; no type means "not decided"', adyar && adyar.plannedDate === FRI && CHANNEL_KEYS_T.every(k => adyar.channels[k].status === 'yet' && !adyar.channels[k].day));
  // With a time: Scheduled, not Planned.
  const timed = bulkSchedule([fresh], [{ trackerId: fresh.id, keys: ['igReel', 'fbReel'] }], { day: FRI, at: FRI6 }, NOW, 'a');
  check('With a time, each type is Scheduled at that time', timed.update[0].channels.igReel.status === 'scheduled' && timed.update[0].channels.igReel.at === FRI6 && timed.update[0].channels.fbReel.at === FRI6);
  check('No date is refused', bulkSchedule(all, [{ ref: 'x', keys: [] }], {}, NOW, 'a').errors.length === 1);
  // A picked property can carry the plan's reference too.
  const withRef = bulkSchedule(all, [
    { trackerId: fresh.id, keys: ['igReel'], ref: 'Eden villas — corner unit' },
    { inv: { propertyCode: 'BRG001', title: 'Brigade Stellaris', propertyId: 'BRG001' }, keys: ['igStory'], ref: 'Brigade stellaris velachery' },
    { trackerId: done.id, keys: ['igReel'], ref: 'Velachery 2BHK — second round' }
  ], { day: FRI }, NOW, 'a');
  eq('A tracked property picked with a reference keeps it on its row', withRef.update.find(x => x.id === fresh.id).reference, 'Eden villas — corner unit');
  eq('A dashboard property picked with a reference keeps it, beside its code', [withRef.create.find(x => x.propertyCode === 'BRG001').reference, withRef.create.find(x => x.propertyCode === 'BRG001').title], ['Brigade stellaris velachery', 'Brigade Stellaris']);
  eq('A repost round takes the reference given', withRef.create.find(x => x.repostOf === done.id).reference, 'Velachery 2BHK — second round');
  eq('No reference given: a tracked row keeps the one it had', bulkSchedule(all, [{ trackerId: fresh.id, keys: ['igReel'] }], { day: FRI }, NOW, 'a').update[0].reference, 'Eden villas rent');
  // Each entry on its own day (the dialog sends a date per line).
  const multi = bulkSchedule([fresh], [
    { ref: 'Mogappair 2 prop', keys: ['igStory'], day: day(1) },
    { ref: 'Porur 4BHK', keys: ['igReel'], day: day(3), at: day(3) + 19 * 3600000 },
    { trackerId: fresh.id, keys: ['yt'], day: day(5) }
  ], {}, NOW, 'a');
  eq('Three entries on three different days', [multi.errors, multi.create.length, multi.update.length], [[], 2, 1]);
  check('…Tuesday planned as a Story', multi.create[0].plannedDate === day(1) && multi.create[0].channels.igStory.day === day(1) && multi.create[0].channels.igStory.status === 'yet');
  check('…Thursday scheduled as a Reel at 7pm', multi.create[1].channels.igReel.status === 'scheduled' && multi.create[1].channels.igReel.at === day(3) + 19 * 3600000);
  check('…Saturday planned on the existing row', multi.update[0].channels.yt.day === day(5));
  check('One entry missing its date stops the save with a reason', /every entry/.test(bulkSchedule([], [{ ref: 'a', keys: [], day: day(1) }, { ref: 'b', keys: [] }], {}, NOW, 'a').errors[0] || ''));
  check('No entries is refused', bulkSchedule(all, [], { day: FRI }, NOW, 'a').errors.length === 1);
  check('A dashboard property that is already tracked is refused with a reason', /already tracked/.test(bulkSchedule(all, [{ inv: { propertyCode: 'vlc 002' }, keys: [] }], { day: FRI }, NOW, 'a').errors[0] || ''));
  // The same untouched row picked twice in one go: the second time it is no longer untouched → repost.
  const twice = bulkSchedule([fresh], [{ trackerId: fresh.id, keys: ['igStory'] }, { trackerId: fresh.id, keys: ['igStory'] }], { day: FRI }, NOW, 'a');
  check('Picking the same property twice: first schedules it, second makes a repost round', twice.update.length === 1 && twice.create.length === 1 && twice.create[0].repostOf === fresh.id);
  // The same dashboard property on two lines of one submit: one first row, then a repost of it.
  const dup = bulkSchedule([], [
    { inv: { propertyCode: 'LUX049', title: 'Lux49 4BHK', propertyId: 'LUX049' }, keys: ['igStory'], day: day(1) },
    { inv: { propertyCode: 'lux 049', title: 'Lux49 4BHK', propertyId: 'LUX049' }, keys: ['igReel'], day: day(3) }
  ], {}, NOW, 'a');
  check('Same dashboard property twice in one submit: the second is a repost of the first',
    dup.errors.length === 0 && dup.create.length === 2 && dup.create[1].repostOf === dup.create[0].id && !dup.create[1].propertyCode && dup.create[1].channels.igReel.day === day(3), JSON.stringify(dup.errors));
  check('…and the first keeps the code, under its own id', dup.create[0].propertyCode === 'LUX049' && dup.create[0].id !== 'LUX049');
  check('A javascript: photos link from the dashboard is not copied', bulkSchedule([], [{ inv: { propertyCode: 'X9', photosLink: 'javascript:alert(1)' }, keys: [] }], { day: FRI }, NOW, 'a').create[0].photosLink === '');
  // A row planned for another day is not moved — a new round is made instead.
  const other = { ...fresh, plannedDate: day(1) };
  check('A row planned for another day is not silently moved', bulkSchedule([other], [{ trackerId: other.id, keys: ['igStory'] }], { day: FRI }, NOW, 'a').create.length === 1);
}

// ── pasted links: right platform? ──
{
  check('Instagram link on a Story is right', linkLooksLike('igStory', 'https://www.instagram.com/stories/3pin/1') === true);
  check('…bare domain too', linkLooksLike('igReel', 'instagram.com/reel/abc') === true);
  check('A YouTube link on an Insta Story is flagged', linkLooksLike('igStory', 'https://youtu.be/xyz') === false);
  check('Facebook reel and fb.watch are right for FB Reel', linkLooksLike('fbReel', 'https://www.facebook.com/reel/1') === true && linkLooksLike('fbReel', 'https://fb.watch/abc') === true);
  check('Instagram on FB Reel is flagged', linkLooksLike('fbReel', 'https://instagram.com/reel/1') === false);
  check('YouTube: youtube.com and youtu.be', linkLooksLike('yt', 'https://m.youtube.com/watch?v=1') === true && linkLooksLike('yt', 'youtu.be/1') === true);
  check('99 Acres link is right for 99 Acres', linkLooksLike('acres99', 'https://www.99acres.com/x') === true);
  check('A social link on the website listing is flagged', linkLooksLike('website', 'https://instagram.com/p/1') === false);
  check('Our own site on the website listing is fine (unknown)', linkLooksLike('website', 'https://3pinrealty.com/p/1') === null);
  check('A short link cannot be judged, so it is not flagged', linkLooksLike('igStory', 'https://bit.ly/abc') === null);
  check('Garbage is not judged', linkLooksLike('yt', 'not a link') === null && linkLooksLike('yt', '') === null);
  check('Platform name of a link', platformOf('https://youtu.be/x') === 'YouTube' && platformOf('instagram.com/p/1') === 'Instagram' && platformOf('https://3pin.in') === '');
}

console.log(failed ? `\n${failed} failure(s)` : '\nAll good.');
process.exit(failed ? 1 : 0);
