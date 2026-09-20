// ═══════ DAILY TASK — what the person signed in has to do today ═══════
//
// Every other screen in the CRM is a view of the leads. This one is a view of
// the DAY: the visits that are booked, the calls that are due, and the things
// a colleague has asked of you, in the order they come at you.
//
// Nothing here is a new store. A visit is lead.ai.visit, a call due is
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
  function closedLead(l) {
    var key = typeof stageKeyOfId === 'function' ? stageKeyOfId(l.stageId) : null;
    return key === 'won' || key === 'lost';
  }

  // ── What is on today ──

  function visitsToday() {
    var from = startOfToday(), to = endOfToday();
    return (leads || []).filter(function (l) {
      var v = l.ai && l.ai.visit;
      return v && v.at && v.at >= from && v.at <= to && v.status !== 'done' && v.status !== 'cancelled' && !closedLead(l);
    }).map(function (l) {
      return { kind: 'visit', lead: l, at: l.ai.visit.at, property: l.ai.visit.property || '' };
    }).sort(function (a, b) { return a.at - b.at; });
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
    var id = esc(l.id);
    var head, body, cls = 'td-row';

    if (item.kind === 'visit') {
      var seller = sellerFor(l);
      head = '<span class="td-time">' + esc(clock(item.at)) + '</span>'
        + '<span class="td-main"><span class="td-what">Site visit'
        + (item.property ? ' — <b>' + esc(item.property) + '</b>' : '') + '</span>'
        + '<span class="td-who">' + esc(l.name || 'Unnamed lead') + '</span></span>';
      body = phoneLine('Client', l.name, l.phone)
        + phoneLine('Seller', seller && seller.name, seller && seller.phone)
        + (seller ? '' : '<div class="td-f"><dt>Seller</dt><dd><span class="td-none">no owner listing on file for this property</span></dd></div>')
        + field('Looking for', l.propertyInterest)
        + field('Budget', l.budget)
        + field('Notes', latestNote(l));
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

    var acts = '<div class="td-acts">'
      + '<button type="button" class="td-act" onclick="openDetail(\'' + id + '\')">Open lead</button>'
      + (item.kind === 'ask' ? '<button type="button" class="td-act done" onclick="markMentionDone(\'' + id + '\')">✓ Done</button>' : '')
      + '</div>';

    return '<details class="' + cls + '"><summary>' + head
      + '<i class="td-chev fa-solid fa-chevron-down" aria-hidden="true"></i></summary>'
      + '<div class="td-body"><dl class="td-dl">' + body + '</dl>' + acts + '</div></details>';
  }

  function sectionHtml(title, note, items, emptyLine) {
    return '<section class="td-sec">'
      + '<h2 class="td-sec-h"><span class="td-sec-t">' + esc(title) + '</span>'
      + (items.length ? '<span class="td-n">' + items.length + '</span>' : '') + '</h2>'
      + '<p class="td-sec-note">' + esc(note) + '</p>'
      + (items.length ? items.map(rowHtml).join('') : '<p class="td-empty">' + esc(emptyLine) + '</p>')
      + '</section>';
  }

  window.renderTodayView = function () {
    var host = document.getElementById('todayView');
    if (!host) return;

    var visits = visitsToday();
    var calls = callsDue();
    var asks = askedOfMe();
    var total = visits.length + calls.length + asks.length;

    var me = person(currentUserEmail);
    var late = calls.filter(function (c) { return c.overdue; }).length;

    // The subtitle is the day in one sentence. "You are clear" is worth saying
    // plainly; so is "two of these are already late".
    var summary;
    if (!total) summary = 'Nothing booked and nothing owed. A good day to work the board.';
    else {
      var bits = [];
      if (visits.length) bits.push(visits.length + (visits.length === 1 ? ' visit' : ' visits'));
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
      + sectionHtml('Calls due', 'Follow-ups due by the end of today, including any you missed.',
        calls, 'Nothing due today.')
      + sectionHtml('Asked of you', 'Where a colleague put your name in a note on a lead.',
        asks, 'Nobody is waiting on you.')
      + '</div>';
  };
})();
