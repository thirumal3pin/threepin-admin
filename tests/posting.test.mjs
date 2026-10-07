// Posting tracker rules.   node tests/posting.test.mjs
import {
  trackerId, blankTracker, normalizeTracker, setChannel, setChannelUrl, setListing, setBrochure,
  gaps, progress, overall, upcoming, liveMissingLink, matchesFilter, toCsv, channelView, cleanUrl, validUrl, tasks, summary,
  changedPaths, copyPaths, getPath, webLink
} from '../track-assets/posting.js';

let failed = 0;
const check = (label, cond, detail) => { if (!cond) { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
const eq = (l, a, b) => check(l, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const NOW = 1789000000000, H = 3600000;
const fresh = () => blankTracker({ propertyCode: 'tnag 0002', title: '3BHK', photosLink: 'https://d.com/x', details: 'text' }, NOW, 'a@x');

console.log('3 PIN Realty — posting tracker');

check('Code becomes a safe id', trackerId(' tnag/0002 ') === 'TNAG_0002');
eq('Every channel starts as Yet to schedule', Object.values(fresh().channels).map(c => c.status), ['yet', 'yet', 'yet', 'yet']);
check('A half-written doc never throws', normalizeTracker({ channels: { igReel: { status: 'bogus' } } }).channels.igReel.status === 'yet');

// scheduling
check('Scheduled needs a time', !setChannel(fresh(), 'igReel', 'scheduled', {}, NOW).ok);
let t = setChannel(fresh(), 'igReel', 'scheduled', { at: NOW + H }, NOW).tracker;
eq('Channels are independent', [t.channels.igReel.status, t.channels.igStory.status], ['scheduled', 'yet']);
check('Back to yet clears the date', setChannel(t, 'igReel', 'yet', {}, NOW).tracker.channels.igReel.at === 0);
check('N/A clears date and link', setChannel(t, 'igReel', 'na', {}, NOW).tracker.channels.igReel.at === 0);

// due is not live
check('A passed time is DUE, not live', channelView(t.channels.igReel, NOW + 2 * H).due && channelView(t.channels.igReel, NOW + 2 * H).status === 'scheduled');
check('Not due before its time', !channelView(t.channels.igReel, NOW).due);
check('Due appears in gaps, worst first', gaps(t, NOW + 2 * H)[0].kind === 'due');

// live
check('Bad link refused', !setChannel(t, 'igReel', 'live', { url: 'not a link' }, NOW).ok);
const liveNoLink = setChannel(t, 'igReel', 'live', {}, NOW).tracker;
check('Live without link is allowed but flagged', liveNoLink.channels.igReel.status === 'live' && gaps(liveNoLink, NOW).some(g => g.kind === 'link' && g.key === 'igReel'));
check('…and listed in the link-missing queue', liveMissingLink([liveNoLink]).length === 1);
check('Keeps the scheduled time as when it was planned', liveNoLink.channels.igReel.at === t.channels.igReel.at);
const fixed = setChannelUrl(liveNoLink, 'igReel', 'https://instagram.com/reel/abc').tracker;
check('Pasting the link clears the flag', !gaps(fixed, NOW).some(g => g.kind === 'link'));
check('Only a live post takes a link', !setChannelUrl(t, 'igReel', 'https://x.com').ok);

// brochure
check('Brochure missing while posts go out is severe', gaps(liveNoLink, NOW).find(g => g.kind === 'brochure').sev === 3);
check('Brochure missing before any post is routine', gaps(fresh(), NOW).find(g => g.kind === 'brochure').sev === 1);
const b = setBrochure(fresh(), true, 'admin@x', NOW);
check('Brochure records who and when', b.brochure.done && b.brochure.by === 'admin@x' && b.brochure.at === NOW);
check('Brochure can be unticked', !setBrochure(b, false).brochure.done);

// listings
check('99 Acres starts not posted', gaps(fresh(), NOW).some(g => g.kind === 'acres99'));
const na = setListing(fresh(), 'acres99', 'na', {}, NOW).tracker;
check('N/A removes the 99 Acres gap', !gaps(na, NOW).some(g => g.kind === 'acres99'));
const posted = setListing(fresh(), 'website', 'posted', {}, NOW).tracker;
check('Posted without link is flagged', gaps(posted, NOW).some(g => g.kind === 'link' && g.key === 'website'));
check('Bad listing link refused', !setListing(fresh(), 'website', 'posted', { url: 'zzz' }, NOW).ok);

// inputs
check('Missing photos and details are gaps', gaps(blankTracker({ propertyCode: 'A' }, NOW), NOW).filter(g => g.kind === 'photos' || g.kind === 'details').length === 2);

// progress / overall
eq('Fresh progress', progress(fresh()), { done: 0, total: 7, pct: 0 });
let all = fresh();
for (const k of ['igStory', 'igReel', 'fbReel']) all = setChannel(all, k, 'live', { url: 'https://x.com/' + k }, NOW).tracker;
all = setChannel(all, 'yt', 'na', {}, NOW).tracker;
all = setBrochure(all, true, 'a', NOW);
all = setListing(all, 'acres99', 'posted', { url: 'https://99acres.com/x' }, NOW).tracker;
all = setListing(all, 'website', 'posted', { url: 'https://3pin.in/x' }, NOW).tracker;
eq('N/A drops out of the total', progress(all), { done: 6, total: 6, pct: 100 });
check('Done but not in the Property dashboard is not complete', overall(all, NOW) !== 'complete');
check('Everything done and linked is complete', overall({ ...all, propertyId: 'doc1' }, NOW) === 'complete');
check('Brand new is new', overall(fresh(), NOW) === 'new');
check('Late post is attention', overall(t, NOW + 2 * H) === 'attention');
check('Scheduled with no brochure is attention (the gap you want tracked)', overall(t, NOW) === 'attention');
check('Scheduled in future with brochure is started', overall(setBrochure(t, true, 'a', NOW), NOW) === 'started');

// dashboard link
check('Unlinked is a pending gap, not severe', gaps(fresh(), NOW).find(g => g.kind === 'dashboard').sev === 1);
check('Linking clears it', !gaps({ ...fresh(), propertyId: 'doc1' }, NOW).some(g => g.kind === 'dashboard'));
check('Filter nodash', matchesFilter(fresh(), 'nodash', NOW) && !matchesFilter({ ...fresh(), propertyId: 'x' }, 'nodash', NOW));
check('Linking never changes progress', progress({ ...fresh(), propertyId: 'x' }).total === progress(fresh()).total);

// upcoming
const t2 = setChannel(fresh(), 'yt', 'scheduled', { at: NOW - H }, NOW).tracker;
const up = upcoming([t, t2], NOW);
eq('Upcoming is soonest first and flags due', up.map(r => [r.key, r.due]), [['yt', true], ['igReel', false]]);

// filters
check('Filter due', matchesFilter(t2, 'due', NOW) && !matchesFilter(t, 'due', NOW));
check('Filter no brochure', matchesFilter(fresh(), 'nobrochure', NOW) && !matchesFilter(b, 'nobrochure', NOW));

// csv
const csv = toCsv([liveNoLink]);
check('CSV has header + one row', csv.split('\r\n').length === 2);
check('CSV quotes commas', toCsv([{ ...fresh(), title: 'a, b' }]).includes('"a, b"'));


// ── links people actually paste ──
check('Bare domain gets https', cleanUrl('instagram.com/reel/abc') === 'https://instagram.com/reel/abc');
check('Full link untouched', cleanUrl('https://x.com/a') === 'https://x.com/a');
check('Words are not a link', !validUrl('done posted') && !validUrl('abc'));
check('Blank is valid (optional)', validUrl('') && validUrl('   '));
check('Bare domain accepted on a live post', setChannel(t, 'igReel', 'live', { url: 'youtu.be/xyz' }, NOW).tracker.channels.igReel.url === 'https://youtu.be/xyz');
check('Spaces are trimmed', setChannelUrl(liveNoLink, 'igReel', '  https://x.com/a  ').tracker.channels.igReel.url === 'https://x.com/a');

// ── scenarios around changing your mind ──
{
  const live = setChannel(t, 'igReel', 'live', { url: 'https://x.com/r' }, NOW).tracker;
  const back = setChannel(live, 'igReel', 'scheduled', { at: NOW + H }, NOW).tracker;
  check('Live back to scheduled keeps the link, drops live time', back.channels.igReel.status === 'scheduled' && back.channels.igReel.liveAt === 0 && back.channels.igReel.url === 'https://x.com/r');
  const na = setChannel(live, 'igReel', 'na', {}, NOW).tracker;
  check('Live to N/A clears the link', na.channels.igReel.url === '' && na.channels.igReel.status === 'na');
  check('N/A post is not a gap nor counted', !gaps(na, NOW).some(g => g.key === 'igReel') && progress(na).total === 6);
  const resched = setChannel(t, 'igReel', 'scheduled', { at: NOW + 5 * H }, NOW).tracker;
  check('Rescheduling a due post un-dues it', gaps(resched, NOW + 2 * H).every(g => g.kind !== 'due'));
  check('Posts one minute from now is not due yet', !channelView({ status: 'scheduled', at: NOW + 60000 }, NOW).due);
  check('Posts exactly at the time are due', channelView({ status: 'scheduled', at: NOW }, NOW).due);
  check('Unknown channel refused', !setChannel(t, 'tiktok', 'live', {}, NOW).ok);
  check('Unknown status refused', !setChannel(t, 'igReel', 'done', {}, NOW).ok);
  const back2 = setListing(setListing(fresh(), 'acres99', 'posted', { url: 'https://99acres.com/a' }, NOW).tracker, 'acres99', 'pending', {}, NOW).tracker;
  check('Un-posting a listing makes it pending again', back2.acres99.status === 'pending' && gaps(back2, NOW).some(g => g.kind === 'acres99'));
  check('Setting a listing N/A then pending is allowed', setListing(na0(), 'website', 'pending', {}, NOW).ok);
  function na0() { return setListing(fresh(), 'website', 'na', {}, NOW).tracker; }
}
check('Everything N/A and brochure done is complete once linked', (() => {
  let x = { ...fresh(), propertyId: 'p' };
  for (const k of ['igStory', 'igReel', 'fbReel', 'yt']) x = setChannel(x, k, 'na', {}, NOW).tracker;
  x = setListing(setListing(x, 'acres99', 'na', {}, NOW).tracker, 'website', 'na', {}, NOW).tracker;
  x = setBrochure(x, true, 'a', NOW);
  return overall(x, NOW) === 'complete' && progress(x).pct === 100;
})());
check('Legacy doc with nothing but a code still works', gaps({ propertyCode: 'X1' }, NOW).length > 0 && progress({ propertyCode: 'X1' }).total === 7);
check('Garbage channels object is ignored', normalizeTracker({ channels: 'x', brochure: 5, acres99: null }).channels.yt.status === 'yet');
check('Id is stable for the same code in any case/spacing', trackerId('tnag 0002') === trackerId(' TNAG-0002'.replace('-', ' ')));
check('Blank code gives no id', trackerId('  /  ') === '');

// ── tasks ──
{
  const a = setChannel(fresh(), 'igReel', 'scheduled', { at: NOW - H }, NOW).tracker;           // due, no brochure
  const b = blankTracker({ propertyCode: 'B1' }, NOW);                                           // nothing shared
  const groups = tasks([a, b], NOW);
  eq('Tasks come in working order', groups.map(g => g.kind), ['due', 'brochure', 'photos', 'details', 'yet', 'acres99', 'website', 'dashboard']);
  check('Due task names the property and channel', groups[0].items[0].id === a.id && groups[0].items[0].keys[0] === 'igReel');
  check('Severe brochure task sorts above routine', groups[1].items[0].id === a.id);
  check('Unscheduled groups all channels of a property in one row', groups.find(g => g.kind === 'yet').items.find(i => i.id === b.id).keys.length === 4);
  eq('Nothing to do means no groups', tasks([{ ...all, propertyId: 'p' }], NOW), []);
  eq('No properties means no tasks', tasks([], NOW), []);
}
// ── summary ──
eq('Summary counts', summary([fresh(), t, { ...all, propertyId: 'p' }], NOW + 2 * H), { total: 3, complete: 1, attention: 1, scheduled: 0, due: 1 });
check('Note is searchable data and exported', toCsv([{ ...fresh(), note: 'CEO: Reel Friday 6pm' }]).includes('CEO: Reel Friday 6pm'));

// ── ids: random, never the code ──
{
  const a = blankTracker({ propertyCode: 'TNAG0002' }, NOW, 'a'), b2 = blankTracker({ propertyCode: 'TNAG0002' }, NOW, 'a');
  check('A new row id is not the property code', a.id !== 'TNAG0002' && a.id !== trackerId('TNAG0002') && /^pt_/.test(a.id), a.id);
  check('…and two rows with the same code (two tenants) get different ids', a.id !== b2.id);
  check('…the code is kept as a field', a.propertyCode === 'TNAG0002');
}

// ── saving only what changed ──
{
  const base = fresh();
  eq('Nothing changed → nothing to write', changedPaths(base, { ...base }), []);
  eq('The id and the "changed by" stamp are not a change', changedPaths(base, { ...base, updatedAt: NOW + 5, updatedBy: 'z', tenantId: 'x' }), []);
  const reel = setChannel(base, 'igReel', 'scheduled', { at: NOW + H }, NOW).tracker;
  eq('A channel change is written per channel', changedPaths(base, reel), ['channels.igReel']);
  const two = setChannel(setBrochure(reel, true, 'a', NOW), 'yt', 'na', {}, NOW).tracker;
  eq('Several changes: each field, each channel', changedPaths(base, two).sort(), ['brochure', 'channels.igReel', 'channels.yt']);
  eq('A note typed in is one top-level field', changedPaths(base, { ...base, note: 'x' }), ['note']);
  eq('A field removed is a change too', changedPaths({ ...base, extra: 1 }, base), ['extra']);
  check('Key order does not count as a change', changedPaths(base, { ...base, brochure: { by: base.brochure.by, at: base.brochure.at, done: base.brochure.done } }).length === 0);
  check('getPath reads a channel', getPath(reel, 'channels.igReel').status === 'scheduled' && getPath(reel, 'channels.nope.x') === undefined);

  // Undo: I scheduled the Reel; meanwhile someone else wrote a note and set YouTube N/A.
  const mine = changedPaths(base, reel);
  const nowOnServer = setChannel({ ...reel, note: 'from someone else' }, 'yt', 'na', {}, NOW).tracker;
  const undone = copyPaths(nowOnServer, base, mine);
  check('Undo puts back only what that change touched', undone.channels.igReel.status === 'yet' && undone.channels.igReel.at === 0);
  check('…and keeps what others changed since', undone.note === 'from someone else' && undone.channels.yt.status === 'na');
  eq('…so the undo itself writes only that channel', changedPaths(nowOnServer, undone), ['channels.igReel']);
  check('…without touching the objects it was given', nowOnServer.channels.igReel.status === 'scheduled');
  check('Undo of a field that did not exist removes it', !('extra' in copyPaths({ ...base, extra: 1 }, base, ['extra'])));
}

// ── N/A has no planned day ──
{
  const planned = normalizeTracker({ channels: { igStory: { status: 'yet', day: NOW } } });
  check('N/A clears the planned day', setChannel(planned, 'igStory', 'na', {}, NOW).tracker.channels.igStory.day === 0);
  check('Back to "yet" keeps it', setChannel(planned, 'igStory', 'yet', {}, NOW).tracker.channels.igStory.day === NOW);
}

// ── links from the dashboard ──
check('A javascript: link from the dashboard is dropped', webLink('javascript:alert(1)') === '' && webLink('drive.google.com/x') === 'https://drive.google.com/x' && webLink('') === '');

// ── CSV dates are local: a day planned in Chennai is that day, not the one before (UTC) ──
{
  const tz = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  const mon = new Date(2025, 9, 6).getTime();     // Monday 6 Oct 2025, 00:00 IST = 5 Oct 18:30 UTC
  const row = toCsv([blankTracker({ reference: 'Lux49', plannedDate: mon }, NOW, 'a')]).split('\r\n')[1];
  check('CSV planned date in IST is the local day', row.startsWith('2025-10-06,'), row.slice(0, 12));
  if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
}

console.log(failed ? `\n${failed} failure(s)` : '\nAll good.');
process.exit(failed ? 1 : 0);
