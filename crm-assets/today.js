// ═══════ DAILY TASK — what the person signed in has to do today ═══════
//
// Every other screen in the CRM is a view of the leads. This one is a view of
// the DAY: the visits that are booked, the calls that are due, and the things
// a colleague has asked of you, in the order they come at you.
//
// Nothing here is a new store. A visit is the lead's site-visit field, a call due is
// lead.followUpAt, and "someone asked you for this" is an open @mention on a
// lead — all of it already synced, already live, already kept right by the
// automation. That is deliberate: a daily list built on a second copy of the
// truth is a daily list that goes stale by Wednesday.
//
// Each row opens to the things you reach for on the way out the door: who to
// call and on what number, who is selling, and the note that explains why.

(function () {
  'use strict';

  var DAY = 86400000;

  function startOfToday() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function endOfToday() { return startOfToday() + DAY - 1; }

  function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(s == null ? '' : s) : String(s == null ? '' : s); }
  // No leading zero: the clock column is narrow, and "3:00 PM" fits on one
  // line where "03:00 PM" wraps and stops looking like a time.
  function clock(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function dayName(ts) { return new Date(ts).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }); }
  function person(email) {
    var M = window.crmMentions;
    return M && email ? M.displayName(email) : (email || '');
  }
  // The lead's own site-visit field, falling back to the older AI verdict for
  // leads not re-read since the field existed. This file is a plain script, so
  // the shared module reaches it through the bridge crm.html sets up.
  function visitOf(l) { return window.crmPipeline.visitOf(l); }
  var ANSWER = { accepted: 'accepted', declined: 'cannot make it', tentative: 'maybe', needsAction: 'not accepted yet' };
  function replyStatus(item, email) {
    var r = (item.replies || []).filter(function (x) { return String(x.email).toLowerCase() === String(email).toLowerCase(); })[0];
    return r ? (r.status || 'needsAction') : 'needsAction';
  }
  // Who is going, each with where they stand on it.
  function assignedHtml(item) {
    if (!item.agents.length) return '<span class="td-unassigned">nobody assigned yet</span>';
    return item.agents.map(function (e) {
      var st = replyStatus(item, e);
      return '<span class="td-agent ' + st + '">' + esc(person(e)) + '<em>' + esc(ANSWER[st] || st) + '</em></span>';
    }).join('');
  }

  // The day is everybody's work, and the rows that are YOURS have to be
  // findable in it without reading every line. A person icon and a tinted
  // edge, not a colour that shouts: most of these will be yours most days, and
  // a screen that is entirely highlighted is a screen with no highlight.
  var MINE_ICON = '<svg class="td-mine-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

  // Beneath the time, in the same place on every row, so finding your own work
  // is running your eye down one column rather than reading each line. A pill
  // with words in it sits wherever the text before it happens to end, which is
  // a different place on every row and so is not scannable at all.
  //
  // Amber when it is still waiting on you, because those are the ones to deal
  // with first; the plain one just says the job is yours.
  function mineMark(waiting) {
    var label = waiting ? 'Yours \u2014 you have not answered' : 'Assigned to you';
    return '<span class="td-mine' + (waiting ? ' waiting' : '') + '" role="img"'
      + ' aria-label="' + label + '" title="' + label + '">' + MINE_ICON + '</span>';
  }

  function isMe(email) {
    return String(email || '').toLowerCase() === String(typeof currentUserEmail === 'string' ? currentUserEmail : '').toLowerCase();
  }

  function closedLead(l) {
    var key = typeof stageKeyOfId === 'function' ? stageKeyOfId(l.stageId) : null;
    return key === 'won' || key === 'lost';
  }

  // ── What is on today ──

  function visitsToday() {
    var from = startOfToday(), to = endOfToday();
    return (leads || []).filter(function (l) {
      var v = visitOf(l);
      return v.at && v.at >= from && v.at <= to && v.status !== 'done' && v.status !== 'cancelled' && !closedLead(l);
    }).map(function (l) {
      var v = visitOf(l);
      return { kind: 'visit', lead: l, at: v.at, property: v.property || '',
        // Who is going and whether they have actually said yes. A visit with
        // nobody on it, or one everybody has left unanswered, is the one to
        // sort out before the morning goes.
        agents: Array.isArray(l.siteVisitAgents) ? l.siteVisitAgents : [],
        replies: Array.isArray(l.siteVisitReplies) ? l.siteVisitReplies : [],
        byPhone: l.siteVisitMode === 'remote' };
    }).sort(function (a, b) { return a.at - b.at; });
  }

  // A meeting is not a lead, so it comes from the calendar rather than from
  // the board — the same list the bell reads, fetched once for both. A site
  // visit is NOT here: it already has a row above, built from the lead, which
  // carries the client and the seller a calendar entry does not.
  function meetingsToday() {
    return (typeof window.myMeetingsToday === 'function' ? window.myMeetingsToday() : []) || [];
  }

  // Anything due by the end of today, overdue included — a call you missed on
  // Friday is part of today whether or not the calendar agrees.
  function callsDue() {
    var to = endOfToday();
    var booked = {};
    visitsToday().forEach(function (v) { booked[v.lead.id] = 1; });
    return (leads || []).filter(function (l) {
      return l.followUpAt && l.followUpAt <= to && !closedLead(l) && !booked[l.id];
    }).map(function (l) {
      return { kind: 'call', lead: l, at: l.followUpAt, overdue: l.followUpAt < Date.now() };
    }).sort(function (a, b) { return a.at - b.at; });
  }

  function askedOfMe() {
    var M = window.crmMentions;
    if (!M || !currentUserEmail) return [];
    return M.openMentionsFor(leads || [], currentUserEmail).map(function (x) {
      return { kind: 'ask', lead: x.lead, mention: x.mention, at: x.mention.at };
    });
  }

  // ── The other side of a visit ──
  //
  // The CRM holds owners as leads of their own — an enquiry of type Seller
  // Listing. When one is about the same property, that IS the seller, with a
  // real number on it. When there is not one, the row says so rather than
  // leaving a blank where a phone number should be.
  function sellerFor(lead) {
    var codes = (lead.propertyCodes || []).map(function (c) { return String(c).toUpperCase(); });
    var want = String(lead.propertyInterest || '').trim().toLowerCase();
    var found = (leads || []).find(function (o) {
      if (o.id === lead.id) return false;
      if (String(o.enquiryType || '').trim().toLowerCase() !== 'seller listing') return false;
      var oCodes = (o.propertyCodes || []).map(function (c) { return String(c).toUpperCase(); });
      if (codes.length && oCodes.some(function (c) { return codes.indexOf(c) !== -1; })) return true;
      return !!want && String(o.propertyInterest || '').trim().toLowerCase() === want;
    });
    return found || null;
  }

  // ── Rows ──

  function phoneLine(label, name, phone) {
    if (!name && !phone) return '';
    var value = phone
      ? '<a class="td-tel" href="tel:' + esc(String(phone).replace(/[^\d+]/g, '')) + '">' + esc(phone) + '</a>'
      : '<span class="td-none">no number on file</span>';
    return '<div class="td-f"><dt>' + esc(label) + '</dt><dd>'
      + (name ? '<span class="td-nm">' + esc(name) + '</span> ' : '') + value + '</dd></div>';
  }

  function field(label, value) {
    if (!value) return '';
    return '<div class="td-f"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function latestNote(lead) {
    if (lead.followUpNote) return lead.followUpNote;
    if (lead.ai && lead.ai.line) return lead.ai.line;
    var t = typeof topAttentionUi === 'function' ? topAttentionUi(lead) : null;
    return t ? t.text : '';
  }

  function rowHtml(item) {
    var l = item.lead;
    // A meeting belongs to the calendar, not to a lead. Everything below that
    // reaches for l.id has to cope with there being none.
    var id = esc(l ? l.id : item.meeting.id);
    var head, body, cls = 'td-row';

    if (item.kind === 'visit') {
      var seller = sellerFor(l);
      // The code is what an agent quotes; the name is what tells you which
      // property this is without going and looking it up.
      var title = typeof propertyTitleOf === 'function' ? propertyTitleOf(item.property) : '';
      var mineOnVisit = (item.agents || []).some(isMe);
      if (mineOnVisit) cls += ' is-mine';
      head = '<span class="td-time">' + esc(clock(item.at))
        + (mineOnVisit ? mineMark(replyStatus(item, currentUserEmail) === 'needsAction') : '') + '</span>'
        + '<span class="td-main"><span class="td-what">'
        + (item.byPhone ? 'Coordinate by phone' : 'Site visit')
        + (item.property ? ' — <b>' + esc(item.property) + '</b>' : '')
        + (title ? ' <span class="td-prop">' + esc(title) + '</span>' : '') + '</span>'
        + '<span class="td-who">' + esc(l.name || 'Unnamed lead') + '</span>'
        + '<span class="td-assigned">' + assignedHtml(item) + '</span></span>';
      body = phoneLine('Client', l.name, l.phone)
        + phoneLine('Property owner', seller && seller.name, seller && seller.phone)
        + (seller ? '' : '<div class="td-f"><dt>Property owner</dt><dd><span class="td-none">no owner listing on file for this property</span></dd></div>')
        + field('Looking for', l.propertyInterest)
        + field('Budget', l.budget)
        + field('Notes', latestNote(l));
    } else if (item.kind === 'meeting') {
      var m = item.meeting;
      var ANS = { accepted: 'you are coming', declined: 'you said no', tentative: 'you said maybe', needsAction: 'you have not answered' };
      // Whether YOU have answered comes first: it is the only part of a
      // meeting that is still yours to do.
      // Every meeting in this list is one you are on — it came from your own
      // calendar — so what is worth marking is the ones still waiting on you.
      if (m.mine === 'needsAction') cls += ' is-mine';
      head = '<span class="td-time">' + esc(clock(item.at))
        + (m.today ? '' : '<em class="td-day">' + esc(new Date(m.at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })) + '</em>')
        + (m.mine === 'needsAction' ? mineMark(true) : '') + '</span>'
        + '<span class="td-main"><span class="td-what">' + esc(m.title) + '</span>'
        + '<span class="td-who">' + (m.where ? esc(m.where) + ' · ' : '')
        + (m.end ? 'until ' + esc(clock(m.end)) : '') + '</span>'
        + '<span class="td-assigned">'
        + '<span class="td-agent ' + (m.mine || 'needsAction') + '">'
        + esc(ANS[m.mine] || 'you have not answered') + '</span>'
        + (m.attendees || []).filter(function (a) { return !isMe(a.email); }).slice(0, 4).map(function (a) {
            return '<span class="td-agent ' + (a.status || 'needsAction') + '">' + esc(person(a.email)) + '</span>';
          }).join('')
        + '</span></span>';
      var about = m.about || '';
      body = (m.meet ? '<div class="td-f"><dt>Video</dt><dd><a href="' + esc(m.meet) + '" target="_blank" rel="noopener">Join the call</a></dd></div>' : '')
        + field('Where', m.where)
        + field('Who else', (m.attendees || []).filter(function (a) { return !isMe(a.email); })
            .map(function (a) { return person(a.email); }).join(', '))
        // What the person who called the meeting wrote down. On a booking made
        // off a lead that is the client, their number and the office's notes,
        // which is what somebody opening this at nine in the morning needs.
        + (about ? '<div class="td-f"><dt>Notes</dt><dd class="td-pre">' + esc(about) + '</dd></div>' : '');
    } else if (item.kind === 'call') {
      if (item.overdue) cls += ' is-late';
      head = '<span class="td-time">' + esc(clock(item.at)) + (item.overdue ? '<em>late</em>' : '') + '</span>'
        + '<span class="td-main"><span class="td-what">' + esc(latestNote(l) || 'Follow up') + '</span>'
        + '<span class="td-who">' + esc(l.name || 'Unnamed lead') + '</span></span>';
      body = phoneLine('Client', l.name, l.phone)
        + field('Looking for', l.propertyInterest)
        + field('Budget', l.budget)
        + field('Where it stands', (function () {
          var s = typeof stageById === 'function' ? stageById(l.stageId) : null;
          return s ? s.name : '';
        })());
    } else {
      var m = item.mention;
      head = '<span class="td-time td-time-ask">Task</span>'
        + '<span class="td-main"><span class="td-what">' + esc(m.text || 'Asked for your help') + '</span>'
        + '<span class="td-who">on ' + esc(l.name || 'a lead') + '</span></span>';
      body = field('Asked by', person(m.by) || 'A colleague')
        + field('Asked', new Date(m.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
        + field('Due', l.followUpAt ? new Date(l.followUpAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'No date set')
        + field('Notes', m.text)
        + phoneLine('Client', l.name, l.phone);
    }

    // An invitation you have not answered is answered HERE. Making somebody
    // open the calendar to say yes is how a meeting sits unanswered until the
    // morning it happens.
    var answer = (item.kind === 'meeting' && item.meeting.mine === 'needsAction')
      ? '<button type="button" class="td-act go" onclick="PinToday.answer(\'' + esc(item.meeting.id) + '\',\'accepted\')">I can come</button>'
        + '<button type="button" class="td-act" onclick="PinToday.decline(\'' + esc(item.meeting.id) + '\')">Can' + '\u2019' + 't make it</button>'
      : '';

    var acts = '<div class="td-acts">' + answer
      // A meeting has no lead to open. It opens in the calendar, which is
      // where it can be answered.
      + (item.kind === 'meeting'
          ? '<button type="button" class="td-act" onclick="PinToday.openMeeting(\'' + id + '\')">Open it</button>'
          : '<button type="button" class="td-act" onclick="openDetail(\'' + id + '\')">Open lead</button>')
      + (item.kind === 'ask' ? '<button type="button" class="td-act done" onclick="markMentionDone(\'' + id + '\')">✓ Done</button>' : '')
      + '</div>';

    var openNow = item.kind === 'meeting' && item.meeting.mine === 'needsAction';
    return '<details class="' + cls + '"' + (openNow ? ' open' : '') + '><summary>' + head
      + '<i class="td-chev fa-solid fa-chevron-down" aria-hidden="true"></i></summary>'
      + '<div class="td-body"><dl class="td-dl">' + body + '</dl>' + acts + '</div></details>';
  }

  // How many of a section are yours. Beside the heading, so you can tell
  // whether a section is worth reading before you read any of it, and amber
  // when some of yours are still unanswered.
  function mineIn(items) {
    var mine = 0, waiting = 0;
    (items || []).forEach(function (it) {
      if (it.kind === 'visit') {
        if ((it.agents || []).some(isMe)) { mine++; if (replyStatus(it, currentUserEmail) === 'needsAction') waiting++; }
      } else if (it.kind === 'meeting') {
        // Every meeting in this list is already yours — it came out of your own
        // calendar — so "yours" marks nothing. The ones still waiting on your
        // answer are the ones worth finding.
        if (it.meeting.mine === 'needsAction') { mine++; waiting++; }
      }
    });
    return { mine: mine, waiting: waiting };
  }

  function sectionHtml(title, note, items, emptyLine) {
    var m = mineIn(items);
    return '<section class="td-sec">'
      + '<h2 class="td-sec-h"><span class="td-sec-t">' + esc(title) + '</span>'
      + (items.length ? '<span class="td-n">' + items.length + '</span>' : '')
      + (m.mine ? '<span class="td-sec-mine' + (m.waiting ? ' waiting' : '') + '"'
          + ' title="' + m.mine + ' of these ' + (m.mine === 1 ? 'is' : 'are') + ' yours'
          + (m.waiting ? ', ' + m.waiting + ' still unanswered' : '') + '">'
          + MINE_ICON + m.mine + '</span>' : '') + '</h2>'
      + '<p class="td-sec-note">' + esc(note) + '</p>'
      + (items.length ? items.map(rowHtml).join('') : '<p class="td-empty">' + esc(emptyLine) + '</p>')
      + '</section>';
  }

  window.PinToday = {
    answer: function (id, response, reason) {
      if (typeof window.answerMeeting !== 'function') return;
      window.answerMeeting(id, response, reason);
    },
    decline: function (id) {
      var why = prompt('Why can' + '\u2019' + 't you make it? Everyone invited sees this.', '');
      if (why === null) return;
      if (typeof window.answerMeeting === 'function') window.answerMeeting(id, 'declined', String(why).trim().slice(0, 300));
    },
    openMeeting: function (id) {
      if (typeof toggleView === 'function') toggleView('calendar');
      setTimeout(function () { if (window.PinCalendar) window.PinCalendar.openEvent(id); }, 350);
    }
  };

  window.renderTodayView = function () {
    var host = document.getElementById('todayView');
    if (!host) return;

    var visits = visitsToday();
    var meetings = meetingsToday().map(function (m) { return { kind: 'meeting', meeting: m, at: m.at, lead: null }; });
    var calls = callsDue();
    var asks = askedOfMe();
    var total = visits.length + meetings.length + calls.length + asks.length;

    var me = person(currentUserEmail);
    var late = calls.filter(function (c) { return c.overdue; }).length;

    // The subtitle is the day in one sentence. "You are clear" is worth saying
    // plainly; so is "two of these are already late".
    var summary;
    if (!total) summary = 'Nothing booked and nothing owed. A good day to work the board.';
    else {
      var bits = [];
      if (visits.length) bits.push(visits.length + (visits.length === 1 ? ' visit' : ' visits'));
      if (meetings.length) bits.push(meetings.length + (meetings.length === 1 ? ' meeting' : ' meetings'));
      if (calls.length) bits.push(calls.length + (calls.length === 1 ? ' call' : ' calls') + (late ? ' (' + late + ' late)' : ''));
      if (asks.length) bits.push(asks.length + (asks.length === 1 ? ' thing asked of you' : ' things asked of you'));
      summary = bits.join(' · ');
    }

    host.innerHTML =
      '<div class="td-wrap">'
      + '<header class="td-head">'
      + '<div class="td-eyebrow">' + esc(dayName(Date.now())) + '</div>'
      + '<h1 class="td-title">' + (me ? 'Your day, ' + esc(me) : 'Your day') + '</h1>'
      + '<p class="td-sub">' + esc(summary) + '</p>'
      + '</header>'
      + sectionHtml('Site visits', 'Booked for today. Open one for both numbers before you leave.',
        visits, 'No visits booked for today.')
      + sectionHtml('Meetings', 'With the team. Open one to answer it or to join the call.',
        meetings, 'No meetings today.')
      + sectionHtml('Calls due', 'Follow-ups due by the end of today, including any you missed.',
        calls, 'Nothing due today.')
      + sectionHtml('Asked of you', 'Where a colleague put your name in a note on a lead.',
        asks, 'Nobody is waiting on you.')
      + '</div>';
  };
})();
