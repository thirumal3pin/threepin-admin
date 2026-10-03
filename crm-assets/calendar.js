// ═══════ THE TEAM'S DAY ═══════
//
// Who is where, and when everyone is free. The events come from each agent's
// own Google Calendar — threepin.in is a Google Workspace domain, so the CRM
// reads them directly and nobody has to link anything (api/_calendar-shared.js
// explains how, scripts/check-calendar-access.mjs says whether it is switched
// on yet).
//
// It is one page rather than two because the question people actually ask is
// never "what is on my calendar" — they have a phone for that. It is "can we
// all get in a room at four", and answering that needs everybody's day side by
// side, with the free gaps already worked out.
//
// A plain script, like today.js: crm.html bridges the shared modules onto
// window, and everything here draws from what the CRM already has loaded.

(function () {
  'use strict';

  var DAY = 86400000, MIN = 60000, HOUR = 3600000;
  // The grid runs 8am to midnight: a brokerage that shows properties at weekends and evenings does not stop at nine, and a calendar that ends at 9pm cannot show what is booked after it. It is the working day for a
  // brokerage that shows properties at weekends and evenings. But it STRETCHES
  // to whatever the day actually holds: an early site visit or a late call
  // outside a fixed window would otherwise be dropped from the page without
  // saying so, and a calendar that quietly hides an appointment is worse than
  // no calendar. Live data already runs to 8:30pm, half an hour off the edge.
  var DAY_OPEN = 8, DAY_CLOSE = 24;
  var OPEN = DAY_OPEN, CLOSE = DAY_CLOSE;
  var PX_PER_HOUR = 52;

  // Widen the window so nothing falls off it. Whole hours, so the labels stay
  // on the lines.
  function fitWindow(people, from, to) {
    var open = DAY_OPEN, close = DAY_CLOSE;
    var lo = from, hi = to == null ? from + DAY : to;
    (people || []).forEach(function (p) {
      (p.events || []).forEach(function (e) {
        if (e.allDay || !e.start || !e.end) return;
        var a = Date.parse(e.start), b = Date.parse(e.end);
        if (!(b > lo && a < hi)) return;
        // Measured against the event's OWN day, so a week stretches to fit its
        // earliest start and latest finish across all seven.
        var dayStart = startOfDay(a);
        open = Math.min(open, Math.floor((a - dayStart) / HOUR));
        close = Math.max(close, Math.ceil((b - dayStart) / HOUR));
      });
    });
    OPEN = Math.max(0, open);
    CLOSE = Math.min(24, Math.max(OPEN + 1, close));
  }

  // 'day' shows everybody against one set of hours — the question "who is
  // free at four". 'week' and 'month' show ONE person, because six people
  // across seven days is a wall nobody reads, and the question those spans
  // answer is "what has Swami got on" rather than "who is free".
  var state = { at: startOfDay(Date.now()), span: 'day', person: null, people: [], loading: false, error: null, hint: null, seq: 0, blank: false, invites: null, upcoming: null, showAllMine: false, invitesAt: 0 };
  var lastFetch = 0;

  function startOfDay(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(s == null ? '' : s) : String(s == null ? '' : s); }
  function clock(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function who(email) {
    var M = window.crmMentions;
    return (M && email) ? M.displayName(email) : (email || '');
  }
  function startOfWeek(ts) { var d = new Date(startOfDay(ts)); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }
  function startOfMonth(ts) { var d = new Date(startOfDay(ts)); d.setDate(1); return d.getTime(); }
  function endOfMonth(ts) { var d = new Date(startOfMonth(ts)); d.setMonth(d.getMonth() + 1); return d.getTime(); }
  function windowFor() {
    if (state.span === 'week') { var w = startOfWeek(state.at); return { from: w, to: w + 7 * DAY }; }
    if (state.span === 'month') {
      // The grid draws whole weeks, so it needs the days either side that fill
      // the first and last rows.
      var m = startOfMonth(state.at);
      return { from: startOfWeek(m), to: startOfWeek(endOfMonth(state.at) - 1) + 7 * DAY };
    }
    return { from: state.at, to: state.at + DAY };
  }
  function whoFor() {
    // One person for the long spans; everybody for a day.
    if (state.span === 'day') return null;
    return [state.person || defaultPerson() || null].filter(Boolean);
  }

  // ── Getting the day ──
  //
  // Each call reaches five Google calendars, so it is not something to fire on
  // every render. Refetch happens when the window moves or the page has been
  // sitting for a minute, and never twice at once.
  //
  // Opening was slow because every visit started from nothing and waited on
  // Google. Now the last answer for each window is kept on this device and
  // drawn at once, while the fresh one is fetched behind it and swapped in
  // when it lands (stale-while-revalidate). The next day or week is fetched
  // quietly so stepping forward is instant too, and a page that has been in
  // the background refreshes itself the moment it is looked at again.
  var CACHE_PREFIX = 'pinCal:', CACHE_KEEP = 6 * HOUR;
  function keyFor(w) { return w.from + ':' + state.span + ':' + (state.span === 'day' ? '' : (state.person || '')); }
  function readCache(key) {
    try {
      var c = JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || 'null');
      return c && Date.now() - c.at < CACHE_KEEP && Array.isArray(c.people) ? c : null;
    } catch (e) { return null; }
  }
  function writeCache(key, people) {
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), people: people }));
    } catch (e) {
      // Storage full: drop our own old windows and carry on without a cache.
      try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(k); }); } catch (e2) { /* no cache then */ }
    }
  }
  function ask(body) {
    return window.crmAuth.getIdToken().then(function (token) {
      return fetch('/api/tailortalk?action=calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(body)
      });
    }).then(function (r) { return r.json(); });
  }
  function load(force) {
    var w = windowFor();
    var key = keyFor(w);
    var seq = ++state.seq;
    if (!force && Date.now() - lastFetch < 60000 && state.fetchedFor === key) { state.seq--; return; }
    state.error = null;
    state.hint = null;
    // Something to show straight away: the last answer for this window.
    var c = readCache(key);
    if (state.fetchedFor !== key) {
      if (c) { state.people = c.people; state.blank = false; }
      else state.blank = true;
    }
    // A window fetched under 90 seconds ago is not asked for again just because
    // somebody clicked back to it. Only the Refresh button insists.
    if (!force && c && Date.now() - c.at < 90000) {
      state.seq--; state.fetchedFor = key; state.blank = false; state.loading = false;
      render();
      return;
    }
    state.loading = true;
    render();
    ask({ op: 'day', from: w.from, to: w.to, people: whoFor() || [] }).then(function (d) {
      if (seq !== state.seq) return;       // the window moved on while this was in flight
      state.loading = false;
      state.blank = false;
      lastFetch = Date.now();
      state.fetchedFor = key;
      if (d && d.ok) {
        state.people = d.people || []; state.note = d.note || null;
        if (d.team && d.team.length) { state.team = d.team; try { localStorage.setItem(CACHE_PREFIX + 'team', JSON.stringify(d.team)); } catch (e) { /* fine */ } }
        writeCache(key, state.people);
      }
      // Setup that is not finished is not an outage, and must not be drawn as one.
      else { state.error = (d && d.error) || 'Could not read the calendars'; state.hint = (d && d.hint) || null; state.people = []; }
      render();
    }).catch(function () {
      if (seq !== state.seq) return;
      state.loading = false;
      state.blank = false;
      // Still showing the last good answer is better than an error over it.
      if (!state.people.length) state.error = 'Could not reach the calendar service';
      render();
    });
    loadInvites(force);
  }

  // ── Invitations waiting on you ──
  //
  // The grid answers "what is on today". It cannot answer "what am I still
  // owed an answer on", because that lives on days and hours it is not
  // showing: after the evening edge, tomorrow, next week. So it is asked
  // separately: your own calendar for the next fortnight, one call, whatever
  // day the grid is on.
  var INVITE_DAYS = 14;
  function myEmail() { return String(typeof currentUserEmail === 'string' ? currentUserEmail : '').toLowerCase(); }
  function pendingFor(events, me) {
    return (events || []).filter(function (e) {
      if (e.allDay || e.status === 'cancelled' || e.away || e.whereWorking || (e.kind && e.kind !== 'default')) return false;
      if (!(Date.parse(e.end) > Date.now())) return false;
      if (String(e.organiser || '').toLowerCase() === me) return false;
      return (e.attendees || []).some(function (a) { return String(a.email || '').toLowerCase() === me && a.status === 'needsAction'; });
    }).sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); });
  }
  // Everything still ahead of you, answered or not, whoever booked it.
  function upcomingFor(events, me) {
    var limit = Date.now() + INVITE_DAYS * DAY;
    return (events || []).filter(function (e) {
      if (e.allDay || e.status === 'cancelled' || e.away || e.whereWorking) return false;
      if (e.kind && e.kind !== 'default') return false;
      return Date.parse(e.end) > Date.now() && Date.parse(e.start) < limit;
    }).map(function (e) {
      return { id: e.id, title: e.title, start: e.start, end: e.end, where: e.where,
        about: e.about ? String(e.about).slice(0, 600) : null, meet: e.meet, link: e.link,
        organiser: e.organiser, leadId: e.leadId, meetingId: e.meetingId, attendees: e.attendees || [],
        mine: ((e.attendees || []).filter(function (a) { return String(a.email || '').toLowerCase() === me; })[0] || {}).status || null };
    }).sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); }).slice(0, 60);
  }
  // Your own diary is already fetched once for the bell and Daily task. This
  // page reads that copy rather than asking Google for the same fortnight a
  // second time.
  function fromMyDiary() {
    var me = myEmail();
    if (!me || typeof window.getMyEventsAll !== 'function') return;
    var all = window.getMyEventsAll() || [];
    state.invites = pendingFor(all, me);
    state.upcoming = upcomingFor(all, me);
    try { localStorage.setItem(CACHE_PREFIX + 'invites:' + me, JSON.stringify({ at: Date.now(), list: state.invites, upcoming: state.upcoming })); } catch (e) { /* fine */ }
  }
  function loadInvites(force) {
    var me = myEmail();
    if (!me) return;
    if (!state.invites) {
      try {
        var c = JSON.parse(localStorage.getItem(CACHE_PREFIX + 'invites:' + me) || 'null');
        if (c && Array.isArray(c.list)) { state.invites = c.list; state.upcoming = c.upcoming || []; render(); }
      } catch (e) { /* nothing cached */ }
    }
    if (typeof window.refreshMyEvents === 'function') window.refreshMyEvents(!!force);
    if (typeof window.getMyEventsAll === 'function' && (window.getMyEventsAll() || []).length) { fromMyDiary(); render(); }
  }
  function whenOf(e) {
    var t = Date.parse(e.start);
    var day = new Date(t), today = startOfDay(Date.now());
    var label = startOfDay(t) === today ? 'Today' : startOfDay(t) === today + DAY ? 'Tomorrow'
      : day.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    return label + ' \u00b7 ' + clock(t) + ' \u2013 ' + clock(Date.parse(e.end));
  }
  function withOf(e, me) {
    var others = (e.attendees || []).map(function (a) { return a.email; })
      .filter(function (x) { return x && String(x).toLowerCase() !== me; });
    if (!others.length) return 'just you';
    var names = others.slice(0, 3).map(who).join(', ');
    return 'with ' + names + (others.length > 3 ? ' +' + (others.length - 3) : '');
  }
  var MINE_CHIP = { accepted: 'Coming', declined: 'Not coming', tentative: 'Maybe', needsAction: 'Reply needed' };
  function invitesHtml() {
    var me = myEmail();
    var waiting = state.invites || [], ahead = state.upcoming || [];
    if (!waiting.length && !ahead.length) return '';
    var rows = waiting.map(function (e) {
      var id = esc(e.id);
      var acts = e.leadId
        ? '<button type="button" class="tt-btn" onclick="PinCalendar.openEvent(\'' + id + '\')">Open</button>'
        : '<button type="button" class="tt-btn" onclick="PinCalendar.quickAnswer(\'' + id + '\',\'accepted\')">I can come</button>'
          + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.quickAnswer(\'' + id + '\',\'declined\')">Can\u2019t make it</button>';
      return '<div class="cal-inv-row"><button type="button" class="cal-inv-t" onclick="PinCalendar.openEvent(\'' + id + '\')">'
        + '<b>' + esc(e.title) + '</b><span>' + esc(whenOf(e)) + (e.organiser ? ' \u00b7 from ' + esc(who(e.organiser)) : '') + '</span></button>'
        + '<div class="cal-inv-a">' + acts + '</div></div>';
    }).join('');
    var shown = state.showAllMine ? ahead : ahead.slice(0, 5);
    var mineRows = shown.map(function (e) {
      var id = esc(e.id);
      return '<div class="cal-inv-row"><button type="button" class="cal-inv-t" onclick="PinCalendar.openEvent(\'' + id + '\')">'
        + '<b>' + esc(e.title) + '</b><span>' + esc(whenOf(e)) + ' \u00b7 ' + esc(withOf(e, me)) + '</span></button>'
        + (e.mine ? '<span class="cal-chip ' + esc(e.mine) + '">' + esc(MINE_CHIP[e.mine] || e.mine) + '</span>' : '') + '</div>';
    }).join('');
    var more = ahead.length > 5
      ? '<button type="button" class="cal-inv-more" onclick="PinCalendar.toggleMine()">' + (state.showAllMine ? 'Show fewer' : 'Show all ' + ahead.length) + '</button>' : '';
    return '<div class="cal-inv" role="region" aria-label="Your meetings">'
      + (waiting.length ? '<div class="cal-inv-h">Waiting for your answer <span>' + waiting.length + '</span></div>' + rows : '')
      + (ahead.length ? '<div class="cal-inv-h plain">Your upcoming meetings <span>' + ahead.length + '</span></div>' + mineRows + more : '')
      + '</div>';
  }
  function quickAnswer(id, response) {
    evState = { id: id, loading: false, data: null, error: null };
    if (response === 'declined') return decline();
    answer(response, '');
  }

  // ── Status, the way Teams shows it ──
  function statusOf(person) {
    var now = Date.now();
    // A day off is not a busy hour, and must not be read as one. Google can
    // also be set to auto-decline invitations sent during out-of-office, so
    // booking somebody on leave comes back as a refusal they never made.
    var off = (person.events || []).filter(function (e) {
      return e.away && Date.parse(e.start) <= now && Date.parse(e.end) > now;
    })[0];
    if (off) return { cls: 'away', text: off.title && !/^out of office$/i.test(off.title) ? off.title : 'on leave' };
    var place = (person.events || []).filter(function (e) {
      return e.whereWorking && Date.parse(e.start) <= now && Date.parse(e.end) > now;
    })[0];
    var on = (person.events || []).filter(function (e) {
      return e.busy && !e.allDay && Date.parse(e.start) <= now && Date.parse(e.end) > now;
    }).sort(function (a, b) { return Date.parse(b.end) - Date.parse(a.end); })[0];
    if (on) return { cls: 'busy', text: 'in ' + (on.leadId ? 'a site visit' : 'a meeting') + ' until ' + clock(Date.parse(on.end)) };
    var next = (person.events || []).filter(function (e) {
      return e.busy && !e.allDay && Date.parse(e.start) > now;
    }).sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); })[0];
    if (next) {
      var mins = Math.round((Date.parse(next.start) - now) / MIN);
      // "Free until 3:30" is only useful while it is still today.
      if (mins < 12 * 60) return { cls: 'free', text: 'free until ' + clock(Date.parse(next.start)) + (place ? ' \u00b7 ' + place.whereWorking : '') };
    }
    return { cls: 'free', text: place ? place.whereWorking : 'free' };
  }

  // ── Laying the day out ──
  //
  // Events that overlap have to share the width, or the one underneath is
  // invisible and somebody gets double-booked. Columns are assigned greedily:
  // an event takes the first lane whose last event has already finished.
  function lanes(events) {
    var sorted = events.slice().sort(function (a, b) { return a.from - b.from; });
    var ends = [];
    sorted.forEach(function (e) {
      var lane = 0;
      while (lane < ends.length && ends[lane] > e.from) lane++;
      e.lane = lane;
      ends[lane] = e.to;
    });
    var width = Math.max(1, ends.length);
    sorted.forEach(function (e) { e.lanes = width; });
    return sorted;
  }

  function blocksFor(events, dayStart) {
    var top = dayStart + OPEN * HOUR, bottom = dayStart + CLOSE * HOUR;
    var out = [];
    (events || []).forEach(function (e) {
      if (e.allDay) return;
      var from = Date.parse(e.start), to = Date.parse(e.end);
      if (!(to > top && from < bottom)) return;
      out.push({ ev: e, from: Math.max(from, top), to: Math.min(to, bottom), realFrom: from, realTo: to });
    });
    return lanes(out);
  }

  // ── Who said yes ──
  //
  // Scheduling sends a normal Google invitation, so everyone gets the usual
  // Yes / No / Maybe in their mail and on their phone. Their answers come back
  // on the event, and the whole point of booking from here rather than from
  // Google is to see them here: a meeting two people have not answered is a
  // meeting that may not happen, and that is worth knowing before you drive to
  // it.
  function rsvpOf(e) {
    var list = e.attendees || [];
    if (!list.length) return null;
    var yes = 0, no = 0, waiting = 0;
    list.forEach(function (a) {
      if (a.status === 'accepted') yes++;
      else if (a.status === 'declined') no++;
      else waiting++;
    });
    var say = function (label, arr) {
      return arr.length ? label + ': ' + arr.map(function (a) { return who(a.email); }).join(', ') : null;
    };
    var detail = [
      say('Coming', list.filter(function (a) { return a.status === 'accepted'; })),
      say('Not coming', list.filter(function (a) { return a.status === 'declined'; })),
      say('Maybe', list.filter(function (a) { return a.status === 'tentative'; })),
      say('No reply yet', list.filter(function (a) { return a.status === 'needsAction'; }))
    ].filter(Boolean).join(' · ');
    return { yes: yes, no: no, waiting: waiting, total: list.length, detail: detail };
  }

  function rsvpHtml(r) {
    if (!r) return '';
    // How many are actually coming, out of how many were asked. A bare tick
    // would say nothing about the three who have gone quiet.
    var cls = r.no ? 'no' : r.waiting ? 'waiting' : 'yes';
    return '<span class="cal-rsvp ' + cls + '">✓' + r.yes + '/' + r.total
      + (r.no ? ' ✗' + r.no : '') + '</span>';
  }

  function blockHtml(b, dayStart) {
    var e = b.ev;
    var top = (b.from - (dayStart + OPEN * HOUR)) / HOUR * PX_PER_HOUR;
    var h = Math.max(18, (b.to - b.from) / HOUR * PX_PER_HOUR - 2);
    var w = 100 / b.lanes;
    var cls = e.away ? 'cal-ev away' : e.leadId ? 'cal-ev visit' : e.meetingId ? 'cal-ev meet'
      : !e.busy ? 'cal-ev free' : 'cal-ev';
    var r = rsvpOf(e);
    var title = clock(b.realFrom) + '–' + clock(b.realTo) + ' · ' + e.title + (e.where ? ' · ' + e.where : '')
      + (r ? '\n' + r.detail : '');
    // The badge sits beside the title rather than on the detail line, because
    // the detail line only appears on tall blocks — and a 30-minute meeting,
    // which is the common one, is not tall. Hiding the answers on exactly the
    // meetings people book most would defeat the point of showing them.
    var inner = '<span class="cal-ev-h"><b>' + esc(e.title) + '</b>' + rsvpHtml(r) + '</span>'
      + (h > 30 ? '<span class="cal-ev-t">' + esc(clock(b.realFrom)) + (e.where ? ' · ' + esc(e.where) : '') + '</span>' : '');
    // Anything the CRM booked opens here — a meeting to answer it, a site visit
    // to see the lead behind it. Everything else in somebody's calendar is
    // theirs, and is drawn but not opened.
    // Also anything you are yourself invited to, whoever made it: it is already
    // in your own diary, and it is the one you need to answer.
    var me = myEmail();
    var onIt = !!me && (e.attendees || []).some(function (a) { return String(a.email || '').toLowerCase() === me; });
    var ours = e.leadId || e.meetingId || onIt;
    var open = ours ? ' onclick="PinCalendar.openEvent(\'' + esc(e.id) + '\')" role="button" tabindex="0"' : '';
    // A meeting can be dragged to a new time by whoever booked it. Site visits
    // are not draggable here: moving one changes what an agent was told about a
    // client and a seller, and that belongs on the lead where the rest of it is.
    // organiser is only known once the event has been opened, so the grid
    // offers the drag and the SERVER decides — a drag by somebody else comes
    // back refused and the block snaps home.
    var movable = (e.meetingId && !e.leadId) ? ' data-ev="' + esc(e.id) + '"'
      + ' data-mins="' + Math.round((b.realTo - b.realFrom) / 60000) + '"' : '';
    return '<div class="' + cls + (movable ? ' movable' : '') + '" style="top:' + top.toFixed(1) + 'px;height:' + h.toFixed(1) + 'px;'
      + 'left:' + (b.lane * w).toFixed(2) + '%;width:' + (w - 1).toFixed(2) + '%"'
      + ' title="' + esc(title) + '"' + open + movable + '>' + inner + '</div>';
  }

  function nowLineHtml(dayStart) {
    var now = Date.now();
    if (now < dayStart + OPEN * HOUR || now > dayStart + CLOSE * HOUR) return '';
    var top = (now - (dayStart + OPEN * HOUR)) / HOUR * PX_PER_HOUR;
    return '<div class="cal-now" style="top:' + top.toFixed(1) + 'px" aria-hidden="true"></div>';
  }

  // ═══════ DRAGGING A MEETING TO A NEW TIME ═══════
  //
  // Pointer events, not HTML5 drag-and-drop. HTML5 dragging does not exist on
  // touch at all — the first version worked on a laptop and did nothing
  // whatsoever on a phone — and it also insists on a dragover handler calling
  // preventDefault on every element the pointer crosses, so a drop a few
  // pixels off a track silently did nothing. Pointer events are one code path
  // for mouse and finger, and the drop is worked out from coordinates rather
  // than from whatever happened to be under the cursor.
  //
  // The block also has a click on it, so a drag has to be told apart from a
  // tap: nothing moves until the pointer has travelled far enough to mean it.
  var MOVE_THRESHOLD = 6;
  var drag = null;

  function trackAt(x, y) {
    var tracks = document.querySelectorAll('#calendarBody .cal-track');
    for (var i = 0; i < tracks.length; i++) {
      var r = tracks[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return tracks[i];
    }
    return null;
  }

  function onPointerDown(ev) {
    if (ev.button != null && ev.button !== 0) return;
    var block = ev.target.closest ? ev.target.closest('[data-ev]') : null;
    if (!block) return;
    drag = { id: block.getAttribute('data-ev'), mins: Number(block.getAttribute('data-mins')) || 30,
      x: ev.clientX, y: ev.clientY, block: block, moving: false, pid: ev.pointerId };
  }

  function onPointerMove(ev) {
    if (!drag) return;
    if (!drag.moving) {
      if (Math.abs(ev.clientY - drag.y) + Math.abs(ev.clientX - drag.x) < MOVE_THRESHOLD) return;
      drag.moving = true;
      drag.block.classList.add('dragging');
      // Captured so the pointer keeps reporting to this block even when it
      // leaves it, which is most of a drag.
      try { drag.block.setPointerCapture(drag.pid); } catch (e) {}
    }
    ev.preventDefault();
    drag.block.style.transform = 'translateY(' + (ev.clientY - drag.y) + 'px)';
  }

  function onPointerUp(ev) {
    if (!drag) return;
    var d = drag;
    drag = null;
    d.block.classList.remove('dragging');
    d.block.style.transform = '';
    try { d.block.releasePointerCapture(d.pid); } catch (e) {}
    if (!d.moving) return;              // a tap; the click handler has it

    var track = trackAt(ev.clientX, ev.clientY);
    if (!track) { if (typeof showToast === 'function') showToast('Drop it on a day to move it'); return; }

    var r = track.getBoundingClientRect();
    var hours = OPEN + ((ev.clientY - r.top) / PX_PER_HOUR);
    // Nobody books a meeting at 2:07, and a pixel is not a time.
    var mins = Math.max(0, Math.round((hours * 60) / 15) * 15);
    var day = Number(track.getAttribute('data-day')) || state.at;
    var at = day + mins * 60000;
    if (at < Date.now() - 60000) { if (typeof showToast === 'function') showToast('That is in the past.'); return; }

    var when = new Date(at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    // Easy to do by accident, and this one emails everybody invited.
    if (!confirm('Move the meeting to ' + when + '? Everyone invited will be told.')) { render(); return; }

    window.crmAuth.getIdToken().then(function (token) {
      return fetch('/api/tailortalk?action=calendar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ op: 'moveMeeting', eventId: d.id, at: at, minutes: d.mins })
      });
    }).then(function (x) { return x.json(); }).then(function (res) {
      if (!res || !res.ok) {
        if (typeof showToast === 'function') showToast((res && res.error) || 'Could not move it');
        render();   // snap it home
        return;
      }
      if (typeof showToast === 'function') showToast('Moved to ' + when + ' — everyone has been told');
      load(true);
    }).catch(function () {
      if (typeof showToast === 'function') showToast('Could not reach the calendar service');
      render();
    });
  }

  function wireDrag() {
    var body = document.getElementById('calendarBody');
    if (!body || body.__dragWired) return;
    body.__dragWired = true;
    body.addEventListener('pointerdown', onPointerDown);
    body.addEventListener('pointermove', onPointerMove);
    body.addEventListener('pointerup', onPointerUp);
    body.addEventListener('pointercancel', onPointerUp);
  }

  function render() {
    renderMain();
    var el = document.getElementById('calendarBody');
    var inv = invitesHtml();
    if (el && inv) el.insertAdjacentHTML('afterbegin', inv);
  }
  function renderMain() {
    var el = document.getElementById('calendarBody');
    if (!el) return;
    var head = document.getElementById('calendarHead');
    if (head) head.innerHTML = headHtml();

    if (state.loading && (!state.people.length || state.blank)) { el.innerHTML = '<div class="cal-msg">Reading the team’s calendars…</div>'; return; }
    if (state.error) {
      el.innerHTML = '<div class="cal-msg err"><b>' + esc(state.error) + '</b>'
        + (state.hint ? '<span>' + esc(state.hint) + '</span>' : '')
        + '<span class="cal-msg-x">Until this is set up the rest of the CRM is unaffected — only this page needs it.</span></div>';
      return;
    }
    if (!state.people.length) {
      el.innerHTML = '<div class="cal-msg">' + esc(state.note || 'Nobody’s calendar to show yet.') + '</div>';
      return;
    }

    if (state.span === 'week') return renderWeek(el);
    if (state.span === 'month') return renderMonth(el);
    renderDay(el);
  }

  // ── TODAY, EVERYBODY ── the question is "who is free at four"
  function renderDay(el) {
    var dayStart = state.at;
    fitWindow(state.people, dayStart);
    var cols = state.people.map(function (p) {
      var st = p.error ? { cls: 'unknown', text: 'calendar unreadable' } : statusOf(p);
      var blocks = blocksFor(p.events, dayStart);
      var allDay = (p.events || []).filter(function (e) { return e.allDay; });
      return '<div class="cal-col">'
        + '<div class="cal-col-h"><span class="cal-dot ' + st.cls + '"></span>'
        + '<b>' + esc(who(p.person)) + '</b><span class="cal-st">' + esc(st.text) + '</span>'
        + (allDay.length ? '<span class="cal-allday" title="' + esc(allDay.map(function (e) { return e.title; }).join(', ')) + '">' + esc(allDay[0].title) + (allDay.length > 1 ? ' +' + (allDay.length - 1) : '') + '</span>' : '')
        + '</div>'
        + '<div class="cal-track" data-day="' + dayStart + '" style="height:' + ((CLOSE - OPEN) * PX_PER_HOUR) + 'px">'
        + blocks.map(function (b) { return blockHtml(b, dayStart); }).join('')
        + nowLineHtml(dayStart)
        + '</div></div>';
    }).join('');
    el.innerHTML = '<div class="cal-grid">' + hoursHtml() + '<div class="cal-cols">' + cols + '</div></div>';
    wireDrag();
  }

  // ── ONE PERSON, SEVEN DAYS ── "what has Swami got on this week"
  function renderWeek(el) {
    var p = chosenPerson();
    if (!p) { el.innerHTML = '<div class="cal-msg">Pick whose week to show.</div>'; return; }
    var w = windowFor();
    fitWindow([p], w.from, w.to);
    var today = startOfDay(Date.now());
    var cols = '';
    for (var i = 0; i < 7; i++) {
      var d = w.from + i * DAY;
      var events = (p.events || []).filter(function (e) {
        var t = Date.parse(e.start); return t >= d && t < d + DAY;
      });
      var allDay = events.filter(function (e) { return e.allDay; });
      cols += '<div class="cal-col' + (d === today ? ' today' : '') + '">'
        + '<div class="cal-col-h"><b>' + esc(new Date(d).toLocaleDateString([], { weekday: 'short' })) + '</b>'
        + '<span class="cal-st">' + new Date(d).getDate() + ' ' + esc(new Date(d).toLocaleDateString([], { month: 'short' })) + '</span>'
        + (allDay.length ? '<span class="cal-allday" title="' + esc(allDay.map(function (e) { return e.title; }).join(', ')) + '">' + esc(allDay[0].title) + '</span>' : '')
        + '</div>'
        + '<div class="cal-track" data-day="' + d + '" style="height:' + ((CLOSE - OPEN) * PX_PER_HOUR) + 'px">'
        + blocksFor(events, d).map(function (b) { return blockHtml(b, d); }).join('')
        + (d === today ? nowLineHtml(d) : '')
        + '</div></div>';
    }
    el.innerHTML = '<div class="cal-grid">' + hoursHtml() + '<div class="cal-cols">' + cols + '</div></div>';
    wireDrag();
  }

  // ── ONE PERSON, A MONTH ── no hours: at this scale the useful thing is
  // which days are heavy and which are empty, not what time anything starts.
  function renderMonth(el) {
    var p = chosenPerson();
    if (!p) { el.innerHTML = '<div class="cal-msg">Pick whose month to show.</div>'; return; }
    var w = windowFor();
    var today = startOfDay(Date.now());
    var thisMonth = new Date(state.at).getMonth();
    var head = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .map(function (d) { return '<div class="cal-m-h">' + d + '</div>'; }).join('');
    var cells = '';
    for (var d = w.from; d < w.to; d += DAY) {
      var day = d;
      var events = (p.events || []).filter(function (e) {
        var t = Date.parse(e.start); return t >= day && t < day + DAY;
      }).sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); });
      var shown = events.slice(0, 3);
      cells += '<div class="cal-m-d' + (day === today ? ' today' : '') + (new Date(day).getMonth() !== thisMonth ? ' other' : '') + '">'
        + '<span class="cal-m-n">' + new Date(day).getDate() + '</span>'
        + shown.map(function (e) {
            var cls = e.away ? 'away' : e.leadId ? 'visit' : e.meetingId ? 'meet' : !e.busy ? 'free' : '';
            return '<span class="cal-m-e ' + cls + '" title="' + esc((e.allDay ? 'All day' : clock(Date.parse(e.start))) + ' · ' + e.title) + '">'
              + (e.allDay ? '' : '<b>' + esc(clock(Date.parse(e.start))) + '</b> ') + esc(e.title) + '</span>';
          }).join('')
        + (events.length > shown.length ? '<span class="cal-m-more">+' + (events.length - shown.length) + ' more</span>' : '')
        + '</div>';
    }
    el.innerHTML = '<div class="cal-month"><div class="cal-m-head">' + head + '</div><div class="cal-m-grid">' + cells + '</div></div>';
  }

  function chosenPerson() {
    if (!state.people.length) return null;
    return state.people.filter(function (p) { return p.person === state.person; })[0] || state.people[0];
  }

  function hoursHtml() {
    var out = [];
    for (var h = OPEN; h <= CLOSE; h++) {
      var label = new Date(startOfDay(Date.now()) + h * HOUR).toLocaleTimeString([], { hour: 'numeric' });
      out.push('<div class="cal-hr" style="height:' + PX_PER_HOUR + 'px">' + esc(label) + '</div>');
    }
    return '<div class="cal-hours"><div class="cal-col-h"></div><div>' + out.join('') + '</div></div>';
  }

  function headHtml() {
    var d = new Date(state.at);
    var w = windowFor();
    var label, isNow;
    if (state.span === 'week') {
      var last = new Date(w.to - DAY);
      label = new Date(w.from).toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' — '
        + last.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
      isNow = Date.now() >= w.from && Date.now() < w.to;
    } else if (state.span === 'month') {
      label = d.toLocaleDateString([], { month: 'long', year: 'numeric' });
      isNow = new Date().getMonth() === d.getMonth() && new Date().getFullYear() === d.getFullYear();
    } else {
      label = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
      isNow = startOfDay(Date.now()) === state.at;
    }
    var spans = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(function (o) {
      return '<button type="button" class="cal-span' + (state.span === o[0] ? ' on' : '') + '"'
        + ' aria-pressed="' + (state.span === o[0]) + '" onclick="PinCalendar.setSpan(\'' + o[0] + '\')">' + o[1] + '</button>';
    }).join('');
    // Whose calendar, but only where the question makes sense: a day shows
    // everybody, and a picker there would suggest it did not.
    var whoPick = state.span === 'day' ? '' :
      '<select class="cal-who" aria-label="Whose calendar" onchange="PinCalendar.setPerson(this.value)">'
      + teamList().map(function (e) {
          return '<option value="' + esc(e) + '"' + (chosenPersonEmail() === e ? ' selected' : '') + '>' + esc(who(e)) + '</option>';
        }).join('') + '</select>';

    return '<div class="cal-nav">'
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.move(-1)" aria-label="Back">\u2039</button>'
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.today()"' + (isNow ? ' disabled' : '') + '>Today</button>'
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.move(1)" aria-label="Forward">\u203a</button>'
      + '<b class="cal-date">' + esc(label) + '</b>'
      + '</div>'
      + '<div class="cal-acts">'
      + '<div class="cal-spans" role="group" aria-label="How much to show">' + spans + '</div>'
      + whoPick
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.findTime()">Find a time</button>'
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.reload()"' + (state.loading ? ' disabled' : '') + '>'
      + (state.loading ? 'Reading' + '\u2026' : 'Refresh') + '</button>'
      + '<button type="button" class="tt-btn" onclick="PinCalendar.newMeeting()">New meeting</button>'
      + '</div>';
  }
  function chosenPersonEmail() { var p = chosenPerson(); return p ? p.person : null; }
  // Everybody on the team, not only whoever the last read happened to include.
  function teamList() {
    var t = state.team;
    if (!t) { try { t = JSON.parse(localStorage.getItem(CACHE_PREFIX + 'team') || 'null'); } catch (e) { t = null; } }
    var list = (t && t.length ? t : state.people.map(function (p) { return p.person; })).slice();
    state.people.forEach(function (p) { if (list.indexOf(p.person) < 0) list.push(p.person); });
    return list;
  }
  // Week and month open on YOU: the first thing anybody wants there is their own.
  function defaultPerson() {
    var me = myEmail();
    var hit = teamList().filter(function (e) { return String(e).toLowerCase() === me; })[0];
    return hit || (state.people[0] || {}).person || null;
  }

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550 FINDING A TIME \u2550\u2550\u2550\u2550\u2550\u2550\u2550
  //
  // Booking by guessing and then reading five refusals is how people give up on
  // a scheduler. This offers the times that actually work: every slot in the
  // next fortnight, during working hours, where nobody picked is busy.
  //
  // It reads the same events the grid does, so it cannot offer a time the grid
  // shows as taken.
  var findState = { days: 14, minutes: 60, people: [], slots: null, loading: false };

  function findTimeHtml() {
    var team = state.people.map(function (p) { return p.person; });
    return '<div class="cal-sheet" id="findSheet" role="dialog" aria-modal="true" aria-label="Find a time">'
      + '<div class="cal-sheet-in">'
      + '<h3>Find a time</h3>'
      + '<label>Who has to be there</label>'
      + '<div class="cm-who" id="ftWho">' + team.map(function (e) {
          return '<label class="cm-p"><input type="checkbox" value="' + esc(e) + '"'
            + (findState.people.indexOf(e) >= 0 ? ' checked' : '') + ' onchange="PinCalendar.runFind()">'
            + esc(who(e)) + '</label>';
        }).join('') + '</div>'
      + '<div class="cm-when">'
      + '<div><label for="ftMins">Minutes</label><select id="ftMins" onchange="PinCalendar.runFind()">'
      + [30, 60, 90, 120].map(function (m) { return '<option value="' + m + '"' + (m === findState.minutes ? ' selected' : '') + '>' + m + '</option>'; }).join('')
      + '</select></div>'
      + '<div><label for="ftDays">Look ahead</label><select id="ftDays" onchange="PinCalendar.runFind()">'
      + [[3, 'Next 3 days'], [7, 'Next week'], [14, 'Next fortnight']]
          .map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === findState.days ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('')
      + '</select></div>'
      + '</div>'
      + '<div class="ft-out" id="ftOut"></div>'
      + '<div class="cal-sheet-acts"><button type="button" class="tt-btn quiet" onclick="PinCalendar.closeFind()">Close</button></div>'
      + '</div></div>';
  }

  function runFind() {
    var out = document.getElementById('ftOut');
    if (!out) return;
    findState.people = Array.prototype.slice.call(document.querySelectorAll('#ftWho input:checked')).map(function (i) { return i.value; });
    findState.minutes = Number((document.getElementById('ftMins') || {}).value || 60);
    findState.days = Number((document.getElementById('ftDays') || {}).value || 14);
    if (!findState.people.length) { out.innerHTML = '<div class="ft-none">Pick who has to be there.</div>'; return; }

    out.innerHTML = '<div class="ft-none">Looking' + '\u2026' + '</div>';
    var from = Date.now();
    var to = startOfDay(from) + findState.days * DAY;
    window.crmAuth.getIdToken().then(function (token) {
      return fetch('/api/tailortalk?action=calendar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ op: 'day', from: from, to: to, people: findState.people })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) { out.innerHTML = '<div class="ft-none">' + esc((d && (d.hint || d.error)) || 'Could not read the calendars.') + '</div>'; return; }
      renderFound(out, d.people || [], from, to);
    }).catch(function () { out.innerHTML = '<div class="ft-none">Could not reach the calendar service.</div>'; });
  }

  // Working hours, every day: brokers show properties at weekends, so a
  // Saturday slot is a real offer and skipping it would hide half the week.
  function renderFound(out, people, from, to) {
    var OPEN_M = 9 * 60 + 30, CLOSE_M = 19 * 60 + 30;
    var busy = [];
    people.forEach(function (p) {
      (p.events || []).forEach(function (e) {
        if (!e.busy || !e.start || !e.end) return;
        // An all-day OUT OF OFFICE does block the day; an all-day tag does not.
        if (e.allDay && !e.away) return;
        busy.push([Date.parse(e.start), Date.parse(e.end)]);
      });
    });
    var span = findState.minutes * 60000;
    var byDay = {};
    for (var t = Math.ceil(from / (30 * 60000)) * (30 * 60000); t + span <= to; t += 30 * 60000) {
      var d = new Date(t);
      var mins = d.getHours() * 60 + d.getMinutes();
      if (mins < OPEN_M || mins + findState.minutes > CLOSE_M) continue;
      var clash = busy.some(function (b) { return t < b[1] && t + span > b[0]; });
      if (clash) continue;
      var key = startOfDay(t);
      (byDay[key] = byDay[key] || []).push(t);
    }
    var days = Object.keys(byDay).sort(function (a, b) { return a - b; }).slice(0, 7);
    if (!days.length) {
      out.innerHTML = '<div class="ft-none">Nobody is free together in the next '
        + findState.days + ' days for ' + findState.minutes + ' minutes. Try a shorter meeting, or fewer people.</div>';
      return;
    }
    out.innerHTML = days.map(function (k) {
      var slots = byDay[k].slice(0, 8);
      return '<div class="ft-day"><div class="ft-day-h">'
        + esc(new Date(Number(k)).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })) + '</div>'
        + '<div class="ft-slots">' + slots.map(function (t) {
            return '<button type="button" class="ft-slot" onclick="PinCalendar.useSlot(' + t + ')">' + esc(clock(t)) + '</button>';
          }).join('') + (byDay[k].length > slots.length ? '<span class="ft-plus">+' + (byDay[k].length - slots.length) + '</span>' : '')
        + '</div></div>';
    }).join('');
  }

  // Picking a slot hands straight to the booking form with everything filled
  // in. Finding a time and then retyping it is the half that gets skipped.
  function useSlot(t) {
    var people = findState.people.slice();
    var mins = findState.minutes;
    closeFind();
    state.at = startOfDay(t);
    newMeeting();
    var d = new Date(t);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var set = function (id, v) { var el = document.getElementById(id); if (el) el.value = v; };
    set('cmDate', d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
    set('cmTime', pad(d.getHours()) + ':' + pad(d.getMinutes()));
    set('cmMins', String(mins));
    Array.prototype.slice.call(document.querySelectorAll('.cm-who input:not(:disabled)')).forEach(function (i) {
      i.checked = people.indexOf(i.value) >= 0;
    });
    var t2 = document.getElementById('cmTitle');
    if (t2) t2.focus();
  }

  function closeFind() { var el = document.getElementById('findSheet'); if (el) el.remove(); }

  // ═══════ OPENING A BOOKING ═══════
  //
  // A meeting is answered here, in the calendar, rather than by going and
  // finding the invitation in your mail. A site visit is answered on the lead,
  // because the thing you need in order to decide — who the client is, what
  // they asked for, what the office wrote down — is on the lead and not here.
  //
  // It is read AS the person looking, so nothing appears that is not already
  // in their own calendar, and the server refuses anything the CRM did not
  // book: the grid draws private appointments as busy blocks, and opening one
  // must not hand over what it is.
  var evState = { id: null, loading: false, data: null, error: null };

  function openEvent(id) {
    evState = { id: id, loading: true, data: null, error: null };
    closeEvent(true);
    var local = (state.upcoming || []).filter(function (e) { return e.id === id; })[0];
    if (!local) {
      // Not in the next fortnight's list (a past one, or another week): the grid
      // has it, because that is where it was clicked.
      var me = myEmail();
      state.people.forEach(function (p) {
        (p.events || []).forEach(function (e) {
          if (local || e.id !== id) return;
          local = { id: e.id, title: e.title, start: e.start, end: e.end, where: e.where, about: e.about, meet: e.meet,
            link: e.link, organiser: e.organiser, leadId: e.leadId, meetingId: e.meetingId, attendees: e.attendees || [],
            mine: ((e.attendees || []).filter(function (a) { return String(a.email || '').toLowerCase() === me; })[0] || {}).status || null };
        });
      });
    }
    // A site visit is about a lead: open the lead (where the visit is managed), whoever's calendar
    // the block sits in. Asking Google for it as the viewer fails whenever the visit is in a
    // colleague's diary — which left the page stuck on an error with no way out (3 Oct).
    if (local && local.leadId) {
      evState = { id: null, loading: false, data: null, error: null };
      if (typeof openDetail === 'function') openDetail(local.leadId);
      return;
    }
    if (local && !local.leadId && !local.meetingId) {
      // Not one the CRM booked, so there is nothing to answer here. It is in
      // your own calendar, so what it holds is yours to read.
      evState.loading = false;
      evState.data = { id: local.id, title: local.title, start: local.start, end: local.end, where: local.where,
        about: local.about, meet: local.meet, organiser: local.organiser, attendees: local.attendees,
        mine: local.mine, readOnly: true, link: local.link };
      document.body.insertAdjacentHTML('beforeend', eventHtml());
      return;
    }
    document.body.insertAdjacentHTML('beforeend', eventHtml());
    window.crmAuth.getIdToken().then(function (token) {
      return fetch('/api/tailortalk?action=calendar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ op: 'event', eventId: id })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (evState.id !== id) return;
      evState.loading = false;
      if (d && d.ok) evState.data = d.event;
      // Not in YOUR calendar (it is a colleague's meeting): show what the grid already knows,
      // read-only, rather than an error.
      else if (local) evState.data = { id: local.id, title: local.title, start: local.start, end: local.end, where: local.where,
        about: local.about, meet: local.meet, organiser: local.organiser, attendees: local.attendees, mine: local.mine, readOnly: true, link: local.link };
      else evState.error = (d && d.error) || 'Could not open it';
      redrawEvent();
    }).catch(function () {
      if (evState.id !== id) return;
      evState.loading = false; evState.error = 'Could not reach the calendar service';
      redrawEvent();
    });
  }

  function redrawEvent() {
    var el = document.getElementById('evSheet');
    if (!el) return;
    el.outerHTML = eventHtml();
  }

  var ANSWER = { accepted: 'Coming', declined: 'Not coming', tentative: 'Maybe', needsAction: 'No reply yet' };

  function eventHtml() {
    var d = evState.data;
    var body;
    // Every state has a way out — an error with no Close button left the page stuck (3 Oct).
    var closeRow = '<div class="cal-sheet-acts"><button type="button" class="tt-btn quiet" onclick="PinCalendar.closeEvent()">Close</button></div>';
    if (evState.loading) body = '<div class="ev-msg">Opening' + '\u2026' + '</div>' + closeRow;
    else if (evState.error) body = '<div class="ev-msg">' + esc(evState.error) + '</div>' + closeRow;
    else if (!d) body = '<div class="ev-msg">Nothing to show.</div>' + closeRow;
    else {
      var when = d.start ? new Date(d.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
      var till = d.end ? clock(Date.parse(d.end)) : '';
      var them = (d.attendees || []).map(function (a) {
        var st = a.status || 'needsAction';
        return '<div class="ev-who ' + st + '"><span>' + esc(who(a.email)) + '</span>'
          + '<span class="ev-who-s">' + esc(ANSWER[st] || st) + (a.reason ? ' · “' + esc(a.reason) + '”' : '') + '</span></div>';
      }).join('');
      // A site visit sends you to the lead; a meeting is answered right here.
      // Whoever booked it changes it. Everybody else answers and leaves the
      // arrangements alone — a guest who could move the meeting could move it
      // out from under the person who called it.
      var owner = !d.leadId && d.iCreated
        ? '<button type="button" class="tt-btn quiet" onclick="PinCalendar.editEvent()">Change it</button>'
          + '<button type="button" class="tt-btn quiet danger" onclick="PinCalendar.callOff()">Call it off</button>'
        : '';
      var acts = d.leadId
        ? '<button type="button" class="tt-btn" onclick="PinCalendar.openLead(\'' + esc(d.leadId) + '\')">Open the lead</button>'
        : (d.mine
            ? (d.mine !== 'accepted' ? '<button type="button" class="tt-btn" onclick="PinCalendar.answer(\'accepted\')">'
                + (d.mine === 'declined' ? 'Actually, I can come' : 'I can come') + '</button>' : '')
              + (d.mine !== 'declined' ? '<button type="button" class="tt-btn quiet" onclick="PinCalendar.decline()">Can' + '\u2019' + 't make it</button>' : '')
            : '<span class="ev-note">You are not on this one.</span>');
      // Somebody else's invitation still gets the same two answers, and a way
      // through to Google for everything the CRM does not show.
      if (d.readOnly && d.link) acts += '<a class="tt-btn quiet" href="' + esc(d.link) + '" target="_blank" rel="noopener">Open in Google Calendar</a>';
      body = '<h3>' + esc(d.title) + '</h3>'
        + '<div class="ev-when">' + esc(when) + (till ? ' – ' + esc(till) : '') + '</div>'
        + (d.where ? '<div class="ev-where">' + esc(d.where) + '</div>' : '')
        + (d.meet ? '<a class="ev-meet" href="' + esc(d.meet) + '" target="_blank" rel="noopener">Join the video call</a>' : '')
        + (d.mine ? '<div class="ev-mine ' + d.mine + '">You: ' + esc(ANSWER[d.mine] || d.mine) + '</div>' : '')
        + (them ? '<div class="ev-list">' + them + '</div>' : '')
        + (d.about ? '<div class="ev-about">' + esc(d.about) + '</div>' : '')
        + '<div class="ev-err" id="evErr"></div>'
        + '<div class="cal-sheet-acts">' + acts + owner
        + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.closeEvent()">Close</button></div>';
    }
    return '<div class="cal-sheet" id="evSheet" role="dialog" aria-modal="true" aria-label="Booking">'
      + '<div class="cal-sheet-in ev-sheet">' + body + '</div></div>';
  }

  function answer(response, reason) {
    var err = document.getElementById('evErr');
    var id = evState.id;
    window.crmAuth.getIdToken().then(function (token) {
      return fetch('/api/tailortalk?action=calendar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ op: 'answer', eventId: id, response: response, reason: reason || '' })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) {
        if (err) { err.textContent = (d && d.error) || 'Could not send your answer'; err.classList.add('show'); }
        return;
      }
      if (evState.data) {
        evState.data.attendees = d.replies || evState.data.attendees;
        evState.data.mine = response;
      }
      state.invites = (state.invites || []).filter(function (e) { return e.id !== id; });
      (state.upcoming || []).forEach(function (e) { if (e.id === id) { e.mine = response; e.attendees = d.replies || e.attendees; } });
      if (typeof window.refreshMyEvents === 'function') window.refreshMyEvents(true);
      redrawEvent();
      if (typeof showToast === 'function') {
        showToast(response === 'accepted' ? '✓ You are coming — everyone has been told'
          : 'Everyone has been told you cannot make it');
      }
      load(true);
    }).catch(function () {
      if (err) { err.textContent = 'Could not reach the calendar service'; err.classList.add('show'); }
    });
  }

  function decline() {
    var why = prompt('Why can' + '\u2019' + 't you make it? Everyone invited sees this.', '');
    if (why === null) return;
    answer('declined', String(why).trim().slice(0, 300));
  }

  // Editing is the booking form again, filled in, writing back to the same
  // event instead of making a second one.
  function editEvent() {
    var d = evState.data;
    if (!d) return;
    var id = d.id;
    var at = Date.parse(d.start);
    var mins = d.minutes || 30;
    var people = (d.attendees || []).map(function (a) { return a.email; });
    var title = d.title, where = d.where || '';
    closeEvent();
    newMeeting(id);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var dt = new Date(at);
    var set = function (i, v) { var el = document.getElementById(i); if (el) el.value = v; };
    set('cmTitle', title);
    set('cmDate', dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()));
    set('cmTime', pad(dt.getHours()) + ':' + pad(dt.getMinutes()));
    set('cmMins', String(mins));
    set('cmWhere', where);
    Array.prototype.slice.call(document.querySelectorAll('.cm-who input:not(:disabled)')).forEach(function (i) {
      i.checked = people.indexOf(i.value) >= 0;
    });
    var extra = people.filter(function (e) {
      return !document.querySelector('.cm-who input[value="' + e + '"]');
    });
    set('cmAlso', extra.join(', '));
  }

  function callOff() {
    var d = evState.data;
    if (!d) return;
    if (!confirm('Call off "' + d.title + '"? Everyone invited will be told.')) return;
    var id = d.id;
    window.crmAuth.getIdToken().then(function (token) {
      return fetch('/api/tailortalk?action=calendar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ op: 'meeting', eventId: id, cancel: true })
      });
    }).then(function (r) { return r.json(); }).then(function (res) {
      var err = document.getElementById('evErr');
      if (!res || !res.ok) {
        if (err) { err.textContent = (res && res.error) || 'Could not call it off'; err.classList.add('show'); }
        return;
      }
      closeEvent();
      if (typeof showToast === 'function') showToast('Called off — everyone invited has been told');
      load(true);
    }).catch(function () {
      var err = document.getElementById('evErr');
      if (err) { err.textContent = 'Could not reach the calendar service'; err.classList.add('show'); }
    });
  }

  function closeEvent(keepState) {
    var el = document.getElementById('evSheet');
    if (el) el.remove();
    if (!keepState) evState = { id: null, loading: false, data: null, error: null };
  }

  // ═══════ BOOKING A MEETING ═══════
  //
  // Google does the inviting: everyone picked gets a normal invitation they can
  // accept or decline, on whatever calendar app they use, and a Meet link if it
  // was asked for. The CRM is only the booking form.
  // The id of the meeting being changed, or null for a new one. The form is
  // the same either way; what differs is whether Google is told to make an
  // event or to move the one that is already there.
  var editingId = null;
  function newMeeting(eventId) {
    if (state.error) { if (typeof showToast === 'function') showToast(state.error); return; }
    editingId = eventId || null;
    closeMeeting();
    document.body.insertAdjacentHTML('beforeend', meetingHtml());
    var t = document.getElementById('cmTitle');
    if (t) t.focus();
  }

  function meetingHtml() {
    var team = state.people.map(function (p) { return p.person; });
    // app.js declares currentUserEmail with `let`, which puts it in the global
    // LEXICAL scope — reachable by name from another plain script, but never on
    // `window`. Reading it off window silently yields undefined, and the form
    // then offers to invite you to your own meeting.
    var mine = String(typeof currentUserEmail === 'string' ? currentUserEmail : '').toLowerCase();
    var d = new Date(Math.max(Date.now() + HOUR, state.at + 10 * HOUR));
    d.setMinutes(d.getMinutes() > 30 ? 60 : 30, 0, 0);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return '<div class="cal-sheet" id="calSheet" role="dialog" aria-modal="true" aria-label="New meeting">'
      + '<div class="cal-sheet-in">'
      + '<h3>' + (editingId ? 'Change the meeting' : 'New meeting') + '</h3>'
      + '<label for="cmTitle">What is it about</label>'
      + '<input id="cmTitle" type="text" placeholder="Monday pipeline review" maxlength="120">'
      + '<div class="cm-when">'
      + '<div><label for="cmDate">Day</label><input id="cmDate" type="date" value="' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '"></div>'
      + '<div><label for="cmTime">Time</label><input id="cmTime" type="time" value="' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '"></div>'
      + '<div><label for="cmMins">Minutes</label><select id="cmMins">'
      + [15, 30, 45, 60, 90].map(function (m) { return '<option value="' + m + '"' + (m === 30 ? ' selected' : '') + '>' + m + '</option>'; }).join('')
      + '</select></div>'
      + '</div>'
      // The weekly review is the meeting people actually keep, and having to
      // open Google to set one up is having to open Google.
      + '<label for="cmRepeat">Repeats</label>'
      + '<select id="cmRepeat">'
      + [['none', 'Just once'], ['daily', 'Every day'], ['workdays', 'Every working day (Mon–Sat)'],
         ['weekly', 'Every week, this day'], ['monthly', 'Every month, this date']]
          .map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join('')
      + '</select>'
      + '<label>Who</label>'
      + '<div class="cm-who">' + team.map(function (e) {
          var self = e.toLowerCase() === mine;
          return '<label class="cm-p' + (self ? ' self' : '') + '">'
            + '<input type="checkbox" value="' + esc(e) + '"' + (self ? ' checked disabled' : '') + '>'
            + esc(who(e)) + (self ? ' (you)' : '') + '</label>';
        }).join('') + '</div>'
      // Somebody in the Workspace who has no calendar column here — they
      // still get the invitation and still answer it in their own mail.
      + '<label for="cmAlso">Anyone else</label>'
      + '<input id="cmAlso" type="text" placeholder="name@threepin.in, another@threepin.in" autocomplete="off">'
      + '<div class="cm-row">'
      + '<label class="cm-p"><input type="checkbox" id="cmMeet" checked> Add a Google Meet link</label>'
      + '</div>'
      + '<label for="cmWhere">Where (optional)</label>'
      + '<input id="cmWhere" type="text" placeholder="Office, or a property code" maxlength="120">'
      + '<div class="cal-sheet-err" id="cmErr"></div>'
      + '<div class="cal-sheet-acts">'
      + '<button type="button" class="tt-btn" id="cmGo" onclick="PinCalendar.book()">' + (editingId ? 'Save and tell everyone' : 'Send invitations') + '</button>'
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.closeMeeting()">Cancel</button>'
      + '</div></div></div>';
  }

  function book() {
    var err = document.getElementById('cmErr');
    var title = document.getElementById('cmTitle').value.trim();
    var date = document.getElementById('cmDate').value;
    var time = document.getElementById('cmTime').value;
    var minutes = Number(document.getElementById('cmMins').value);
    var where = document.getElementById('cmWhere').value.trim();
    var meet = document.getElementById('cmMeet').checked;
    var repeat = document.getElementById('cmRepeat').value;
    var attendees = Array.prototype.slice.call(document.querySelectorAll('.cm-who input:checked:not(:disabled)'))
      .map(function (i) { return i.value; });
    var typed = (document.getElementById('cmAlso').value || '').split(/[,;\s]+/)
      .map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
    var bad = typed.filter(function (e) { return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); });
    typed.forEach(function (e) { if (attendees.indexOf(e) === -1) attendees.push(e); });

    var fail = function (m) { err.textContent = m; err.classList.add('show'); };
    if (!title) return fail('Give the meeting a name, so it is recognisable in somebody’s calendar a week from now.');
    if (!date || !time) return fail('Pick a day and a time.');
    var at = new Date(date + 'T' + time + ':00').getTime();
    if (!at) return fail('That is not a time.');
    if (at < Date.now() - 5 * MIN) return fail('That is in the past.');
    if (bad.length) return fail('That does not look like an email address: ' + bad[0]);
    if (!attendees.length) return fail('Pick at least one other person — a meeting with yourself is a reminder.');

    var go = document.getElementById('cmGo');
    go.disabled = true; go.textContent = 'Sending…';
    err.classList.remove('show');
    window.crmAuth.getIdToken().then(function (token) {
      return fetch('/api/tailortalk?action=calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ op: 'meeting', eventId: editingId, title: title, at: at, minutes: minutes, where: where, meet: meet, repeat: repeat, attendees: attendees })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      go.disabled = false; go.textContent = editingId ? 'Save and tell everyone' : 'Send invitations';
      if (!d || !d.ok) return fail((d && (d.hint || d.error)) || 'Google would not take the booking.');
      closeMeeting();
      if (typeof showToast === 'function') {
        var every = { daily: ' · every day', workdays: ' · every working day',
          weekly: ' · every week', monthly: ' · every month' }[repeat] || '';
        showToast('✓ Invitations sent to ' + attendees.length + ' — ' + title + every);
      }
      // Jump to the day it was booked for, so it is visible immediately.
      state.at = startOfDay(at);
      load(true);
    }).catch(function () {
      go.disabled = false; go.textContent = editingId ? 'Save and tell everyone' : 'Send invitations';
      fail('Could not reach the calendar service.');
    });
  }

  function closeMeeting() {
    var s = document.getElementById('calSheet');
    if (s) s.remove();
  }

  window.PinCalendar = {
    open: function () { render(); load(false); },
    reload: function () { load(true); },
    move: function (n) {
      if (state.span === 'week') state.at = startOfWeek(state.at) + n * 7 * DAY;
      else if (state.span === 'month') { var d = new Date(startOfMonth(state.at)); d.setMonth(d.getMonth() + n); state.at = d.getTime(); }
      else state.at += n * DAY;
      load(false);
    },
    today: function () { state.at = startOfDay(Date.now()); load(false); },
    newMeeting: function () { newMeeting(null); },
    editEvent: editEvent, callOff: callOff,
    setSpan: function (span) {
      state.span = span;
      if (span !== 'day' && !state.person) state.person = defaultPerson();
      load(false);
    },
    setPerson: function (email) { state.person = email; load(false); },
    findTime: function () {
      if (state.error) { if (typeof showToast === 'function') showToast(state.error); return; }
      closeFind();
      if (!findState.people.length) findState.people = state.people.map(function (p) { return p.person; }).slice(0, 2);
      document.body.insertAdjacentHTML('beforeend', findTimeHtml());
      runFind();
    },
    runFind: runFind, useSlot: useSlot, closeFind: closeFind,
    openEvent: openEvent, closeEvent: closeEvent, answer: answer, decline: decline, quickAnswer: quickAnswer,
    myEventsChanged: function () { fromMyDiary(); if (onScreen()) render(); }, toggleMine: function () { state.showAllMine = !state.showAllMine; render(); },
    openLead: function (id) { closeEvent(); if (typeof openDetail === 'function') openDetail(id); },
    closeMeeting: closeMeeting,
    book: book,
    // Exposed for the tests, which drive the layout without a real Google.
    _state: state, _lanes: lanes, _statusOf: statusOf
  };

  // Looked at again after a while away, or left open: catch up without being
  // asked. Only when the calendar is the page actually on screen.
  function onScreen() { var el = document.getElementById('calendarBody'); return !!(el && el.offsetParent); }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && onScreen() && Date.now() - lastFetch > 30000) load(true);
  });
  setInterval(function () { if (!document.hidden && onScreen()) load(true); }, 5 * MIN);

  // Any calendar sheet closes with Esc or a click on the dimmed area around it.
  function closeTopSheet() {
    var sheets = document.querySelectorAll('.cal-sheet');
    var top = sheets[sheets.length - 1];
    if (!top) return false;
    if (top.id === 'evSheet') closeEvent();
    else if (top.id === 'findSheet') closeFind();
    else if (top.id === 'calSheet') closeMeeting();
    else if (top.id === 'svSheet' && typeof closeVisitEditor === 'function') closeVisitEditor();
    else top.remove();
    return true;
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && closeTopSheet()) e.stopPropagation(); });
  document.addEventListener('click', function (e) { if (e.target && e.target.classList && e.target.classList.contains('cal-sheet')) closeTopSheet(); });

  window.renderCalendarView = function () { window.PinCalendar.open(); };
})();
