// ═══════ META ADS LEADS — the sheets Meta writes ad leads into, read and understood ═══════
//
// Its own section of the app rail, drawn inside the CRM page because the CRM's leads are already
// loaded and kept live here: whether an ad lead is already a CRM lead (and what it is doing) costs
// no extra reads. Four screens:
//
//   Leads       every person who enquired through a connected sheet, per property: their
//               enquiries, what the team wrote in the sheet, their CRM summary if they are already
//               a lead, and what a sync WOULD do with them
//   Duplicates  people who enquired more than once — each enquiry with its date and time, the
//               sheet and tab, the ad
//   Analysis    per property: per day, per ad, per form, per answer, ratings, assigned, contacted
//   Setup       which sheet (and which tabs) belongs to which property, what each column means,
//               and when the sheets were last read                                   [managers]
//
// TEST MODE: this screen reads and shows; it adds no lead, note or cell. The rules are
// crm-assets/metaLeadsModel.js (window.metaLeadsModel); the server is api/_meta-leads.js.

(function () {
  'use strict';

  var MM = function () { return window.metaLeadsModel; };
  var esc = function (s) { return typeof escapeHtml === 'function' ? escapeHtml(s == null ? '' : String(s)) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var js = function (v) { return esc(JSON.stringify(v == null ? '' : v)); };
  var toast = function (m) { if (typeof showToast === 'function') showToast(m); };
  var TABS = [['meta-leads', 'Leads', 'fa-solid fa-users'], ['ml-dupes', 'Duplicates', 'fa-regular fa-clone'], ['ml-analysis', 'Analysis', 'fa-solid fa-chart-column'], ['ml-setup', 'Setup', 'fa-solid fa-sliders']];
  var PAGE = 60;

  // The sheets found in the Drive on 7 Nov 2026 and the properties they were said to belong to —
  // offered in Setup while nothing is connected, so the first setup is one click (each is still
  // checked against Google, and nothing is kept until Save).
  // First live setup (7 Nov 2026): only the Koyambedu sheet. The Kodambakkam sheets (KDBMC001:
  // 17kaZCqDhOszTBwBkj8qEGHHsy7E1TBRjAYAWOO2aMk0 and 19SD6zrkLD84KHCMQ6ZAVA3D2OHJqFExkEThXIfA1BcY)
  // are connected later with "Connect a sheet".
  var SUGGESTED = [
    { link: '19N-RVhJUQ-HNeEvZK0nG_5aSWW78gpA8mHfbObXpbfk', title: 'Koyambedu - Leads', propertyCode: 'SHR0001' }
  ];

  var S = {
    view: 'meta-leads',
    cfg: null, cfgError: null, cfgLoading: false,
    read: null, readError: null, reading: false,
    plan: null, planAt: 0,
    prop: 'all', filter: 'all', q: '', open: null, shown: PAGE,
    draft: null, saving: false,
    add: { link: '', code: '', busy: false, error: null, share: false, prefilled: false },
    colsFor: null, detailsFor: null,
    busy: {}
  };

  // ─── server ────────────────────────────────────────────────────────────
  async function idToken() {
    for (var i = 0; i < 40; i++) {
      var tok = window.crmAuth && window.crmAuth.getIdToken ? await window.crmAuth.getIdToken().catch(function () { return null; }) : null;
      if (tok) return tok;
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    return null;
  }
  async function api(action, body) {
    var tok = await idToken();
    if (!tok) throw new Error('Please log in again');
    var res;
    try {
      res = await fetch('/api/meta-leads', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(Object.assign({ action: action }, body || {})) });
    } catch (e) { throw new Error('No connection — check the internet and try again'); }
    var raw = await res.text().catch(function () { return ''; });
    var data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    if (!data || typeof data !== 'object') throw new Error(res.status === 504 ? 'The sheets took too long to read — try again' : 'The server sent back something unexpected (' + res.status + ')');
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || 'Request failed (' + res.status + ')'), { data: data, status: res.status });
    return data;
  }

  // ─── CRM data on this page ─────────────────────────────────────────────
  function crmLeads() { return (typeof leads !== 'undefined' && Array.isArray(leads)) ? leads : []; }
  function crmStages() { return (typeof stages !== 'undefined' && Array.isArray(stages)) ? stages : []; }
  function roster() { try { return typeof teamRoster === 'function' ? teamRoster() : []; } catch (e) { return []; } }
  function inv() { return (typeof inventory !== 'undefined' && Array.isArray(inventory)) ? inventory : []; }
  function propName(code) {
    var c = String(code || '').toUpperCase();
    var p = inv().find(function (x) { return String(x.propertyCode || x.id || '').toUpperCase() === c; });
    return p ? (p.name || '') : '';
  }
  function agentLabel(email) { return email ? ((window.crmMentions && window.crmMentions.displayName(email)) || email) : ''; }

  // ─── loading ───────────────────────────────────────────────────────────
  function loadConfig(force) {
    if (S.cfgLoading || (S.cfg && !force)) return;
    S.cfgLoading = true; S.cfgError = null;
    api('config').then(function (d) {
      S.cfg = d; S.draft = JSON.parse(JSON.stringify(d.sources || []));
    }).catch(function (e) { S.cfgError = e.message; })
      .then(function () { S.cfgLoading = false; render(); });
  }
  function readSheets() {
    if (S.reading) return;
    S.reading = true; S.readError = null; render();
    api('read').then(function (d) {
      S.read = d; S.open = null; S.shown = PAGE;
      replan();
      if (S.cfg) S.cfg.lastRead = { at: d.at, by: (window.crmAuth && window.crmAuth.email) || '', sheets: [] };
      loadConfig(true);
      toast(d.errors && d.errors.length ? 'Read, with ' + d.errors.length + ' sheet problem' + (d.errors.length > 1 ? 's' : '') : 'Sheets read — nothing was added to the CRM');
    }).catch(function (e) { S.readError = e.message; })
      .then(function () { S.reading = false; render(); });
  }
  // The plan is redrawn from the rows already read whenever the CRM's leads change underneath.
  function replan() {
    if (!S.read || !MM()) { S.plan = null; return; }
    var props = {};
    (S.read.tabs || []).forEach(function (t) { if (t.propertyCode) props[t.propertyCode] = propName(t.propertyCode); });
    S.plan = MM().buildPlan({ tabs: S.read.tabs || [], crmLeads: crmLeads(), roster: roster(), properties: props, stages: crmStages() });
    S.planAt = Date.now();
    if (S.prop !== 'all' && !S.plan.properties.some(function (p) { return p.code === S.prop; })) S.prop = 'all';
  }

  // ─── shell ─────────────────────────────────────────────────────────────
  function el() { return document.getElementById('metaLeadsView'); }
  function render() {
    var root = el();
    if (!root || root.style.display === 'none') return;
    if (!MM()) { root.innerHTML = '<div class="ml-wrap"><div class="ml-empty">Loading…</div></div>'; setTimeout(render, 200); return; }
    var body = S.view === 'ml-setup' ? setupHtml() : S.view === 'ml-dupes' ? dupesHtml() : S.view === 'ml-analysis' ? analysisHtml() : leadsHtml();
    root.innerHTML = '<div class="ml-wrap">' + headHtml() + body + '</div>';
    if (S.view === 'ml-setup') attachPickers();
  }
  function headHtml() {
    var tabs = TABS.map(function (t) {
      return '<button class="ml-tab' + (S.view === t[0] ? ' on' : '') + '" onclick="MetaLeads.go(' + js(t[0]) + ')"><i class="' + t[2] + '"></i> ' + t[1] + '</button>';
    }).join('');
    var last = S.read ? 'Read ' + timeAgoSafe(S.read.at) : (S.cfg && S.cfg.lastRead ? 'Last read ' + timeAgoSafe(S.cfg.lastRead.at) : 'Not read yet');
    return '<div class="ml-head"><div><h2 class="ml-title"><i class="fa-brands fa-meta"></i> Meta Ads Leads</h2>' +
      '<div class="ml-sub">Leads from the Google Sheets your Meta ads fill, matched to properties and the CRM</div></div>' +
      '<div class="ml-head-r"><span class="ml-last">' + esc(last) + '</span>' +
      '<button class="ml-btn primary" ' + (S.reading ? 'disabled' : '') + ' onclick="MetaLeads.read()"><i class="fa-solid fa-rotate' + (S.reading ? ' fa-spin' : '') + '"></i> ' + (S.reading ? 'Reading the sheets…' : 'Read the sheets') + '</button></div></div>' +
      '<div class="ml-test"><i class="fa-solid fa-flask"></i> <b>Test mode</b> — this reads the sheets and shows what a sync would do. Nothing is added to the CRM and nothing is written in the sheets.</div>' +
      '<div class="ml-tabs">' + tabs + '</div>' +
      (S.readError ? '<div class="ml-alert bad">' + esc(S.readError) + '</div>' : '') +
      (S.read && S.read.errors && S.read.errors.length ? '<div class="ml-alert bad">' + S.read.errors.map(function (e) { return '<div><b>' + esc(e.title) + '</b> — ' + esc(e.error) + '</div>'; }).join('') + '</div>' : '');
  }
  function timeAgoSafe(t) { return t ? (typeof timeAgo === 'function' ? timeAgo(t) : MM().fmtWhen(t)) : ''; }

  function propChips(withAll) {
    if (!S.plan) return '';
    var list = S.plan.properties;
    var chip = function (code, label, n) {
      return '<button class="ml-chip' + (S.prop === code ? ' on' : '') + '" onclick="MetaLeads.prop(' + js(code) + ')">' + label + (n != null ? ' <span class="ml-n">' + n + '</span>' : '') + '</button>';
    };
    return '<div class="ml-props">' + (withAll ? chip('all', 'All properties', S.plan.people.length) : '') +
      list.map(function (p) { return chip(p.code, '<b>' + esc(p.code) + '</b>' + (p.name ? ' · ' + esc(p.name) : ''), p.people); }).join('') + '</div>';
  }
  function needRead() {
    if (S.reading) return '<div class="ml-empty"><i class="fa-solid fa-rotate fa-spin"></i> Reading the sheets…</div>';
    if (S.cfg && !(S.cfg.sources || []).length) return '<div class="ml-empty">No sheet is connected yet. ' + (S.cfg.manager ? '<a href="#" onclick="MetaLeads.go(\'ml-setup\');return false">Open Setup</a> to connect the lead sheets.' : 'A manager connects them in Setup.') + '</div>';
    return '<div class="ml-empty">Press <b>Read the sheets</b> to read every connected sheet and see its leads. Nothing is added to the CRM.</div>';
  }

  // ─── Leads ─────────────────────────────────────────────────────────────
  var FILTERS = [['all', 'All'], ['priority', 'Priority for the agent'], ['create', 'New to the CRM'], ['crm', 'Already in the CRM'], ['repeat', 'Duplicates'], ['multi', 'More than one property'], ['uncontacted', 'Nothing written yet'], ['problems', 'Problems']];
  function peopleFor(code) {
    return S.plan.people.filter(function (p) { return code === 'all' || p.properties.indexOf(code) >= 0; });
  }
  function rowsFor(p, code) { return code === 'all' ? p.enquiries : p.enquiries.filter(function (e) { return e.propertyCode === code; }); }
  function passes(p) {
    var f = S.filter;
    if (f === 'create' && p.action !== 'create') return false;
    if (f === 'crm' && !p.crm) return false;
    if (f === 'repeat' && !(S.prop === 'all' ? p.duplicate : p.dupCodes.indexOf(S.prop) >= 0)) return false;
    if (f === 'multi' && !p.multiProperty) return false;
    if (f === 'priority' && !MM().isPriorityFor(p, S.prop === 'all' ? '' : S.prop)) return false;
    if (f === 'uncontacted' && p.team.contacted) return false;
    if (f === 'problems' && !p.issues.length) return false;
    var q = S.q.trim().toLowerCase();
    if (q) {
      var hay = [p.name, p.phone, p.email, p.team.assignedRaw, p.crm && p.crm.name].concat(p.team.notes.map(function (n) { return n.text; })).join(' ').toLowerCase();
      if (hay.indexOf(q) < 0 && String(p.phoneKey).indexOf(q.replace(/\D/g, '') || '§') < 0) return false;
    }
    return true;
  }
  function tiles(a, code) {
    var p = code === 'all' ? null : S.plan.properties.find(function (x) { return x.code === code; });
    var create = p ? p.create : S.plan.people.filter(function (x) { return x.action === 'create'; }).length;
    var attach = p ? p.attach : S.plan.people.filter(function (x) { return x.action === 'attach'; }).length;
    var t = function (n, label, cls, f) { return '<button class="ml-tile ' + (cls || '') + '"' + (f ? ' onclick="MetaLeads.filter(' + js(f) + ')"' : '') + '><div class="ml-tile-n">' + n + '</div><div class="ml-tile-l">' + label + '</div></button>'; };
    return '<div class="ml-tiles">' +
      t(a.enquiries, 'Enquiries (rows)') + t(a.people, 'People', '', 'all') + t(a.repeats, 'With duplicate rows (same property)', a.repeats ? 'warn' : '', 'repeat') + t(a.multiProperty, 'Enquired for more than one property', '', 'multi') +
      t(a.inCrm, 'Already in the CRM', '', 'crm') + t(create, 'Would be added as new leads', 'brand', 'create') +
      t(attach, 'In the CRM, would get this property', '', 'crm') + t(a.reopen, 'Closed in the CRM, would reopen', a.reopen ? 'bad' : '', 'priority') +
      t(a.priority, 'Revisited — priority for the agent', a.priority ? 'warn' : '', 'priority') + t(a.problems, 'Problems (imported, flagged)', a.problems ? 'bad' : '', 'problems') + '</div>';
  }
  function leadsHtml() {
    if (!S.plan) return needRead();
    var a = MM().analyse(S.plan, S.prop === 'all' ? '' : S.prop);
    var list = peopleFor(S.prop).filter(passes);
    var chips = FILTERS.map(function (f) { return '<button class="ml-chip sm' + (S.filter === f[0] ? ' on' : '') + '" onclick="MetaLeads.filter(' + js(f[0]) + ')">' + f[1] + '</button>'; }).join('');
    var rows = list.slice(0, S.shown).map(personHtml).join('');
    return propChips(true) + tiles(a, S.prop) +
      '<div class="ml-bar"><div class="ml-chips">' + chips + '</div><input class="ml-search" type="search" placeholder="Search name, phone, note…" value="' + esc(S.q) + '" oninput="MetaLeads.search(this.value)"></div>' +
      '<div class="ml-count">' + list.length + ' ' + (list.length === 1 ? 'person' : 'people') + '</div>' +
      (list.length ? '<div class="ml-list">' + rows + '</div>' : '<div class="ml-empty">Nobody matches.</div>') +
      (list.length > S.shown ? '<button class="ml-btn ml-more" onclick="MetaLeads.more()">Show more (' + (list.length - S.shown) + ' left)</button>' : '');
  }
  function actionBadge(p) {
    var b;
    if (p.action === 'create') b = '<span class="ml-badge brand" title="A sync would add this person as a new lead">Would add as new lead</span>';
    else if (p.action === 'attach') b = '<span class="ml-badge" title="Already a CRM lead; a sync would add ' + esc(p.missingCodes.join(', ')) + ' to their properties">In CRM · would add ' + esc(p.missingCodes.join(', ')) + '</span>';
    else if (p.action === 'reopen') b = '<span class="ml-badge bad" title="Their CRM lead is ' + esc(p.crm.stage) + '; a sync would reopen it, marked duplicate">Would reopen (was ' + esc(p.crm.stage) + ')</span>';
    else if (p.action === 'revisit') b = '<span class="ml-badge warn" title="Already a CRM lead for this property and enquired again through the ad">In CRM · enquired again</span>';
    else b = '<span class="ml-badge ok" title="Already a CRM lead for this property, nothing new">In CRM · already linked</span>';
    if (MM().isPriorityFor(p, S.prop === 'all' ? '' : S.prop)) b += ' <span class="ml-badge pri" title="Revisited (duplicate ad lead) — the agent should update this lead first"><i class="fa-solid fa-bolt"></i> Revisited · priority</span>';
    return b;
  }
  // What a sync would do with this person, in words.
  function wouldDo(p) {
    var name = esc(p.name || 'them'), codes = esc(p.properties.join(', '));
    var dup = p.revisited ? ' It would be marked <b>Revisited (duplicate ad lead)</b> and put first for its agent to update.' : '';
    if (p.action === 'create') return 'A sync would add ' + name + ' as a <b>new lead</b> for ' + codes + ', source Meta Ads, with every enquiry and what the sheet says.' + dup;
    if (p.action === 'attach') return 'A sync would add ' + esc(p.missingCodes.join(', ')) + ' to this lead and note each new enquiry — one person, one lead.' + dup;
    if (p.action === 'reopen') return 'This lead is <b>' + esc(p.crm.stage) + '</b>. A sync would <b>reopen</b> it, mark it duplicate, note the new enquiry, and keep the reopening in its history.' + dup;
    if (p.action === 'revisit') return 'A sync would add the new enquiry to this lead.' + dup;
    return 'Already a lead for ' + codes + ' — the ad row is where it came from. Nothing new to add.';
  }
  function ratingChip(r) { return r ? '<span class="ml-rate r' + r + '">' + esc(MM().RATING_LABEL[r]) + '</span>' : ''; }
  function personHtml(p) {
    var rows = rowsFor(p, S.prop);
    var open = S.open === p.key;
    var last = p.team.notes.length ? p.team.notes[p.team.notes.length - 1].text : '';
    var who = p.team.agent ? agentLabel(p.team.agent) : (p.team.assignedRaw ? p.team.assignedRaw + ' ?' : '');
    return '<div class="ml-person' + (open ? ' open' : '') + '">' +
      '<button class="ml-prow" onclick="MetaLeads.toggle(' + js(p.key) + ')">' +
        '<div class="ml-who"><div class="ml-name">' + esc(p.name || '(no name)') + (p.crm && p.crm.name && p.crm.name !== p.name ? ' <span class="ml-aka">CRM: ' + esc(p.crm.name) + '</span>' : '') + '</div>' +
        '<div class="ml-phone' + (p.phoneOk ? '' : ' bad') + '">' + esc(p.phone ? MM().displayPhone(p.phone) : 'no phone') + '</div></div>' +
        '<div class="ml-when"><div>' + esc(MM().fmtWhen(rows.length ? rows[rows.length - 1].at : p.lastAt)) + '</div>' +
        '<div class="ml-dim">' + (p.dupCodes.filter(function (c) { return S.prop === 'all' || c === S.prop; }).map(function (c) { return '<span class="ml-badge warn" title="More than one row for ' + esc(c) + '">Duplicate ×' + p.enquiries.filter(function (e) { return e.propertyCode === c; }).length + (S.prop === 'all' ? ' ' + esc(c) : '') + '</span>'; }).join(' ') || esc(rows[0] && rows[0].ad || '')) +
        (S.prop === 'all' || p.properties.length > 1 ? ' ' + p.properties.map(function (c) { return '<span class="ml-code">' + esc(c) + '</span>'; }).join(' ') : '') + '</div></div>' +
        '<div class="ml-team"><div>' + (who ? '<i class="fa-regular fa-user"></i> ' + esc(who) : '<span class="ml-dim">Not assigned</span>') + ' ' + ratingChip(p.team.rating) + '</div>' +
        '<div class="ml-dim ml-note">' + esc(last || '—') + '</div></div>' +
        '<div class="ml-act">' + actionBadge(p) + (p.crm ? '<div class="ml-dim">' + esc(p.crm.stage || '') + (p.crm.agent ? ' · ' + esc(agentLabel(p.crm.agent)) : '') + '</div>' : '') +
        (p.issues.length ? '<div class="ml-issue"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(p.issues.join(' · ')) + '</div>' : '') + '</div>' +
      '</button>' + (open ? detailHtml(p) : '') + '</div>';
  }
  function enquiryLine(e, prev) {
    var gap = prev && prev.at && e.at ? gapText(e.at - prev.at) : '';
    var link = e.where.spreadsheetId ? MM().sheetUrl(e.where.spreadsheetId, e.where.gid) : '';
    return '<div class="ml-enq">' +
      '<div class="ml-enq-t"><b>' + esc(MM().fmtWhen(e.at)) + '</b>' + (gap ? ' <span class="ml-gap">' + esc(gap) + ' later</span>' : '') + '</div>' +
      '<div class="ml-enq-d">' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(String(e.where.sheetTitle).trim() + ' › ' + e.where.tab) + ' · row ' + e.row + '</a>' : esc(e.where.tab)) +
      ' · <span class="ml-code">' + esc(e.propertyCode) + '</span> · ' + esc(e.ad || '—') + ' · ' + esc({ ig: 'Instagram', fb: 'Facebook' }[e.platform] || e.platform || '') +
      (e.form ? ' · form “' + esc(e.form) + '”' : '') + '</div>' +
      (e.answers.length ? '<div class="ml-ans">' + e.answers.map(function (x) { return '<span>' + esc(x.label) + ' <b>' + esc(x.value) + '</b></span>'; }).join('') + '</div>' : '') +
      (e.alsoIn && e.alsoIn.length ? '<div class="ml-dim">Also copied in ' + e.alsoIn.map(function (a) { return esc(a.tab); }).join(', ') + '</div>' : '') +
      '</div>';
  }
  function gapText(ms) {
    var h = ms / 3600000;
    if (h < 1) return Math.max(1, Math.round(ms / 60000)) + ' min';
    if (h < 48) return Math.round(h) + ' h';
    return Math.round(h / 24) + ' days';
  }
  function detailHtml(p) {
    var rows = p.enquiries;
    var crm = p.crm;
    var notes = p.team.notes.map(function (n) { return '<div class="ml-tn"><span class="ml-tn-l">' + esc(n.label) + '</span> ' + esc(n.text) + ' <span class="ml-dim">— ' + esc(String(n.where).trim()) + '</span></div>'; }).join('');
    return '<div class="ml-detail">' +
      '<div class="ml-col"><div class="ml-h">Enquiries (' + rows.length + ')</div>' + rows.map(function (e, i) { return enquiryLine(e, rows[i - 1]); }).join('') + '</div>' +
      '<div class="ml-col"><div class="ml-h">Written in the sheet</div>' +
        '<div class="ml-kv"><span>Assigned to</span><b>' + esc(p.team.assignedRaw || '—') + (p.team.assignedRaw ? (p.team.agent ? ' <span class="ml-dim">→ ' + esc(p.team.agent) + '</span>' : ' <span class="ml-bad">not on the team list</span>') : '') + '</b></div>' +
        '<div class="ml-kv"><span>Rating</span><b>' + (p.team.rating ? ratingChip(p.team.rating) + ' <span class="ml-dim">(' + esc(p.team.ratingRaw) + ')</span>' : esc(p.team.ratingRaw || '—')) + '</b></div>' +
        (notes || '<div class="ml-dim">Nothing written yet.</div>') +
        '<div class="ml-h" style="margin-top:14px">In the CRM</div>' +
        '<div class="ml-would">' + wouldDo(p) + '</div>' +
        (crm ? '<div class="ml-crm">' +
          '<div class="ml-kv"><span>Lead</span><b>' + esc(crm.name || '—') + '</b></div>' +
          '<div class="ml-kv"><span>Stage</span><b>' + esc(crm.stage || '—') + '</b></div>' +
          '<div class="ml-kv"><span>Agent</span><b>' + esc(agentLabel(crm.agent) || '—') + '</b></div>' +
          '<div class="ml-kv"><span>Properties</span><b>' + (crm.propertyCodes.length ? crm.propertyCodes.map(function (c) { return '<span class="ml-code">' + esc(c) + '</span>'; }).join(' ') : '—') + '</b></div>' +
          (crm.propertyInterest ? '<div class="ml-kv"><span>Looking for</span><b>' + esc(crm.propertyInterest) + '</b></div>' : '') +
          (crm.budget ? '<div class="ml-kv"><span>Budget</span><b>' + esc(crm.budget) + '</b></div>' : '') +
          '<div class="ml-kv"><span>In the CRM since</span><b>' + esc(crm.createdAt ? MM().fmtWhen(crm.createdAt) : '—') + '</b></div>' +
          (crm.followUpAt ? '<div class="ml-kv"><span>Follow-up</span><b>' + esc(MM().fmtWhen(crm.followUpAt)) + '</b></div>' : '') +
          (crm.lostReason ? '<div class="ml-kv"><span>Lost reason</span><b>' + esc(crm.lostReason) + '</b></div>' : '') +
          (crm.summary ? '<div class="ml-sum"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + esc(crm.summary) + '</div>' : '<div class="ml-dim">No AI summary yet.</div>') +
          '<button class="ml-btn" onclick="MetaLeads.openLead(' + js(crm.id) + ')"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open in the CRM</button></div>'
          : '<div class="ml-dim">Not a CRM lead yet.</div>') +
      '</div></div>';
  }

  // ─── Duplicates ────────────────────────────────────────────────────────
  function dupesHtml() {
    if (!S.plan) return needRead();
    var code = S.prop === 'all' ? '' : S.prop;
    var list = MM().duplicatesOf(S.plan, code);
    var body = list.map(function (p) {
      var rows = p.rows;
      return '<div class="ml-dupe"><div class="ml-dupe-h"><div><b>' + esc(p.name || '(no name)') + '</b> <span class="ml-dim">' + esc(p.phone ? MM().displayPhone(p.phone) : p.email) + '</span> <span class="ml-code">' + esc(p.code) + '</span>' +
        (p.otherCodes.length ? ' <span class="ml-dim" title="A separate enquiry, not a duplicate">· also enquired for ' + p.otherCodes.map(esc).join(', ') + '</span>' : '') + '</div>' +
        '<div>' + '<span class="ml-badge warn">' + rows.length + ' rows for ' + esc(p.code) + '</span> ' +
        (rows.length > 1 && rows[0].at && rows[rows.length - 1].at ? '<span class="ml-dim">over ' + esc(gapText(rows[rows.length - 1].at - rows[0].at)) + '</span> ' : '') +
        (p.crm ? '<span class="ml-badge ok">In CRM · ' + esc(p.crm.stage) + '</span>' : '<span class="ml-badge brand">Not in CRM</span>') + '</div></div>' +
        rows.map(function (e, i) { return enquiryLine(e, rows[i - 1]); }).join('') +
        '<button class="ml-link" onclick="MetaLeads.go(\'meta-leads\');MetaLeads.toggle(' + js(p.key) + ', true)">See the person →</button></div>';
    }).join('');
    return propChips(true) +
      '<div class="ml-explain">A <b>duplicate</b> is the same phone number (or email) in another row <b>for the same property</b> — each row below with its date and time, sheet, tab and ad. The same person enquiring for a different property is a separate enquiry, not a duplicate (shown as “also enquired for”).</div>' +
      (list.length ? '<div class="ml-count">' + list.length + ' ' + (list.length === 1 ? 'person' : 'people') + '</div>' + body : '<div class="ml-empty">No one has enquired twice' + (code ? ' for ' + esc(code) : '') + '.</div>');
  }

  // ─── Analysis ──────────────────────────────────────────────────────────
  function bars(list, total, max) {
    total = total || list.reduce(function (s, x) { return s + x.n; }, 0) || 1;
    var top = Math.max.apply(null, list.map(function (x) { return x.n; }).concat([1]));
    return '<div class="ml-bars">' + list.slice(0, max || 12).map(function (x) {
      return '<div class="ml-b"><div class="ml-b-l" title="' + esc(x.label) + '">' + esc(x.label) + '</div><div class="ml-b-t"><div class="ml-b-f" style="width:' + Math.round(100 * x.n / top) + '%"></div></div><div class="ml-b-n">' + x.n + ' <span class="ml-dim">' + Math.round(100 * x.n / total) + '%</span></div></div>';
    }).join('') + '</div>';
  }
  function analysisHtml() {
    if (!S.plan) return needRead();
    var code = S.prop === 'all' ? '' : S.prop;
    var a = MM().analyse(S.plan, code);
    var max = Math.max.apply(null, a.series.map(function (x) { return x.n; }).concat([1]));
    var series = '<div class="ml-series">' + a.series.map(function (x) {
      return '<div class="ml-s" title="' + esc(x.label + ': ' + x.n) + '"><div class="ml-s-b" style="height:' + Math.round(100 * x.n / max) + '%"></div><div class="ml-s-l">' + (x.n ? x.n : '') + '</div></div>';
    }).join('') + '</div><div class="ml-s-axis"><span>' + esc(a.series.length ? a.series[0].label : '') + '</span><span>' + esc(a.series.length ? a.series[a.series.length - 1].label : '') + '</span></div>';
    var rate = [{ label: 'Hot (3)', n: a.ratings[3] }, { label: 'Warm (2)', n: a.ratings[2] }, { label: 'Cold (1)', n: a.ratings[1] }, { label: 'Not rated', n: a.ratings.none }];
    var pct = function (n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; };
    var card = function (h, inner) { return '<div class="ml-card"><div class="ml-h">' + h + '</div>' + inner + '</div>'; };
    return propChips(true) +
      '<div class="ml-tiles">' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.enquiries + '</div><div class="ml-tile-l">Enquiries</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.people + '</div><div class="ml-tile-l">People</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.last7 + '</div><div class="ml-tile-l">Enquiries, last 7 days</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + pct(a.contacted, a.people) + '</div><div class="ml-tile-l">Have something written (' + a.contacted + ')</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + pct(a.assigned, a.people) + '</div><div class="ml-tile-l">Assigned (' + a.assigned + ')</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.repeats + '</div><div class="ml-tile-l">With duplicate rows</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.inCrm + '</div><div class="ml-tile-l">Already in the CRM</div></div>' +
      '</div>' +
      card('Enquiries per day' + (a.series.length ? ' <span class="ml-dim">(' + a.series.length + ' days, India time)</span>' : ''), a.series.length ? series : '<div class="ml-dim">No dates.</div>') +
      '<div class="ml-grid">' +
        card('By ad', bars(a.byAd, a.enquiries)) +
        card('By sheet and tab', bars(a.byForm, a.enquiries)) +
        card('By platform', bars(a.byPlatform, a.enquiries)) +
        card('Rating (latest in the sheet)', bars(rate, a.people)) +
        card('Assigned to (in the sheet)', bars(a.byAgent.map(function (x) { return { label: x.label.indexOf('@') > 0 ? agentLabel(x.label) : x.label, n: x.n }; }), a.people)) +
        card('Already in the CRM — their stage', a.byStage.length ? bars(a.byStage, a.inCrm) : '<div class="ml-dim">None of them is a CRM lead yet.</div>') +
        a.questions.map(function (q) { return card('Form: ' + esc(q.label), bars(q.answers)); }).join('') +
      '</div>';
  }

  // ─── Setup ─────────────────────────────────────────────────────────────
  // One line per sheet: the sheet's link → the property its leads are for. Every change is saved at
  // once (no separate Save); the tabs and what each column means are under "Details".
  function invByCode(code) {
    var c = String(code || '').toUpperCase();
    return inv().find(function (x) { return String(x.propertyCode || x.id || '').toUpperCase() === c; }) || null;
  }
  function propertySelect(cls, code, attrs) {
    var list = inv().slice().sort(function (x, y) { return String(x.propertyCode || x.id).localeCompare(String(y.propertyCode || y.id)); });
    var has = !code || list.some(function (x) { return String(x.propertyCode || x.id).toUpperCase() === String(code).toUpperCase(); });
    var opts = '<option value="">Pick the property…</option>' +
      (has ? '' : '<option value="' + esc(code) + '" selected>' + esc(code) + '</option>') +
      list.map(function (x) {
        var c = String(x.propertyCode || x.id);
        return '<option value="' + esc(c) + '"' + (String(code).toUpperCase() === c.toUpperCase() ? ' selected' : '') + '>' + esc(c + (x.name ? ' — ' + x.name : '')) + '</option>';
      }).join('');
    return '<select class="ml-psel ' + cls + '" ' + attrs + '>' + opts + '</select>';
  }
  function sourceStatus(s) {
    if (s.on === false) return '<span class="ml-badge">Off</span>';
    var lr = S.cfg.lastRead && (S.cfg.lastRead.sheets || []).find(function (x) { return x.id === s.id; });
    if (!lr) return '<span class="ml-dim">Not read yet</span>';
    if (!lr.ok) return '<span class="ml-badge bad" title="' + esc(lr.error) + '">' + (/share it/.test(lr.error || '') ? 'Not shared with the app' : 'Cannot read') + '</span>';
    var n = (lr.rows || []).reduce(function (t, r) { return t + (r.rows || 0); }, 0);
    return '<span class="ml-badge ok">' + n + ' lead' + (n === 1 ? '' : 's') + '</span>';
  }
  function setupHtml() {
    if (S.cfgError) return '<div class="ml-alert bad">' + esc(S.cfgError) + ' <button class="ml-btn" onclick="MetaLeads.reload()">Try again</button></div>';
    if (!S.cfg) return '<div class="ml-empty"><i class="fa-solid fa-rotate fa-spin"></i> Loading the setup…</div>';
    var mgr = !!S.cfg.manager, list = S.draft || [];
    // The first time, the Koyambedu sheet is filled in, ready to connect.
    if (mgr && !list.length && !S.add.prefilled && SUGGESTED.length) { S.add.prefilled = true; S.add.link = MM().sheetUrl(SUGGESTED[0].link); S.add.code = SUGGESTED[0].propertyCode; }
    var rows = list.map(function (s, i) { return sourceRow(s, i, mgr); }).join('');
    var lr = S.cfg.lastRead;
    return '<div class="ml-card ml-map">' +
        '<div class="ml-map-h"><div><div class="ml-h2">Lead sheets → properties</div><div class="ml-dim">Paste the Google Sheet an ad fills, pick the property it is for. Each sheet’s leads count for that property.</div></div></div>' +
        (mgr ? addRow() : '<div class="ml-alert">Only a manager can change this list. You can read the sheets and work the leads.</div>') +
        (list.length ? '<div class="ml-maplist"><div class="ml-mapth"><span>Lead sheet</span><span></span><span>Property</span><span>Leads</span><span></span></div>' + rows + '</div>'
          : '<div class="ml-empty sm">No sheet connected yet.</div>') +
      '</div>' +
      '<div class="ml-foot"><i class="fa-solid fa-circle-info"></i> A sheet must be shared with <code>' + esc(S.cfg.shareWith) + '</code> as Editor <button class="ml-link" onclick="MetaLeads.copy(' + js(S.cfg.shareWith) + ')">Copy</button>' +
        (lr ? ' · Last read ' + esc(MM().fmtWhen(lr.at)) + (lr.by ? ' by ' + esc(lr.by) : '') : '') + '</div>';
  }
  function addRow() {
    var A = S.add;
    var err = A.error ? '<div class="ml-alert bad">' + esc(A.error) +
      (A.share ? '<div class="ml-sa"><code>' + esc(S.cfg.shareWith) + '</code> <button class="ml-btn sm" onclick="MetaLeads.copy(' + js(S.cfg.shareWith) + ')"><i class="fa-regular fa-copy"></i> Copy</button></div><div class="ml-dim">In the sheet: Share → paste this address → Editor → Send. Then press Connect again.</div>' : '') + '</div>' : '';
    return '<div class="ml-addline">' +
        '<input class="ml-in ml-link-in" placeholder="Paste the Google Sheets link" value="' + esc(A.link) + '" oninput="MetaLeads.addLink(this.value)">' +
        '<span class="ml-arrow"><i class="fa-solid fa-arrow-right"></i></span>' +
        '<div class="ml-pick">' + propertySelect('ml-add-prop', A.code, 'onchange="MetaLeads.addCode(this.value)"') + '</div>' +
        '<button class="ml-btn primary" ' + (A.busy ? 'disabled' : '') + ' onclick="MetaLeads.addSheet()">' + (A.busy ? '<i class="fa-solid fa-rotate fa-spin"></i> Checking…' : '<i class="fa-solid fa-plus"></i> Connect') + '</button>' +
      '</div>' + err;
  }
  function sourceRow(s, i, mgr) {
    var open = S.detailsFor === s.id;
    var tabsOn = (s.tabs || []).filter(function (t) { return t.on !== false; }).length;
    return '<div class="ml-maprow' + (s.on === false ? ' off' : '') + (open ? ' open' : '') + '">' +
        '<div class="ml-c-sheet"><a href="' + esc(MM().sheetUrl(s.spreadsheetId)) + '" target="_blank" rel="noopener">' + esc(String(s.title || s.spreadsheetId).trim()) + ' <i class="fa-solid fa-arrow-up-right-from-square"></i></a>' +
          '<div class="ml-dim">' + tabsOn + ' of ' + (s.tabs || []).length + ' tab' + ((s.tabs || []).length === 1 ? '' : 's') + '</div></div>' +
        '<span class="ml-arrow"><i class="fa-solid fa-arrow-right"></i></span>' +
        '<div class="ml-c-prop">' + (mgr ? propertySelect('ml-row-prop', s.propertyCode, 'onchange="MetaLeads.setProp(' + i + ',this.value)"')
          : '<span class="ml-code">' + esc(s.propertyCode) + '</span> ' + esc(propName(s.propertyCode) || s.propertyName)) + '</div>' +
        '<div class="ml-c-status">' + sourceStatus(s) + '</div>' +
        '<div class="ml-c-act">' +
          (mgr ? '<label class="ml-sw" title="Read this sheet or not"><input type="checkbox" ' + (s.on !== false ? 'checked' : '') + ' onchange="MetaLeads.srcOn(' + i + ',this.checked)"> On</label>' : '') +
          '<button class="ml-link" onclick="MetaLeads.details(' + js(s.id) + ')">' + (open ? 'Hide' : 'Details') + '</button>' +
          (mgr ? '<button class="ml-icon" title="Disconnect this sheet" onclick="MetaLeads.remove(' + i + ')"><i class="fa-regular fa-trash-can"></i></button>' : '') +
        '</div>' +
        (open ? detailsHtml(s, i, mgr) : '') +
      '</div>';
  }
  function detailsHtml(s, i, mgr) {
    var lr = S.cfg.lastRead && (S.cfg.lastRead.sheets || []).find(function (x) { return x.id === s.id; });
    var planTabs = S.plan ? S.plan.tabs.filter(function (t) { return t.spreadsheetId === s.spreadsheetId; }) : [];
    var tabs = (s.tabs || []).map(function (t, j) {
      var r = lr && (lr.rows || []).find(function (x) { return x.gid === t.gid; });
      var pt = planTabs.find(function (x) { return x.gid === t.gid; });
      var open = S.colsFor === s.id + ':' + t.gid;
      return '<div class="ml-tabrow"><label><input type="checkbox" ' + (t.on !== false ? 'checked' : '') + (mgr ? '' : ' disabled') + ' onchange="MetaLeads.tabOn(' + i + ',' + j + ',this.checked)"> <b>' + esc(t.title) + '</b></label>' +
        '<span class="ml-dim">' + (r ? r.rows + ' rows at the last read' : '') + '</span>' +
        (pt ? ' <button class="ml-link" onclick="MetaLeads.cols(' + js(s.id + ':' + t.gid) + ')">' + (open ? 'Hide columns' : 'Columns') + (pt.issues.length ? ' <span class="ml-bad">· ' + pt.issues.length + ' to check</span>' : '') + '</button>' : '') +
        (open && pt ? colsHtml(pt, i, j, mgr) : '') + '</div>';
    }).join('');
    return '<div class="ml-details">' + (lr && !lr.ok ? '<div class="ml-alert bad">' + esc(lr.error) + '</div>' : '') +
      '<div class="ml-dim">Tabs read from this sheet' + (S.plan ? '' : ' — read the sheets to see each tab’s columns') + ':</div>' + tabs + '</div>';
  }
  function colsHtml(pt, i, j, mgr) {
    var opts = function (c) {
      return Object.keys(MM().ROLES).filter(function (r) { return r !== 'meta'; }).map(function (r) { return '<option value="' + r + '"' + (c.role === r ? ' selected' : '') + '>' + esc(MM().ROLES[r]) + '</option>'; }).join('');
    };
    return '<div class="ml-cols">' + (pt.issues.length ? pt.issues.map(function (x) { return '<div class="ml-issue"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(x) + '</div>'; }).join('') : '') +
      '<table class="ml-ct"><thead><tr><th>Col</th><th>Header</th><th>Read as</th><th>Example</th></tr></thead><tbody>' +
      pt.cols.filter(function (c) { return c.role !== 'ignore' || c.header; }).map(function (c) {
        return '<tr' + (c.header ? '' : ' class="nohead"') + '><td>' + MM().colLetter(c.index) + '</td><td>' + esc(c.header || '(no header)') + '</td><td>' +
          (c.role === 'meta' ? '<span class="ml-dim">Meta · ' + esc(c.field) + '</span>' : (mgr ? '<select onchange="MetaLeads.role(' + i + ',' + j + ',' + c.index + ',this.value)">' + opts(c) + '</select>' : esc(MM().ROLES[c.role]))) +
          '</td><td class="ml-dim">' + esc((c.sample || []).slice(0, 2).join(' · ')) + '</td></tr>';
      }).join('') + '</tbody></table>' + (mgr ? '<div class="ml-dim">Saved at once; used from the next read.</div>' : '') + '</div>';
  }
  // The searchable picker (shared-assets/property-picker.js) over every property select drawn.
  function attachPickers() {
    if (!window.PinPropertyPicker) return;
    document.querySelectorAll('#metaLeadsView select.ml-psel').forEach(function (sel) {
      window.PinPropertyPicker.attach(sel, { lookup: function (v) { return v ? invByCode(v) : null; }, placeholder: 'Type a code or name, or pick…' });
    });
  }
  // Every Setup change is saved at once; on failure the screen goes back to what is saved.
  function persist(next, done) {
    if (S.saving) return;
    S.saving = true;
    api('save', { sources: next }).then(function (d) {
      S.cfg.sources = d.sources; S.draft = JSON.parse(JSON.stringify(d.sources));
      if (done) done();
    }).catch(function (e) {
      toast(e.message); S.draft = JSON.parse(JSON.stringify(S.cfg.sources || []));
    }).then(function () { S.saving = false; render(); });
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function inspectLink(link) { return api('inspect', { link: link }); }
  // A checked sheet → its setup line: every tab that is a Meta lead export, read.
  function fromInspect(r, code) {
    return { spreadsheetId: r.spreadsheetId, title: r.title, propertyCode: code, propertyName: propName(code), on: true,
      tabs: r.tabs.filter(function (t) { return t.looksMeta; }).map(function (t) { return { gid: t.gid, title: t.title, on: true, overrides: {} }; }) };
  }

  // ─── actions ───────────────────────────────────────────────────────────
  window.MetaLeads = {
    go: function (v) { if (typeof toggleView === 'function') toggleView(v); },
    read: readSheets,
    reload: function () { loadConfig(true); },
    prop: function (c) { S.prop = c; S.open = null; S.shown = PAGE; render(); },
    filter: function (f) { S.filter = f; S.shown = PAGE; if (S.view !== 'meta-leads') { MetaLeads.go('meta-leads'); return; } render(); },
    search: function (q) {
      S.q = q; S.shown = PAGE;
      clearTimeout(S.qt); S.qt = setTimeout(function () {
        var box = document.querySelector('#metaLeadsView .ml-search'); var pos = box && box.selectionStart;
        render();
        var b2 = document.querySelector('#metaLeadsView .ml-search'); if (b2) { b2.focus(); try { b2.setSelectionRange(pos, pos); } catch (e) {} }
      }, 180);
    },
    more: function () { S.shown += PAGE; render(); },
    toggle: function (k, force) { S.open = force ? k : (S.open === k ? null : k); if (force) { S.filter = 'all'; S.q = ''; var p = S.plan && S.plan.people.find(function (x) { return x.key === k; }); if (p && S.prop !== 'all' && p.properties.indexOf(S.prop) < 0) S.prop = 'all'; var i = S.plan ? S.plan.people.filter(function (x) { return S.prop === 'all' || x.properties.indexOf(S.prop) >= 0; }).findIndex(function (x) { return x.key === k; }) : -1; if (i >= S.shown) S.shown = i + 1; } render(); if (force) setTimeout(function () { var o = document.querySelector('#metaLeadsView .ml-person.open'); if (o) o.scrollIntoView({ block: 'start' }); }, 30); },
    openLead: function (id) { if (typeof openDetail === 'function') openDetail(id); },
    copy: function (t) { try { navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { toast(t); } },
    cols: function (k) { S.colsFor = S.colsFor === k ? null : k; render(); },
    details: function (id) { S.detailsFor = S.detailsFor === id ? null : id; render(); },
    tabOn: function (i, j, on) { var n = clone(S.draft); n[i].tabs[j].on = on; persist(n, function () { toast('Saved'); }); },
    srcOn: function (i, on) { var n = clone(S.draft); n[i].on = on; persist(n, function () { toast(on ? 'On — read with the others' : 'Off — not read'); }); },
    remove: function (i) {
      var t = String(S.draft[i].title).trim();
      if (!confirm('Disconnect “' + t + '”? Its leads stay in the sheet; it is just not read any more.')) return;
      var n = clone(S.draft); n.splice(i, 1); persist(n, function () { toast('Disconnected'); });
    },
    setProp: function (i, code) {
      if (!code) return;
      var n = clone(S.draft); n[i].propertyCode = code; n[i].propertyName = propName(code);
      persist(n, function () { toast('Now counted for ' + code + ' — read the sheets again to see it'); });
    },
    role: function (i, j, idx, role) { var n = clone(S.draft); var t = n[i].tabs[j]; t.overrides = t.overrides || {}; t.overrides[idx] = role; persist(n, function () { toast('Saved — read the sheets again to apply'); }); },
    addLink: function (v) { S.add.link = v; S.add.prefilled = true; },
    addCode: function (v) { S.add.code = v; S.add.prefilled = true; },
    addSheet: function () {
      var A = S.add, link = MM().parseSheetLink(A.link);
      A.error = null; A.share = false;
      if (!link) { A.error = 'Paste the link of a Google Sheet (docs.google.com/spreadsheets/…)'; render(); return; }
      if (!A.code) { A.error = 'Pick the property these leads are for'; render(); return; }
      if ((S.draft || []).some(function (s) { return s.spreadsheetId === link.spreadsheetId; })) { A.error = 'That sheet is already connected'; render(); return; }
      A.busy = true; render();
      inspectLink(A.link).then(function (r) {
        var src = fromInspect(r, A.code);
        if (!src.tabs.length) throw new Error('No tab in “' + r.title + '” looks like Meta’s lead export (an "id" and a "created_time" column)');
        var n = clone(S.draft || []); n.push(src);
        persist(n, function () {
          toast('Connected: ' + String(r.title).trim() + ' → ' + A.code + '. Press Read the sheets.');
          S.add = { link: '', code: '', busy: false, error: null, share: false, prefilled: true };
        });
      }).catch(function (e) {
        A.error = e.message; A.share = !!(e.data && e.data.code === 'share');
      }).then(function () { A.busy = false; render(); });
    }
  };

  // The CRM's leads change under the plan (a lead added, a stage moved): redraw it, at most every 2 s.
  var lastLeads = null;
  setInterval(function () {
    if (!S.read || !el() || el().style.display === 'none') return;
    var now = crmLeads();
    if (now !== lastLeads) { lastLeads = now; if (Date.now() - S.planAt > 2000) { replan(); render(); } }
  }, 2000);

  // The property list comes through the Firestore module, which loads after this script: asked for
  // before it is there, the names would be missing for the session (the same wait as Campaigns).
  var invAsked = false;
  function whenInventory() {
    if (invAsked || typeof loadInventory !== 'function') return;
    invAsked = true;
    new Promise(function (resolve) {
      var tries = 0;
      (function wait() { if ((window.crmFirebase && window.crmFirebase.getInventory) || tries++ > 80) return resolve(); setTimeout(wait, 150); })();
    }).then(function () { return loadInventory(); }).then(function (list) {
      if (!list || !list.length) invAsked = false;   // too early or failed: ask again next time
      // Names picked into the draft before the list arrived are filled in now.
      (S.draft || []).forEach(function (s) { if (!s.propertyName) s.propertyName = propName(s.propertyCode); });
      replan(); render();
    });
  }

  window.renderMetaLeadsView = function (view) {
    S.view = view || 'meta-leads';
    loadConfig();
    whenInventory();
    render();
  };
})();
