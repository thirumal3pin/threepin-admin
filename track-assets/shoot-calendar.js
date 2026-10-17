// ═══════ SHOOT & MEDIA — THE CALENDAR ═══════
//
// Shoots, edit plans and posts on one calendar, each in its own colour: blue a shoot, purple an edit,
// green a post. One kind can be shown on its own, and one person's work on its own (an individual
// calendar) — the shoots they are booked on, the edits they plan, and the posts of those properties.
//
// This file only lays the calendar out and draws it. app.js builds the events (it knows the cards)
// and keeps the choices (week or month, the day shown, the kind, the person); clicks call its window
// functions: calMove, calToday, calSpan, calType, calPerson, calPick, calOpen.
//
// An event: { id, type: 'shoot'|'edit'|'post', title, what, start, end, allDay, people: [names],
//   late, done, open: { kind: 'listing'|'post', id } }. A timed event runs start → end; an all-day
// one covers every day from start's day to the day before end (an edit: plan day → delivery day).
//
// Layout rule: nothing scrolls sideways. The week's seven columns become a day-by-day list on a
// phone, and the month's chips become dots there, with the chosen day's list under the grid.

export const DAY = 86400000, HOUR = 3600000;
export const TYPES = [['shoot', 'Shoots'], ['edit', 'Edits'], ['post', 'Posts']];
const TYPE_ONE = { shoot: 'Shoot', edit: 'Edit', post: 'Post' };
const ICON = { shoot: 'fa-solid fa-camera', edit: 'fa-solid fa-scissors', post: 'fa-solid fa-bullhorn' };
const PX_PER_HOUR = 44;

export function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
// Days are counted on the calendar, not in 24-hour steps, so a clock change never shifts a day.
export function addDays(ts, n) { const d = new Date(startOfDay(ts)); d.setDate(d.getDate() + n); return d.getTime(); }
// Weeks run Monday to Sunday, like the Posting plan's "Week of".
export function startOfWeek(ts) { const d = new Date(startOfDay(ts)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
export function startOfMonth(ts) { const d = new Date(startOfDay(ts)); d.setDate(1); return d.getTime(); }

// The days a span shows: a week, or the whole weeks that hold a month.
export function windowFor(span, at) {
  if (span === 'month') {
    const m = startOfMonth(at), next = new Date(m); next.setMonth(next.getMonth() + 1);
    const from = startOfWeek(m), to = addDays(startOfWeek(next.getTime() - 1), 7);
    return { from, to, days: daysBetween(from, to) };
  }
  const from = startOfWeek(at), to = addDays(from, 7);
  return { from, to, days: daysBetween(from, to) };
}
function daysBetween(from, to) { const out = []; for (let d = from; d < to; d = addDays(d, 1)) out.push(d); return out; }
export function move(span, at, dir) {
  if (span === 'month') { const d = new Date(startOfMonth(at)); d.setMonth(d.getMonth() + dir); return d.getTime(); }
  return addDays(at, 7 * dir);
}

// The kind, the person and the search box, applied. A post belongs to the people of its property.
export function filterEvents(events, { type, person, q } = {}, same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()) {
  const query = String(q || '').trim().toLowerCase();
  return (events || []).filter(e => (!type || type === 'all' || e.type === type)
    && (!person || (e.people || []).some(p => same(p, person)))
    && (!query || [e.title, e.what, ...(e.people || []), e.code].filter(Boolean).join(' ').toLowerCase().includes(query)));
}

// The events touching a day: the all-day ones first (late, then by kind), then the timed by start.
const TYPE_ORDER = { shoot: 0, edit: 1, post: 2 };
export function onDay(events, day) {
  const end = addDays(day, 1);
  return events.filter(e => e.start < end && (e.end || e.start + 1) > day)
    .sort((a, b) => (b.allDay - a.allDay) || (a.allDay ? (b.late - a.late) || (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) : a.start - b.start) || String(a.title).localeCompare(String(b.title)));
}

// Overlapping timed events share the column's width, side by side.
export function lanes(blocks) {
  const sorted = blocks.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const ends = [];
  for (const b of sorted) { let l = 0; while (l < ends.length && ends[l] > b.from) l++; b.lane = l; ends[l] = b.to; }
  // The width is shared only among the blocks that actually overlap one another.
  for (const b of sorted) b.lanes = 1 + Math.max(...sorted.filter(o => o.from < b.to && o.to > b.from).map(o => o.lane));
  return sorted;
}

// The hours the week's grid shows: 8am to 9pm, stretched to fit anything earlier or later.
export function fitHours(events, days) {
  let open = 8, close = 21;
  for (const e of events) {
    if (e.allDay) continue;
    const d0 = startOfDay(e.start);
    if (!days.includes(d0)) continue;
    open = Math.min(open, Math.floor((e.start - d0) / HOUR));
    close = Math.max(close, Math.ceil((Math.min(e.end || e.start, addDays(d0, 1)) - d0) / HOUR));
  }
  return { open: Math.max(0, open), close: Math.min(24, Math.max(open + 1, close)) };
}

// How many of each kind start in the window, and how many are late.
export function summary(events, from, to) {
  const inWin = events.filter(e => e.start < to && (e.end || e.start + 1) > from);
  const n = { shoot: 0, edit: 0, post: 0, late: 0 };
  for (const e of inWin) { n[e.type]++; if (e.late) n.late++; }
  return n;
}

// ═══════ DRAWING ═══════
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsq = v => esc(JSON.stringify(String(v == null ? '' : v)));
const F_TIME = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const F_HOUR = new Intl.DateTimeFormat([], { hour: 'numeric' });
const F_WD = new Intl.DateTimeFormat([], { weekday: 'short' });
const F_DM = new Intl.DateTimeFormat([], { day: 'numeric', month: 'short' });
const F_MON = new Intl.DateTimeFormat([], { month: 'short' });
const F_DMY = new Intl.DateTimeFormat([], { day: 'numeric', month: 'short', year: 'numeric' });
const F_MY = new Intl.DateTimeFormat([], { month: 'long', year: 'numeric' });
const F_LONG = new Intl.DateTimeFormat([], { weekday: 'long', day: 'numeric', month: 'long' });
const clock = ts => F_TIME.format(ts).replace(/\s/g, '').toLowerCase();

const cls = e => `tc-ev t-${e.type}${e.late ? ' late' : ''}${e.done ? ' done' : ''}`;
// (A chip sits inside a month's day, which picks the day: opening the chip must not also pick it.)
const openAttr = e => e.open ? ` role="button" tabindex="0" onclick="event.stopPropagation();calOpen(${jsq(e.open.kind)},${jsq(e.open.id)},${Number(e.start) || 0})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"` : '';
// When it is, in words: a time, or for an all-day one its first and last day.
function whenText(e) {
  if (!e.allDay) return clock(e.start);
  const last = addDays(e.end, -1);
  return last > e.start ? `${F_DM.format(e.start)} → ${F_DM.format(last)}` : 'All day';
}
const status = e => e.late ? ' · late' : e.done ? ' · done' : '';
const tip = e => `${TYPE_ONE[e.type]}${status(e)} — ${e.title}${e.what ? ' · ' + e.what : ''}\n${e.allDay ? whenText(e) : F_DM.format(e.start) + ', ' + clock(e.start)}${e.people && e.people.length ? '\n' + e.people.join(', ') : ''}`;
// The outlets' own logos — the Posting tab's: Instagram (the Story with its ring, the Reel with a play
// badge), Facebook, YouTube; a handshake for a collab, an ad mark for ads, a film for a whole video.
const LOGO = { igStory: 'fa-brands fa-instagram', igReel: 'fa-brands fa-instagram', fbReel: 'fa-brands fa-facebook', yt: 'fa-brands fa-youtube', collab: 'fa-solid fa-handshake', ads: 'fa-solid fa-rectangle-ad', all: 'fa-solid fa-film' };
const OUTLET_NAME = { igStory: 'Insta Story', igReel: 'Insta Reel', fbReel: 'Facebook Reel', yt: 'YouTube', collab: 'Collab', ads: 'Ads', all: 'Video' };
const logos = e => (e.outlets || []).filter(k => LOGO[k]).map(k => `<span class="ci ci-${k} tc-logo" title="${esc(OUTLET_NAME[k])}"><i class="${LOGO[k]}" aria-hidden="true"></i></span>`).join('');
// On a chip or a block, one small mark in the old icon's place — a tile never grows: a shoot's camera;
// an edit's or a post's first outlet as a bare logo in its colour (the tip names them all).
const glyph = e => { const k = e.type !== 'shoot' && (e.outlets || []).find(o => LOGO[o]); return k ? `<i class="${LOGO[k]} tc-glyph g-${k}" aria-hidden="true"></i>` : ''; };
const icon = e => glyph(e) || `<i class="${ICON[e.type]}" aria-hidden="true"></i>`;const tick = e => e.done ? '<span class="tc-tick" aria-label="done">✓</span>' : '';

// A chip: in the month's cells and the week's all-day row.
function chip(e, day) {
  const first = startOfDay(e.start) === day, last = addDays(e.end, -1) <= day;
  const span = e.allDay && addDays(e.end, -1) > startOfDay(e.start);
  // A plan of several days says where in it this day is: its start, the days between, the delivery.
  const mark = span ? (first ? '' : last ? 'Due · ' : '… ') : '';
  return `<span class="${cls(e)} tc-chip" title="${esc(tip(e))}"${openAttr(e)}>${icon(e)}${tick(e)}<span class="tc-chip-t">${e.allDay ? '' : `<b>${esc(clock(e.start))}</b> `}${esc(mark)}${esc(e.title)}${e.what ? `<span class="tc-chip-w"> · ${esc(e.what)}</span>` : ''}</span></span>`;
}
// A row: in the phone's week list and under the month.
function row(e) {
  return `<div class="${cls(e)} tc-row" title="${esc(tip(e))}"${openAttr(e)}>
    <span class="tc-row-when">${esc(whenText(e))}</span>
    <span class="tc-row-main"><span class="tc-row-t"><i class="${ICON[e.type]}" aria-hidden="true"></i>${tick(e)} ${esc(e.title)}${logos(e) ? `<span class="tc-logos">${logos(e)}</span>` : ''}</span>
      <span class="tc-row-s">${esc(TYPE_ONE[e.type])}${e.what ? ' · ' + esc(e.what) : ''}${e.people && e.people.length ? ' · ' + esc(e.people.join(', ')) : ''}${e.late ? ' · <b class="tc-late">late</b>' : e.done ? ' · done' : ''}</span></span>
  </div>`;
}
const dayList = (events, day, empty) => {
  const list = onDay(events, day);
  return list.length ? list.map(row).join('') : `<div class="tc-none">${esc(empty)}</div>`;
};

// The bar above: back, today, forward, what is shown; week or month; the kind; the person; the key.
export function headHtml(st, events, now) {
  const w = windowFor(st.span, st.at);
  const label = st.span === 'month' ? F_MY.format(st.at) : `${F_DM.format(w.from)} – ${F_DMY.format(addDays(w.to, -1))}`;
  const isNow = now >= w.from && now < w.to && (st.span !== 'month' || startOfMonth(now) === startOfMonth(st.at));
  const n = summary(events, st.span === 'month' ? startOfMonth(st.at) : w.from, st.span === 'month' ? move('month', st.at, 1) : w.to);
  const seg = (list, on, fn, aria) => `<div class="tk-sortbar tc-seg" role="group" aria-label="${esc(aria)}">${list.map(([k, l]) =>
    `<button type="button" class="tk-sbtn${on === k ? ' on' : ''}" aria-pressed="${on === k}" onclick="${fn}(${jsq(k)})">${k !== 'all' && TYPE_ONE[k] ? `<i class="tc-key t-${k}" aria-hidden="true"></i>` : ''}${esc(l)}</button>`).join('')}</div>`;
  const people = st.peopleList || [];
  const count = (k, one) => `<span class="tc-n t-${k}"><i class="tc-key t-${k}" aria-hidden="true"></i><b>${n[k]}</b> ${one}${n[k] === 1 ? '' : 's'}</span>`;
  return `<div class="tc-head">
    <div class="tc-nav">
      <button type="button" class="tk-btn sm ghost tc-arrow" onclick="calMove(-1)" aria-label="Back">‹</button>
      <button type="button" class="tk-btn sm ghost" onclick="calToday()"${isNow ? ' disabled' : ''}>Today</button>
      <button type="button" class="tk-btn sm ghost tc-arrow" onclick="calMove(1)" aria-label="Forward">›</button>
      <b class="tc-date">${esc(label)}</b>
    </div>
    <div class="tc-acts">
      ${seg([['week', 'Week'], ['month', 'Month']], st.span, 'calSpan', 'Week or month')}
      ${seg([['all', 'All'], ...TYPES], st.type || 'all', 'calType', 'What to show')}
      <label class="tk-dd tk-dd-pick tc-who${st.person ? ' on' : ''}"><span class="tk-dd-k">Person</span>
        <select onchange="calPerson(this.value)" aria-label="Whose calendar">${['', ...people].map(p => `<option value="${esc(p)}"${(p === '' ? !st.person : p === st.person) ? ' selected' : ''}>${p ? esc(p) : 'Everyone'}</option>`).join('')}</select></label>
    </div>
  </div>
  <div class="tc-sum">${st.type === 'all' || !st.type ? count('shoot', 'shoot') + count('edit', 'edit') + count('post', 'post') : count(st.type, TYPE_ONE[st.type].toLowerCase())}${n.late ? `<span class="tc-n tc-late-n"><b>${n.late}</b> late</span>` : ''}${st.person ? `<span class="tc-for">${esc(st.person)}’s calendar${(!st.type || st.type === 'all' || st.type === 'post') ? ' · posts of their properties' : ''}</span>` : ''}</div>`;
}

// ── A WEEK ── seven columns of hours on a desk; a list of the seven days on a phone.
export function weekHtml(st, events, now) {
  const { days } = windowFor('week', st.at);
  const today = startOfDay(now);
  const { open, close } = fitHours(events, days);
  const top0 = h => h * PX_PER_HOUR;
  const hours = [];
  for (let h = open; h < close; h++) hours.push(`<div class="tc-hr" style="height:${PX_PER_HOUR}px">${esc(F_HOUR.format(addDays(today, 0) + h * HOUR).replace(/\s/g, '').toLowerCase())}</div>`);
  const head = days.map(d => `<div class="tc-wh${d === today ? ' today' : ''}"><b>${esc(F_WD.format(d))}</b><span>${new Date(d).getDate()}</span></div>`).join('');
  const allDay = days.map(d => `<div class="tc-wa${d === today ? ' today' : ''}">${onDay(events, d).filter(e => e.allDay).map(e => chip(e, d)).join('')}</div>`).join('');
  const cols = days.map(d => {
    const start = d + open * HOUR, end = d + close * HOUR;
    const blocks = lanes(onDay(events, d).filter(e => !e.allDay && e.start < end && e.end > start)
      .map(e => ({ e, from: Math.max(e.start, start), to: Math.min(Math.max(e.end, e.start + 30 * 60000), end) })));
    const nowLine = d === today && now >= start && now < end ? `<div class="tc-now" style="top:${((now - start) / HOUR * PX_PER_HOUR).toFixed(1)}px" aria-hidden="true"></div>` : '';
    return `<div class="tc-wc${d === today ? ' today' : ''}" style="height:${(close - open) * PX_PER_HOUR}px">${blocks.map(b => {
      const top = (b.from - start) / HOUR * PX_PER_HOUR, h = Math.max(20, (b.to - b.from) / HOUR * PX_PER_HOUR - 2), wd = 100 / b.lanes;
      return `<div class="${cls(b.e)} tc-blk" style="top:${top.toFixed(1)}px;height:${h.toFixed(1)}px;left:${(b.lane * wd).toFixed(2)}%;width:calc(${wd.toFixed(2)}% - 3px)" title="${esc(tip(b.e))}"${openAttr(b.e)}>
        <span class="tc-blk-t">${icon(b.e)}${tick(b.e)} ${esc(b.e.title)}</span>${h > 30 ? `<span class="tc-blk-s">${esc(clock(b.e.start))}${b.e.what ? ' · ' + esc(b.e.what) : ''}</span>` : ''}</div>`;
    }).join('')}${nowLine}</div>`;
  }).join('');
  const desk = `<div class="tc-week">
    <div class="tc-wrow tc-whead"><div class="tc-gut"></div>${head}</div>
    <div class="tc-wrow tc-wall"><div class="tc-gut">All day</div>${allDay}</div>
    <div class="tc-wrow tc-wgrid"><div class="tc-gut tc-hours">${hours.join('')}</div>${cols}</div>
  </div>`;
  const list = `<div class="tc-agenda">${days.map(d => `<section class="tc-aday${d === today ? ' today' : ''}">
      <div class="tc-aday-h"><b>${esc(F_WD.format(d))} ${new Date(d).getDate()}</b><span>${esc(F_MON.format(d))}</span>${d === today ? '<em>Today</em>' : ''}</div>
      ${dayList(events, d, 'Nothing')}</section>`).join('')}</div>`;
  return desk + list;
}

// ── A MONTH ── up to three chips a day on a desk, dots on a phone; the chosen day listed beneath.
export function monthHtml(st, events, now) {
  const { days } = windowFor('month', st.at);
  const today = startOfDay(now), month = new Date(st.at).getMonth();
  const head = days.slice(0, 7).map(d => `<div class="tc-mh">${esc(F_WD.format(d))}</div>`).join('');
  const cells = days.map(d => {
    const list = onDay(events, d), shown = list.slice(0, 3);
    const kinds = TYPES.map(([k]) => k).filter(k => list.some(e => e.type === k));
    const other = new Date(d).getMonth() !== month;
    return `<div class="tc-md${d === today ? ' today' : ''}${other ? ' other' : ''}${d === st.sel ? ' sel' : ''}" role="button" tabindex="0" aria-label="${esc(F_LONG.format(d))}: ${list.length} on the calendar" onclick="calPick(${d})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();calPick(${d})}">
      <span class="tc-mn">${new Date(d).getDate()}</span>
      <div class="tc-mchips">${shown.map(e => chip(e, d)).join('')}${list.length > shown.length ? `<span class="tc-more">+${list.length - shown.length} more</span>` : ''}</div>
      <div class="tc-mdots" aria-hidden="true">${kinds.map(k => `<i class="tc-key t-${k}${list.some(e => e.type === k && e.late) ? ' late' : ''}"></i>`).join('')}${list.length ? `<span>${list.length}</span>` : ''}</div>
    </div>`;
  }).join('');
  const sel = st.sel && days.includes(st.sel) ? st.sel : null;
  const pane = sel ? `<section class="tc-daypane"><div class="tc-aday-h"><b>${esc(F_LONG.format(sel))}</b>${sel === today ? '<em>Today</em>' : ''}</div>${dayList(events, sel, 'Nothing on this day')}</section>` : '<div class="tc-hint">Pick a day to see everything on it.</div>';
  return `<div class="tc-month"><div class="tc-mgrid">${head}${cells}</div></div>${pane}`;
}

export function bodyHtml(st, events, now) {
  return st.span === 'month' ? monthHtml(st, events, now) : weekHtml(st, events, now);
}
