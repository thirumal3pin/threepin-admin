// The Shoot & Media calendar: its days, its filters, its layout.   node tests/shoot-calendar.test.mjs
import { startOfDay, startOfWeek, addDays, windowFor, move, filterEvents, onDay, lanes, fitHours, summary, headHtml, bodyHtml } from '../track-assets/shoot-calendar.js';

let failed = 0;
const check = (label, cond, detail) => { if (!cond) { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
const eq = (l, a, b) => check(l, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const day = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

console.log('3 PIN Realty — Shoot & Media calendar');

// Days and windows
const WED = day(2026, 10, 14, 15, 30);
eq('A week starts on Monday', startOfWeek(WED), day(2026, 10, 12));
eq('…and a Sunday belongs to the week before it', startOfWeek(day(2026, 10, 18, 9)), day(2026, 10, 12));
const wk = windowFor('week', WED);
eq('A week is seven days, Monday to Sunday', [wk.days.length, wk.from, wk.to], [7, day(2026, 10, 12), day(2026, 10, 19)]);
const mo = windowFor('month', WED);
check('A month is whole weeks', mo.days.length % 7 === 0 && new Date(mo.from).getDay() === 1, mo.days.length);
check('…holding its first and last day', mo.days.includes(day(2026, 10, 1)) && mo.days.includes(day(2026, 10, 31)) && !mo.days.includes(day(2026, 11, 3)));
eq('Forward a week', move('week', WED, 1), addDays(WED, 7));
eq('Back a month, from the 31st, lands in the month before', new Date(move('month', day(2026, 10, 31), -1)).getMonth(), 8);
eq('Forward a month from December is January', new Date(move('month', day(2026, 12, 15), 1)).getFullYear(), 2027);
check('Days are calendar days (every day starts at midnight)', wk.days.every(d => d === startOfDay(d)));

// Events
const ev = [
  { id: 's1', type: 'shoot', title: 'Velachery 2BHK', what: 'VLCA002', start: day(2026, 10, 14, 10), end: day(2026, 10, 14, 11), allDay: false, people: ['Ravi'], late: false, done: false },
  { id: 's2', type: 'shoot', title: 'Adyar flat', start: day(2026, 10, 14, 10, 30), end: day(2026, 10, 14, 11, 30), allDay: false, people: ['Kumar'], late: false, done: false },
  { id: 'e1', type: 'edit', title: 'Velachery 2BHK', what: 'Story + Reel', start: day(2026, 10, 13), end: day(2026, 10, 16), allDay: true, people: ['Anu'], late: true, done: false, open: { kind: 'listing', id: 'L1' } },
  { id: 'p1', type: 'post', title: 'Velachery 2BHK', what: 'YouTube', start: day(2026, 10, 15, 19), end: day(2026, 10, 15, 19, 30), allDay: false, people: ['Ravi', 'Anu'], late: false, done: false },
  { id: 'p2', type: 'post', title: 'T Nagar villa', what: 'Insta Story · planned', start: day(2026, 10, 14), end: day(2026, 10, 15), allDay: true, people: [], late: false, done: false }
];
eq('All kinds', filterEvents(ev, { type: 'all' }).length, 5);
eq('One kind on its own', filterEvents(ev, { type: 'shoot' }).map(e => e.id), ['s1', 's2']);
eq('One person: their shoot, their edit, the posts of their properties', filterEvents(ev, { person: 'anu ' }).map(e => e.id), ['e1', 'p1']);
eq('A person and a kind together', filterEvents(ev, { person: 'Ravi', type: 'post' }).map(e => e.id), ['p1']);
eq('A post nobody is on shows only for everyone', filterEvents(ev, { person: 'Kumar', type: 'post' }).length, 0);
eq('The search box: by name, outlet or person', [filterEvents(ev, { q: 'velachery' }).length, filterEvents(ev, { q: 'youtube' }).length, filterEvents(ev, { q: 'kumar' }).length], [3, 1, 1]);

eq('A day: the all-day first (late first), then by time', onDay(ev, day(2026, 10, 14)).map(e => e.id), ['e1', 'p2', 's1', 's2']);
eq('An edit plan covers every day from plan to delivery', [day(2026, 10, 12), day(2026, 10, 13), day(2026, 10, 15), day(2026, 10, 16)].map(d => onDay(ev, d).some(e => e.id === 'e1')), [false, true, true, false]);

const ls = lanes([{ from: 10, to: 20 }, { from: 15, to: 25 }, { from: 30, to: 40 }]);
eq('Overlapping events share the width', ls.map(b => [b.lane, b.lanes]), [[0, 2], [1, 2], [0, 1]]);

eq('The hours: 8am to 9pm by default', fitHours([], wk.days), { open: 8, close: 21 });
eq('…stretched to fit a 6am shoot', fitHours([{ allDay: false, start: day(2026, 10, 14, 6), end: day(2026, 10, 14, 7) }], wk.days).open, 6);
eq('…and not by one in another week', fitHours([{ allDay: false, start: day(2026, 11, 14, 6), end: day(2026, 11, 14, 7) }], wk.days).open, 8);

eq('The count: by kind, and the late', summary(ev, wk.from, wk.to), { shoot: 2, edit: 1, post: 2, late: 1 });

// Drawing
const st = { span: 'week', type: 'all', person: '', at: WED, sel: null, peopleList: ['Anu', 'Kumar', 'Ravi'] };
const NOW = day(2026, 10, 14, 12);
const head = headHtml(st, ev, NOW), wkHtml = bodyHtml(st, ev, NOW);
check('The bar: the week shown, the kinds, the people', /12 Oct|Oct 12/.test(head) && /calType\(&quot;edit&quot;\)/.test(head) && /<option value="Kumar"/.test(head));
check('…Today is greyed out on this week', /onclick="calToday\(\)" disabled/.test(head));
check('…and the count of each kind, with the late', /<b>2<\/b> shoots/.test(head) && /<b>1<\/b> edit</.test(head) && /<b>1<\/b> late/.test(head));
check('The week: every event drawn, coloured by its kind', ['t-shoot', 't-edit', 't-post'].every(k => wkHtml.includes(k)) && (wkHtml.match(/tc-blk/g) || []).length >= 3);
check('…two shoots at once side by side', /left:50\.00%/.test(wkHtml));
check('…a late edit marked late', /tc-ev t-edit late/.test(wkHtml));
check('…the phone list holds all seven days', (wkHtml.match(/class="tc-aday( today)?"/g) || []).length === 7);
check('…a click opens it, and never picks the day under it', /event\.stopPropagation\(\);calOpen/.test(wkHtml));
check('Names are escaped', !bodyHtml(st, [{ ...ev[0], title: '<img src=x onerror=alert(1)>' }], NOW).includes('<img src=x'));
const moHtml = bodyHtml({ ...st, span: 'month', sel: day(2026, 10, 14) }, ev, NOW);
check('The month: chips on a desk, dots on a phone', /tc-mchips/.test(moHtml) && /tc-mdots/.test(moHtml));
check('…the chosen day listed beneath', /tc-daypane/.test(moHtml) && /Wednesday, 14 October|Wednesday, October 14/.test(moHtml));
check('…with no day chosen, a hint', /Pick a day/.test(bodyHtml({ ...st, span: 'month', sel: null }, ev, NOW)));
check('A person\'s calendar says so', /Anu’s calendar/.test(headHtml({ ...st, person: 'Anu' }, filterEvents(ev, { person: 'Anu' }), NOW)));
{
  const lg = bodyHtml({ ...st, span: 'month', sel: day(2026, 10, 15) }, [{ ...ev[3], outlets: ['igStory', 'yt', 'ads'] }, { ...ev[0], outlets: ['igReel'] }], NOW);
  check('Posts and edits wear their outlets\' logos (Story, YouTube, Ads)', /ci ci-igStory tc-logo/.test(lg) && /ci ci-yt tc-logo/.test(lg) && /ci ci-ads tc-logo/.test(lg));
  const chips = lg.match(/<span class="tc-ev [^"]*tc-chip"[\s\S]*?<\/span><\/span>/g) || [];
  check('A tile stays lean: one bare logo in the icon\'s place, never the full logos', chips.length > 0 && chips.every(c => !/tc-logo/.test(c) && (c.match(/<i class/g) || []).length === 1) && chips.some(c => /tc-glyph g-igStory/.test(c)), chips.length);
  check('…a shoot keeps its camera on the chip',/tc-ev t-shoot[^"]*tc-chip"[^>]*><i class="fa-solid fa-camera"/.test(lg));
}
check('A timed event is at least 30 minutes tall', (() => { const h = bodyHtml(st, [{ ...ev[0], end: ev[0].start + 60000 }], NOW).match(/tc-blk" style="top:[\d.]+px;height:([\d.]+)px/); return h && Number(h[1]) >= 20; })());

console.log(failed ? `\n${failed} failure(s)` : '\nAll good.');
process.exit(failed ? 1 : 0);
