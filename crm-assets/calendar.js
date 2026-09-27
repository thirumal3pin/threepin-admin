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
  // The grid normally runs 8am to 9pm, which is the working day for a
  // brokerage that shows properties at weekends and evenings. But it STRETCHES
  // to whatever the day actually holds: an early site visit or a late call
  // outside a fixed window would otherwise be dropped from the page without
  // saying so, and a calendar that quietly hides an appointment is worse than
  // no calendar. Live data already runs to 8:30pm, half an hour off the edge.
  var DAY_OPEN = 8, DAY_CLOSE = 21;
  var OPEN = DAY_OPEN, CLOSE = DAY_CLOSE;
  var PX_PER_HOUR = 52;

  // Widen the window so nothing falls off it. Whole hours, so the labels stay
  // on the lines.
  function fitWindow(people, dayStart) {
    var open = DAY_OPEN, close = DAY_CLOSE;
    (people || []).forEach(function (p) {
      (p.events || []).forEach(function (e) {
        if (e.allDay || !e.start || !e.end) return;
        var from = Date.parse(e.start), to = Date.parse(e.end);
        if (!(to > dayStart && from < dayStart + DAY)) return;
        open = Math.min(open, Math.floor((Math.max(from, dayStart) - dayStart) / HOUR));
        close = Math.max(close, Math.ceil((Math.min(to, dayStart + DAY) - dayStart) / HOUR));
      });
    });
    OPEN = Math.max(0, open);
    CLOSE = Math.min(24, Math.max(OPEN + 1, close));
  }

  var state = { at: startOfDay(Date.now()), span: 'day', people: [], loading: false, error: null, hint: null };
  var lastFetch = 0;

  function startOfDay(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(s == null ? '' : s) : String(s == null ? '' : s); }
  function clock(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function who(email) {
    var M = window.crmMentions;
    return (M && email) ? M.displayName(email) : (email || '');
  }
  function windowFor() {
    var from = state.at, to = state.at + (state.span === 'week' ? 7 * DAY : DAY);
    return { from: from, to: to };
  }

  // ── Getting the day ──
  //
  // Each call reaches five Google calendars, so it is not something to fire on
  // every render. Refetch happens when the window moves or the page has been
  // sitting for a minute, and never twice at once.
  function load(force) {
    var w = windowFor();
    if (state.loading) return;
    if (!force && Date.now() - lastFetch < 60000 && state.fetchedFor === w.from + ':' + state.span) return;
    state.loading = true;
    state.error = null;
    state.hint = null;
    render();
    window.crmAuth.getIdToken().then(function (token) {
      return fetch('/api/tailortalk?action=calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ op: 'day', from: w.from, to: w.to })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      state.loading = false;
      lastFetch = Date.now();
      state.fetchedFor = w.from + ':' + state.span;
      if (d && d.ok) { state.people = d.people || []; state.note = d.note || null; }
      // Setup that is not finished is not an outage, and must not be drawn as one.
      else { state.error = (d && d.error) || 'Could not read the calendars'; state.hint = (d && d.hint) || null; state.people = []; }
      render();
    }).catch(function () {
      state.loading = false;
      state.error = 'Could not reach the calendar service';
      render();
    });
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

  function blocksFor(person, dayStart) {
    var top = dayStart + OPEN * HOUR, bottom = dayStart + CLOSE * HOUR;
    var out = [];
    (person.events || []).forEach(function (e) {
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
    // A site visit opens the lead it belongs to; that is the whole reason for
    // showing it here rather than leaving people in Google Calendar.
    var open = e.leadId ? ' onclick="openDetail(\'' + esc(e.leadId) + '\')" role="button" tabindex="0"' : '';
    return '<div class="' + cls + '" style="top:' + top.toFixed(1) + 'px;height:' + h.toFixed(1) + 'px;'
      + 'left:' + (b.lane * w).toFixed(2) + '%;width:' + (w - 1).toFixed(2) + '%"'
      + ' title="' + esc(title) + '"' + open + '>' + inner + '</div>';
  }

  function nowLineHtml(dayStart) {
    var now = Date.now();
    if (now < dayStart + OPEN * HOUR || now > dayStart + CLOSE * HOUR) return '';
    var top = (now - (dayStart + OPEN * HOUR)) / HOUR * PX_PER_HOUR;
    return '<div class="cal-now" style="top:' + top.toFixed(1) + 'px" aria-hidden="true"></div>';
  }

  function render() {
    var el = document.getElementById('calendarBody');
    if (!el) return;
    var head = document.getElementById('calendarHead');
    if (head) head.innerHTML = headHtml();

    if (state.loading && !state.people.length) { el.innerHTML = '<div class="cal-msg">Reading the team’s calendars…</div>'; return; }
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

    var dayStart = state.at;
    fitWindow(state.people, dayStart);
    var hours = [];
    for (var h = OPEN; h <= CLOSE; h++) {
      var label = new Date(dayStart + h * HOUR).toLocaleTimeString([], { hour: 'numeric' });
      hours.push('<div class="cal-hr" style="height:' + PX_PER_HOUR + 'px">' + esc(label) + '</div>');
    }

    var cols = state.people.map(function (p) {
      // A calendar we could not read is NOT a free one. Showing green beside
      // "unreadable" is the one lie a status board must never tell: somebody
      // books them, and they were in a meeting the whole time.
      var st = p.error ? { cls: 'unknown', text: 'calendar unreadable' } : statusOf(p);
      var blocks = blocksFor(p, dayStart);
      var allDay = (p.events || []).filter(function (e) { return e.allDay; });
      return '<div class="cal-col">'
        + '<div class="cal-col-h"><span class="cal-dot ' + st.cls + '"></span>'
        + '<b>' + esc(who(p.person)) + '</b><span class="cal-st">' + esc(st.text) + '</span>'
        + (allDay.length ? '<span class="cal-allday" title="' + esc(allDay.map(function (e) { return e.title; }).join(', ')) + '">' + esc(allDay[0].title) + (allDay.length > 1 ? ' +' + (allDay.length - 1) : '') + '</span>' : '')
        + '</div>'
        + '<div class="cal-track" style="height:' + ((CLOSE - OPEN) * PX_PER_HOUR) + 'px">'
        + blocks.map(function (b) { return blockHtml(b, dayStart); }).join('')
        + nowLineHtml(dayStart)
        + '</div></div>';
    }).join('');

    el.innerHTML = '<div class="cal-grid">'
      + '<div class="cal-hours"><div class="cal-col-h"></div><div>' + hours.join('') + '</div></div>'
      + '<div class="cal-cols">' + cols + '</div></div>';
  }

  function headHtml() {
    var d = new Date(state.at);
    var isToday = startOfDay(Date.now()) === state.at;
    var label = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    return '<div class="cal-nav">'
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.move(-1)" aria-label="Previous day">‹</button>'
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.today()"' + (isToday ? ' disabled' : '') + '>Today</button>'
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.move(1)" aria-label="Next day">›</button>'
      + '<b class="cal-date">' + esc(label) + '</b>'
      + '</div>'
      + '<div class="cal-acts">'
      + '<button type="button" class="tt-btn quiet" onclick="PinCalendar.reload()"' + (state.loading ? ' disabled' : '') + '>'
      + (state.loading ? 'Reading…' : 'Refresh') + '</button>'
      + '<button type="button" class="tt-btn" onclick="PinCalendar.newMeeting()">New meeting</button>'
      + '</div>';
  }

  // ═══════ BOOKING A MEETING ═══════
  //
  // Google does the inviting: everyone picked gets a normal invitation they can
  // accept or decline, on whatever calendar app they use, and a Meet link if it
  // was asked for. The CRM is only the booking form.
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
      + '<h3>New meeting</h3>'
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
      + '<div class="cm-row">'
      + '<label class="cm-p"><input type="checkbox" id="cmMeet" checked> Add a Google Meet link</label>'
      + '</div>'
      + '<label for="cmWhere">Where (optional)</label>'
      + '<input id="cmWhere" type="text" placeholder="Office, or a property code" maxlength="120">'
      + '<div class="cal-sheet-err" id="cmErr"></div>'
      + '<div class="cal-sheet-acts">'
      + '<button type="button" class="tt-btn" id="cmGo" onclick="PinCalendar.book()">Send invitations</button>'
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

    var fail = function (m) { err.textContent = m; err.classList.add('show'); };
    if (!title) return fail('Give the meeting a name, so it is recognisable in somebody’s calendar a week from now.');
    if (!date || !time) return fail('Pick a day and a time.');
    var at = new Date(date + 'T' + time + ':00').getTime();
    if (!at) return fail('That is not a time.');
    if (at < Date.now() - 5 * MIN) return fail('That is in the past.');
    if (!attendees.length) return fail('Pick at least one other person — a meeting with yourself is a reminder.');

    var go = document.getElementById('cmGo');
    go.disabled = true; go.textContent = 'Sending…';
    err.classList.remove('show');
    window.crmAuth.getIdToken().then(function (token) {
      return fetch('/api/tailortalk?action=calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ op: 'meeting', title: title, at: at, minutes: minutes, where: where, meet: meet, repeat: repeat, attendees: attendees })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      go.disabled = false; go.textContent = 'Send invitations';
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
      go.disabled = false; go.textContent = 'Send invitations';
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
    move: function (n) { state.at += n * (state.span === 'week' ? 7 * DAY : DAY); load(true); },
    today: function () { state.at = startOfDay(Date.now()); load(true); },
    newMeeting: function () {
      if (state.error) { if (typeof showToast === 'function') showToast(state.error); return; }
      closeMeeting();
      document.body.insertAdjacentHTML('beforeend', meetingHtml());
      var t = document.getElementById('cmTitle');
      if (t) t.focus();
    },
    closeMeeting: closeMeeting,
    book: book,
    // Exposed for the tests, which drive the layout without a real Google.
    _state: state, _lanes: lanes, _statusOf: statusOf
  };

  window.renderCalendarView = function () { window.PinCalendar.open(); };
})();
