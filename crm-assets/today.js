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

  // How far ahead the screen looks. Today is the default and the narrowest;
  // the week and the month widen the SAME four lists rather than showing
  // something else, so nothing is counted differently depending on the toggle.
  var SPANS = [['day', 'Today'], ['week', 'This week'], ['month', 'This month']];
  var span = 'day';
  try { var saved = localStorage.getItem('pinTodaySpan'); if (saved === 'week' || saved === 'month') span = saved; } catch (e) { /* default */ }
  function endOfSpan() {
    var d = new Date(startOfToday());
    // Through Saturday — but on a Friday, Saturday or Sunday, through NEXT Saturday: weekends are
    // when visits happen, and "this week" on a Saturday used to mean just today.
    if (span === 'week') { const add = 7 - d.getDay(); d.setDate(d.getDate() + (add <= 2 ? add + 7 : add)); return d.getTime() - 1; }
    if (span === 'month') { d.setDate(1); d.setMonth(d.getMonth() + 1); return d.getTime() - 1; }
    return endOfToday();
  }
  // How each section is ordered — picked per section from the Sort box beside its heading, and
  // remembered on this device. "Suggested" is each section's own order (yours first, then by time).
  var SORTS = [['default', 'Suggested'], ['old', 'Most overdue first'], ['new', 'Newest first'], ['name', 'Name A–Z'], ['active', 'Recently active']];
  var sorts = {};
  try { sorts = JSON.parse(localStorage.getItem('pinTodaySort') || '{}') || {}; } catch (e) { sorts = {}; }
  function nameOfItem(it) {
    return String((it.lead && it.lead.name) || (it.meeting && it.meeting.title) || (it.task && it.task.title) || (it.x && cardTitle(it.x)) || '').toLowerCase();
  }
  function activeAt(it) { var l = it.lead; return l ? Math.max(l.updatedAt || 0, (l.tt && l.tt.lastMessageAt) || 0, l.createdAt || 0) : (it.at || 0); }
  // Undated (a task with no due date) goes last whichever way the dates run.
  function dated(at) { return typeof at === 'number' && isFinite(at); }
  function sortItems(key, items) {
    var how = sorts[key] || 'default';
    if (how === 'default') return items;
    var out = items.slice();
    if (how === 'name') out.sort(function (a, b) { return nameOfItem(a).localeCompare(nameOfItem(b)); });
    else if (how === 'active') out.sort(function (a, b) { return activeAt(b) - activeAt(a); });
    else out.sort(function (a, b) {
      if (!dated(a.at) || !dated(b.at)) return dated(a.at) ? -1 : dated(b.at) ? 1 : 0;
      return how === 'old' ? a.at - b.at : b.at - a.at;
    });
    return out;
  }
  // Whole days past due, counted in calendar days: a call due yesterday evening is 1 day late this morning.
  function daysLate(at) {
    var d = new Date(at); d.setHours(0, 0, 0, 0);
    return Math.round((startOfToday() - d.getTime()) / DAY);
  }
  function lateTag(at) {
    var n = daysLate(at);
    return '<em title="Due ' + esc(new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })) + '">' + (n > 0 ? n + 'd late' : 'late') + '</em>';
  }

  function spanWord() { return span === 'week' ? 'this week' : span === 'month' ? 'this month' : 'today'; }
  function dayTag(ts) {
    if (ts >= startOfToday() && ts <= endOfToday()) return '';
    return '<em class="td-day">' + esc(new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })) + '</em>';
  }

  function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(s == null ? '' : s) : String(s == null ? '' : s); }
  // No leading zero: the clock column is narrow, and "3:00 PM" fits on one
  // line where "03:00 PM" wraps and stops looking like a time.
  function clock(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  // ── When you last opened each row ──
  // The same late call sits on this screen day after day, and nothing said whether you had already
  // looked at it this morning. Each row now remembers when YOU opened it: the closed row says
  // "3h ago", the open one lists the last few times. One sitting counts once (a row opened and
  // shut five times in ten minutes was looked at once), and while you are in that sitting the row
  // shows the time BEFORE it — that is the one that answers "did I already check this?".
  // Kept on this device at once, and in your own todayOpens document so the phone and the laptop
  // agree (crmTodayOpens in firebase-sync.js). Opening a row never writes to the lead.
  var SITTING = 30 * 60000, OPEN_KEEP = 8, OPEN_DAYS = 45;
  var opens = {}, opensFor = null, opensSave = null;
  function opensKey() { return 'pinTodayOpens:' + String(currentUserEmail || '').toLowerCase(); }
  function tidyOpens(map) {
    var cut = Date.now() - OPEN_DAYS * DAY, out = {};
    Object.keys(map || {}).forEach(function (k) {
      var list = (Array.isArray(map[k]) ? map[k] : []).filter(function (t) { return typeof t === 'number' && t > cut; })
        .sort(function (a, b) { return b - a; })
        .filter(function (t, i, all) { return !i || all[i - 1] - t > 1000; }).slice(0, OPEN_KEEP);
      if (list.length) out[k] = list;
    });
    return out;
  }
  function mergeOpens(a, b) {
    var out = {};
    [a, b].forEach(function (m) { Object.keys(m || {}).forEach(function (k) { out[k] = (out[k] || []).concat(m[k] || []); }); });
    return tidyOpens(out);
  }
  // Loaded once per person: from this device straight away, then from Firestore when it answers.
  function loadOpens() {
    if (!currentUserEmail || opensFor === currentUserEmail) return;
    opensFor = currentUserEmail;
    try { opens = tidyOpens(JSON.parse(localStorage.getItem(opensKey()) || '{}')); } catch (e) { opens = {}; }
    var remote = window.crmTodayOpens;
    if (remote) remote.load().then(function (m) {
      if (!m) return;
      opens = mergeOpens(opens, m);
      keepOpens(false);
      redraw();
    }).catch(function () { /* this device's record still stands */ });
  }
  function keepOpens(remoteToo) {
    try { localStorage.setItem(opensKey(), JSON.stringify(opens)); } catch (e) { /* the remote copy still has it */ }
    if (!remoteToo || !window.crmTodayOpens) return;
    clearTimeout(opensSave);
    opensSave = setTimeout(function () { window.crmTodayOpens.save(opens).catch(function () { /* kept on this device */ }); }, 2000);
  }
  function recordOpen(key) {
    var list = opens[key] || [];
    if (list.length && Date.now() - list[0] < SITTING) return;
    opens[key] = [Date.now()].concat(list).slice(0, OPEN_KEEP);
    keepOpens(true);
  }
  function openKeyOf(item) {
    if (item.kind === 'visit') return 'visit:' + item.lead.id + ':' + item.at;
    if (item.kind === 'call') return 'call:' + item.lead.id;
    if (item.kind === 'ask') return 'ask:' + item.lead.id + ':' + item.mention.at;
    if (item.kind === 'reply') return 'reply:' + item.lead.id + ':' + item.at;
    if (item.kind === 'meeting') return 'meeting:' + item.meeting.id;
    if (item.kind === 'vo') return 'vo:' + item.x.id;
    return '';
  }
  function ago(ts) {
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.round(m / 60) + 'h ago';
    return Math.round(m / 1440) + 'd ago';
  }
  function whenOpened(ts) {
    var day = new Date(ts); day.setHours(0, 0, 0, 0);
    var d = Math.round((startOfToday() - day.getTime()) / DAY);
    return (d === 0 ? 'today ' : d === 1 ? 'yesterday ' : new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ', ') + clock(ts);
  }
  // The closed row: the last time you looked before now. Nothing at all on a row you have never opened.
  function seenTag(key) {
    var list = opens[key] || [];
    if (!list.length) return '';
    var inSitting = Date.now() - list[0] < SITTING;
    var shown = inSitting ? list[1] : list[0];
    var text = 'opened ' + (shown ? ago(shown) : 'just now');
    var title = 'You opened this ' + (list.length === 1 ? 'once' : list.length + (list.length === OPEN_KEEP ? '+' : '') + ' times') + ' — last ' + whenOpened(list[0]);
    return '<span class="td-seen" title="' + esc(title) + '"><i class="fa-regular fa-eye" aria-hidden="true"></i>' + esc(text) + '</span>';
  }
  // The open row: when you looked, newest first.
  function seenField(key) {
    var list = opens[key] || [];
    if (!list.length) return '';
    return '<div class="td-f"><dt>You opened it</dt><dd>' + esc(list.map(whenOpened).join(' · '))
      + (list.length === OPEN_KEEP ? ' <span class="td-none">and earlier</span>' : '') + '</dd></div>';
  }
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

  // ── Shoot & Media: voice-overs asked for ──
  // The cards come read-only from Shoot & Media (firebase-sync.js, from the first time this view opens);
  // which voice-overs are waiting is track-assets/voiceover.js, the same reading the board uses. A
  // voice-over is asked for by the editor once the rough cut is ready — only then is it the voice-over
  // person's (Settings → Configurations on Shoot & Media). Everyone sees them; theirs are marked.
  var vo = { listings: [], stages: [], by: '', email: '' };
  function redraw() { if (typeof currentView !== 'undefined' && currentView === 'today' && window.renderTodayView) window.renderTodayView(); }
  window.applyTrackTaskListings = function (list) { vo.listings = list || []; redraw(); };
  window.applyTrackTaskStages = function (list) { vo.stages = list || []; redraw(); };
  window.applyTrackTaskConfig = function (cfg) {
    var b = String((cfg && cfg.voiceBy) || '').trim(), e = String((cfg && cfg.voiceByEmail) || '').trim().toLowerCase();
    if (b !== vo.by || e !== vo.email) { vo.by = b; vo.email = e; redraw(); }
  };
  var VO_SHORT = { igStory: 'Story', igReel: 'Reel', fbReel: 'FB Reel', yt: 'YouTube', collab: 'Collab', ads: 'Ads', all: 'Video' };
  // By email when Settings has it (picked from the team); by name otherwise.
  function voIsMe() {
    if (vo.email) return isMe(vo.email);
    var V = window.trackVO; return !!(V && vo.by && V.isVoicePerson(vo.by, currentUserEmail));
  }
  function voiceOvers() {
    var V = window.trackVO;
    if (!V) return [];
    var me = voIsMe();
    return V.voTasks(vo.listings, vo.stages, { asked: true }).map(function (t) {
      return { kind: 'vo', x: t.x, left: t.left, at: t.at, mine: me, lead: null };
    });
  }
  function cardTitle(x) {
    return String(x.title || x.seriesName || x.propertyCode || 'A property');
  }

  function closedLead(l) {
    var key = typeof stageKeyOfId === 'function' ? stageKeyOfId(l.stageId) : null;
    return key === 'won' || key === 'lost';
  }

  // ── What is on today ──

  function visitsToday() {
    var from = startOfToday(), to = endOfSpan();
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
    return (typeof window.myMeetingsToday === 'function' ? window.myMeetingsToday(endOfSpan()) : []) || [];
  }

  // Anything due by the end of today, overdue included — a call you missed on
  // Friday is part of today whether or not the calendar agrees.
  function callsDue() {
    var to = endOfSpan();
    var booked = {};
    visitsToday().forEach(function (v) { booked[v.lead.id] = 1; });
    return (leads || []).filter(function (l) {
      return l.followUpAt && l.followUpAt <= to && !closedLead(l) && !booked[l.id] && !replyOwnsFollowUp(l);
    }).map(function (l) {
      // Mine = I am the lead's agent or its secondary. Listed first and marked, so "Your day"
      // starts with your own calls rather than the whole company's.
      var me = String(typeof currentUserEmail === 'string' ? currentUserEmail : '').toLowerCase();
      var mine = !!me && [l.assignedAgent, l.secondaryAgent].some(function (e) { return e && String(e).toLowerCase() === me; });
      return { kind: 'call', lead: l, at: l.followUpAt, overdue: l.followUpAt < Date.now(), mine: mine };
    }).sort(function (a, b) { return (b.mine - a.mine) || (a.at - b.at); });
  }

  // ── Answers to WhatsApp campaigns ──
  // Every reply nobody has acted on since it came in (leadAttention.js decides "open", the same rule
  // as the bell). Newest first: a "call me" from ten minutes ago is the warmest lead on the screen —
  // but one who said "call me after 6" waits below the rest until six.
  // Replies are all already in, so the span toggle does not change this list — only what is due does.
  // Two lists from one rule (leadAttention.replyNeedsPerson): the replies that need a person, which
  // are counted, and the ones only to know — an opt-out, "stop offers", "not this one" — listed
  // under them and never counted. An "ok" / "thanks" is neither.
  function campaignReplies(info) {
    var A = window.leadAttention;
    if (!A || !A.openCampaignReply || !A.replyNeedsPerson) return [];
    var me = String(typeof currentUserEmail === 'string' ? currentUserEmail : '').toLowerCase();
    var now = Date.now();
    return (leads || []).map(function (l) {
      var r = A.openCampaignReply(l);
      if (!r || A.replyNeedsPerson(l) === !!info) return null;
      var meta = A.campaignReplyMeta(r.action, { stageKey: stageKeyOfLead(l) });
      if (meta.silent) return null;
      var mine = !!me && [l.assignedAgent, l.secondaryAgent].some(function (e) { return e && String(e).toLowerCase() === me; });
      return { kind: 'reply', lead: l, reply: r, meta: meta, at: r.at, callAt: A.replyCallAt ? A.replyCallAt(r, now) : null, mine: mine };
    }).filter(Boolean).sort(function (a, b) { return (b.mine - a.mine) || (!!a.callAt - !!b.callAt) || (b.at - a.at); });
  }
  function stageKeyOfLead(l) {
    var s = typeof stageById === 'function' ? stageById(l.stageId) : null;
    return s && window.crmPipeline ? window.crmPipeline.stageKeyOf(s) : null;
  }
  // The follow-up a reply set ("Asked for a call — …") is that reply's row, not a second one under Calls due.
  function replyOwnsFollowUp(l) {
    var A = window.leadAttention;
    return l.followUpBy === 'campaign' && !!(A && A.replyNeedsPerson && A.replyNeedsPerson(l));
  }
  // The section is only for an office that sends campaigns.
  function campaignsInUse() {
    return (leads || []).some(function (l) { return (Array.isArray(l.campaignLog) && l.campaignLog.length) || l.campaignReply; });
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
      // The same seller rule as the rest of the CRM and the board (isSellerLead): an owner the AI
      // recognised counts too, not only one whose enquiry type was set by hand.
      var seller = typeof isSellerLead === 'function' ? isSellerLead(o)
        : String(o.enquiryType || '').trim().toLowerCase() === 'seller listing';
      if (!seller) return false;
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
    if (item.kind === 'task') return window.PinTasks ? window.PinTasks.todayRowHtml(item.task) : '';
    var l = item.lead;
    // A meeting belongs to the calendar, not to a lead. Everything below that
    // reaches for l.id has to cope with there being none.
    var id = esc(l ? l.id : item.meeting ? item.meeting.id : item.x.id);
    var head, body, cls = 'td-row';

    if (item.kind === 'visit') {
      var seller = sellerFor(l);
      // The code is what an agent quotes; the name is what tells you which
      // property this is without going and looking it up.
      var title = typeof propertyTitleOf === 'function' ? propertyTitleOf(item.property) : '';
      var mineOnVisit = (item.agents || []).some(isMe);
      if (mineOnVisit) cls += ' is-mine';
      head = '<span class="td-time">' + esc(clock(item.at)) + dayTag(item.at)
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
    } else if (item.kind === 'vo') {
      var x = item.x, outs = item.left.map(function (o) { return VO_SHORT[o.k] || o.label; }).join(', ');
      if (item.mine) cls += ' is-mine';
      var asks = item.left.map(function (o) { return o.ask; }).filter(Boolean);
      var notes = asks.map(function (a) { return a.note; }).filter(Boolean).join(' · ');
      var askers = asks.map(function (a) { return a.by; }).filter(Boolean).filter(function (n, i, all) { return all.indexOf(n) === i; }).join(', ');
      head = '<span class="td-time td-time-ask">V/O' + (item.mine ? mineMark(false) : '') + '</span>'
        + '<span class="td-main"><span class="td-what">Voice-over — <b>' + esc(outs) + '</b></span>'
        + '<span class="td-who">' + esc(cardTitle(x)) + (x.propertyCode && cardTitle(x) !== x.propertyCode ? ' · ' + esc(x.propertyCode) : '')
        + (askers ? ' · asked by ' + esc(askers) : '') + '</span></span>';
      body = field('For', outs)
        + field('Asked', (askers ? askers + ', ' : '') + new Date(item.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))
        + field('Note', notes)
        + field('Who makes it', vo.by || 'Not set — Shoot & Media → Settings → Configurations')
        + '<div class="td-f"><dt>When it is made</dt><dd>Tick <b>V/O made</b> on the card in Shoot &amp; Media.</dd></div>';
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
      if (item.mine) cls += ' is-mine';
      head = '<span class="td-time">' + esc(clock(item.at)) + (item.overdue ? lateTag(item.at) : dayTag(item.at)) + (item.mine ? mineMark(false) : '') + '</span>'
        + '<span class="td-main"><span class="td-what">' + esc(latestNote(l) || 'Follow up') + '</span>'
        + '<span class="td-who">' + esc(l.name || 'Unnamed lead') + '</span></span>';
      body = phoneLine('Client', l.name, l.phone)
        + field('Looking for', l.propertyInterest)
        + field('Budget', l.budget)
        + field('Where it stands', (function () {
          var s = typeof stageById === 'function' ? stageById(l.stageId) : null;
          return s ? s.name : '';
        })());
    } else if (item.kind === 'reply') {
      var r = item.reply, mt = item.meta;
      var callAtWords = item.callAt && window.leadAttention.callAtText ? window.leadAttention.callAtText(item.callAt) : '';
      if (item.mine) cls += ' is-mine';
      cls += mt.info ? ' is-reply-info' : item.callAt ? ' is-reply is-later' : ' is-reply';
      // A time they named is the time on the row: "Call at 6 PM today", and not late before then.
      head = '<span class="td-time">' + (item.callAt ? esc(clock(item.callAt)) + dayTag(item.callAt) : esc(clock(item.at)) + dayTag(item.at)) + (item.mine ? mineMark(false) : '') + '</span>'
        + '<span class="td-main"><span class="td-what">' + esc(mt.label(r))
        + (callAtWords ? ' <span class="td-callat">Call at ' + esc(callAtWords) + '</span>' : '') + '</span>'
        + '<span class="td-who">' + esc(l.name || 'Unnamed lead')
        + (r.text ? ' · <q class="td-q">' + esc(r.text.length > 90 ? r.text.slice(0, 89) + '…' : r.text) + '</q>' : '') + '</span></span>';
      body = '<div class="td-f"><dt>They said</dt><dd class="td-pre">' + esc(r.text || '(no text)') + '</dd></div>'
        + '<div class="td-f"><dt>Campaign</dt><dd>' + esc(r.campaignName || r.template || 'A campaign')
        + (r.campaignId ? ' <button type="button" class="td-link" onclick="PinToday.openCampaign(\'' + esc(r.campaignId) + '\')">Open it</button>' : '') + '</dd></div>'
        + field('Next step', callAtWords ? mt.next + ' — at ' + callAtWords + ', the time they asked for' : mt.next)
        + field('Replied', new Date(r.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))
        + (mt.info ? '' : phoneLine('Client', l.name, l.phone))
        + field('Looking for', l.propertyInterest)
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
      + (item.kind === 'vo'
          ? '<a class="td-act go" href="propertytrack.html?listing=' + encodeURIComponent(item.x.id) + '">Open the card</a>'
          : item.kind === 'meeting'
          ? '<button type="button" class="td-act" onclick="PinToday.openMeeting(\'' + id + '\')">Open it</button>'
          : '<button type="button" class="td-act" onclick="openDetail(\'' + id + '\')">Open lead</button>')
      + (item.kind === 'ask' ? '<button type="button" class="td-act done" onclick="markMentionDone(\'' + id + '\')">✓ Done</button>' : '')
      // A call row logs the call where it is: what happened and the next follow-up, one sheet.
      + (item.kind === 'call' ? '<button type="button" class="td-act go" onclick="openFollowUpLogModal(\'' + id + '\')">✓ Log call</button>' : '')
      + (item.kind === 'reply' ? replyActs(item, id) : '')
      + '</div>';

    var openNow = item.kind === 'meeting' && item.meeting.mine === 'needsAction';
    var okey = openKeyOf(item);
    return '<details class="' + cls + '"' + (openNow ? ' open' : '') + (okey ? ' data-open-key="' + esc(okey) + '"' : '') + '><summary>' + head
      + (okey ? seenTag(okey) : '')
      + '<i class="td-chev fa-solid fa-chevron-down" aria-hidden="true"></i></summary>'
      + '<div class="td-body"><dl class="td-dl">' + body + (okey ? seenField(okey) : '') + '</dl>' + acts + '</div></details>';
  }

  // A reply is answered by talking to them, then logged — which is what closes it. An opt-out,
  // "stop offers" or "not this one" only needs noting: the server has already acted on it.
  function replyActs(item, id) {
    var l = item.lead, label = item.meta.label(item.reply);
    var handled = '<button type="button" class="td-act done" onclick="markHandledUi(\'' + id + '\', ' + esc(JSON.stringify(label)) + ')">✓ ' + (item.meta.info ? 'Noted' : 'Handled') + '</button>';
    if (item.meta.info) return handled;
    var tel = String(l.phone || '').replace(/[^\d+]/g, '');
    var wa = typeof waHref === 'function' ? waHref(l.phone) : null;
    return (tel ? '<a class="td-act" href="tel:' + esc(tel) + '" onclick="noteCallStarted(\'' + id + '\')">📞 Call</a>' : '')
      + (wa ? '<a class="td-act" href="' + esc(wa) + '" target="_blank" rel="noopener">💬 WhatsApp</a>' : '')
      + '<button type="button" class="td-act go" onclick="openFollowUpLogModal(\'' + id + '\')">✓ Log call</button>'
      + handled;
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
      } else if (it.kind === 'call') {
        if (it.mine) { mine++; if (it.overdue) waiting++; }
      } else if (it.kind === 'reply') {
        if (it.mine) { mine++; if (!it.meta.info) waiting++; }
      } else if (it.kind === 'vo') {
        if (it.mine) mine++;
      } else if (it.kind === 'task') {
        mine++;
      }
    });
    return { mine: mine, waiting: waiting };
  }

  // `known`: rows only to know (an opt-out, "not this one"), listed under the section's own rows,
  // outside its count, its "yours" mark and its sort.
  function sectionHtml(key, title, note, items, emptyLine, known) {
    var m = mineIn(items);
    items = sortItems(key, items);
    var how = sorts[key] || 'default';
    var sortBox = items.length > 1
      ? '<label class="td-sort">'
        + '<select onchange="PinToday.setSort(\'' + key + '\', this.value)" aria-label="Sort ' + esc(title.toLowerCase()) + '" title="Sort ' + esc(title.toLowerCase()) + '">'
        + SORTS.map(function (o) { return '<option value="' + o[0] + '"' + (how === o[0] ? ' selected' : '') + '>' + (o[0] === 'default' ? 'Sort: ' : '') + esc(o[1]) + '</option>'; }).join('')
        + '</select></label>'
      : '';
    return '<section class="td-sec">'
      + '<h2 class="td-sec-h"><span class="td-sec-t">' + esc(title) + '</span>'
      + (items.length ? '<span class="td-n">' + items.length + '</span>' : '')
      + (m.mine ? '<span class="td-sec-mine' + (m.waiting ? ' waiting' : '') + '"'
          + ' title="' + m.mine + ' of these ' + (m.mine === 1 ? 'is' : 'are') + ' yours'
          + (m.waiting ? ', ' + m.waiting + ' still unanswered' : '') + '">'
          + MINE_ICON + m.mine + '</span>' : '') + sortBox + '</h2>'
      + '<p class="td-sec-note">' + esc(note) + '</p>'
      + (items.length ? items.map(rowHtml).join('') : '<p class="td-empty">' + esc(emptyLine) + '</p>')
      + (known && known.length ? '<div class="td-known"><h3 class="td-known-h">Just so you know · nothing to do</h3>' + known.map(rowHtml).join('') + '</div>' : '')
      + '</section>';
  }

  window.PinToday = {
    setSpan: function (next) {
      span = next === 'week' || next === 'month' ? next : 'day';
      try { localStorage.setItem('pinTodaySpan', span); } catch (e) { /* remembered only for this visit */ }
      window.renderTodayView();
    },
    setSort: function (key, how) {
      if (how === 'default') delete sorts[key]; else sorts[key] = how;
      try { localStorage.setItem('pinTodaySort', JSON.stringify(sorts)); } catch (e) { /* remembered only for this visit */ }
      window.renderTodayView();
    },
    answer: function (id, response, reason) {
      if (typeof window.answerMeeting !== 'function') return;
      window.answerMeeting(id, response, reason);
    },
    decline: function (id) {
      var why = prompt('Why can' + '\u2019' + 't you make it? Everyone invited sees this.', '');
      if (why === null) return;
      if (typeof window.answerMeeting === 'function') window.answerMeeting(id, 'declined', String(why).trim().slice(0, 300));
    },
    openCampaign: function (id) {
      if (typeof openCampaignFromLead === 'function') openCampaignFromLead(id);
    },
    openMeeting: function (id) {
      if (typeof toggleView === 'function') toggleView('calendar');
      setTimeout(function () { if (window.PinCalendar) window.PinCalendar.openEvent(id); }, 350);
    }
  };

  window.renderTodayView = function () {
    var host = document.getElementById('todayView');
    if (!host) return;
    loadOpens();
    // A row you opened is a row you looked at. The click on its heading, not the `toggle` event: a
    // meeting waiting for your answer is drawn already open, and that fires `toggle` with nobody there.
    // Enter and Space on the heading arrive as a click too.
    if (!host.dataset.opensWired) {
      host.dataset.opensWired = '1';
      host.addEventListener('click', function (e) {
        var s = e.target && e.target.closest ? e.target.closest('summary') : null;
        var d = s && s.parentElement;
        if (d && !d.open && d.dataset.openKey) recordOpen(d.dataset.openKey);
      });
    }

    var visits = visitsToday();
    var meetings = meetingsToday().map(function (m) { return { kind: 'meeting', meeting: m, at: m.at, lead: null }; });
    var calls = callsDue();
    var asks = askedOfMe();
    var replies = campaignsInUse() ? campaignReplies(false) : null;
    var repliesKnown = replies ? campaignReplies(true) : [];
    // Tasks assigned to you (crm-assets/tasks.js): late ones, the ones due in this span, undated ones.
    var mytasks = window.PinTasks ? window.PinTasks.todayItems(endOfSpan()) : [];
    var lateTasks = mytasks.filter(function (t) { return t.overdue; }).length;
    if (window.crmFirebase && window.crmFirebase.watchTrackTasks) window.crmFirebase.watchTrackTasks();
    var vos = voiceOvers();
    var total = visits.length + meetings.length + calls.length + asks.length + mytasks.length + (voIsMe() ? vos.length : 0) + (replies ? replies.length : 0);

    var me = person(currentUserEmail);
    var late = calls.filter(function (c) { return c.overdue; }).length;

    // The subtitle is the day in one sentence. "You are clear" is worth saying
    // plainly; so is "two of these are already late".
    var summary;
    if (!total) summary = span === 'day' ? 'Nothing booked and nothing owed. A good day to work the board.' : 'Nothing booked and nothing owed ' + spanWord() + '.';
    else {
      var bits = [];
      if (visits.length) bits.push(visits.length + (visits.length === 1 ? ' visit' : ' visits'));
      if (meetings.length) bits.push(meetings.length + (meetings.length === 1 ? ' meeting' : ' meetings'));
      if (calls.length) bits.push(calls.length + (calls.length === 1 ? ' call' : ' calls') + (late ? ' (' + late + ' late)' : ''));
      if (replies && replies.length) bits.push(replies.length + (replies.length === 1 ? ' campaign reply' : ' campaign replies'));
      if (mytasks.length) bits.push(mytasks.length + (mytasks.length === 1 ? ' task' : ' tasks') + (lateTasks ? ' (' + lateTasks + ' late)' : ''));
      if (asks.length) bits.push(asks.length + (asks.length === 1 ? ' thing asked of you' : ' things asked of you'));
      if (vos.length && voIsMe()) bits.push(vos.length + (vos.length === 1 ? ' voice-over' : ' voice-overs') + ' to make');
      summary = bits.join(' · ');
    }

    host.innerHTML =
      '<div class="td-wrap">'
      + '<header class="td-head">'
      + '<div class="td-eyebrow">' + esc(dayName(Date.now())) + '</div>'
      + '<h1 class="td-title">' + (me ? 'Your day, ' + esc(me) : 'Your day') + '</h1>'
      + '<p class="td-sub">' + esc(summary) + '</p>'
      + '<div class="td-spans" role="group" aria-label="How far ahead to look">' + SPANS.map(function (o) {
          return '<button type="button" class="td-span' + (span === o[0] ? ' on' : '') + '" aria-pressed="' + (span === o[0]) + '"'
            + ' onclick="PinToday.setSpan(\'' + o[0] + '\')">' + o[1] + '</button>';
        }).join('') + '</div>'
      + '</header>'
      + sectionHtml('visits', 'Site visits', 'Booked ' + spanWord() + '. Open one for both numbers before you leave.',
        visits, 'No visits booked ' + spanWord() + '.')
      + sectionHtml('meetings', 'Meetings', 'With the team. Open one to answer it or to join the call.',
        meetings, 'No meetings ' + spanWord() + '.')
      + sectionHtml('calls', 'Calls due', 'Follow-ups due ' + (span === 'day' ? 'by the end of today' : 'by the end of ' + spanWord().replace('this ', 'the ')) + ', including any you missed.',
        calls, 'Nothing due ' + spanWord() + '.')
      + (replies ? sectionHtml('replies', 'Replied to campaigns', 'Answers to a WhatsApp campaign that nobody has acted on yet. Call or log it and it leaves this list.',
        replies, 'No replies waiting.', repliesKnown) : '')
      + sectionHtml('tasks', 'Tasks for you', 'Assigned to you on the Tasks page: the late ones, the ones due ' + spanWord() + ', and any with no date. Change the status right here.',
        mytasks, 'No task assigned to you is due ' + spanWord() + '.')
      + sectionHtml('asks', 'Asked of you', 'Where a colleague put your name in a note on a lead.',
        asks, 'Nobody is waiting on you.')
      // Shoot & Media: shown to the voice-over person always, to everyone else while there are some.
      + (vos.length || voIsMe() ? sectionHtml('vos', 'Voice-overs to make', 'Asked for by the editor once the rough cut is ready'
          + (vo.by ? ' — ' + vo.by + '\u2019s to make' : '') + '. Oldest ask first.', vos, 'No voice-over asked for.') : '')
      + '</div>';
  };
})();
