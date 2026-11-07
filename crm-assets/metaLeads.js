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
  var S = {
    view: 'meta-leads',
    cfg: null, cfgError: null, cfgLoading: false,
    read: null, readError: null, reading: false,
    plan: null, planAt: 0,
    prop: 'all', filter: 'all', q: '', open: null, shown: PAGE,
    f: { agent: '', rating: '', ad: '', tab: '', days: '', sort: 'new' }, sel: {}, edit: null, writing: false, stamp: true,
    draft: null, saving: false,
    add: { link: '', busy: false, error: null, share: false, result: null, tabs: {} },
    adding: false, colsFor: null, noteFor: null, pgClosed: {}, readingOne: null,
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
      '<div class="ml-test"><i class="fa-solid fa-circle-info"></i> Changes you make here (assigned to, rating, remarks, follow-ups) are <b>written to the Google Sheet</b>. Nothing is added to the CRM yet — the CRM column shows what a sync would do.</div>' +
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
  var FILTERS = [['all', 'All'], ['priority', 'Priority for the agent'], ['uncontacted', 'Not contacted yet'], ['create', 'New to the CRM'], ['crm', 'Already in the CRM'], ['repeat', 'Duplicates'], ['multi', 'More than one property'], ['problems', 'Problems']];
  var SORTS = [['new', 'Newest enquiry first'], ['old', 'Oldest enquiry first'], ['untouched', 'Not contacted first (oldest waiting)'], ['hot', 'Hot first'], ['name', 'Name A–Z']];
  var DAY_MS = 86400000;
  // A lead nobody has written on for this long is flagged — a Meta lead goes cold within a day.
  var SLA_MS = 24 * 3600000;
  function me() { return (typeof currentUserEmail !== 'undefined' && currentUserEmail) ? String(currentUserEmail).toLowerCase() : ''; }
  function peopleFor(code) {
    return S.plan.people.filter(function (p) { return code === 'all' || p.properties.indexOf(code) >= 0; });
  }
  function rowsFor(p, code) { return code === 'all' ? p.enquiries : p.enquiries.filter(function (e) { return e.propertyCode === code; }); }
  function lastAtFor(p) { var r = rowsFor(p, S.prop); return r.length ? (r[r.length - 1].at || 0) : (p.lastAt || 0); }
  function firstAtFor(p) { var r = rowsFor(p, S.prop); return r.length ? (r[0].at || 0) : (p.firstAt || 0); }
  function passes(p) {
    var f = S.filter, F = S.f;
    if (f === 'create' && p.action !== 'create') return false;
    if (f === 'crm' && !p.crm) return false;
    if (f === 'repeat' && !(S.prop === 'all' ? p.duplicate : p.dupCodes.indexOf(S.prop) >= 0)) return false;
    if (f === 'multi' && !p.multiProperty) return false;
    if (f === 'priority' && !MM().isPriorityFor(p, S.prop === 'all' ? '' : S.prop)) return false;
    if (f === 'uncontacted' && p.team.contacted) return false;
    if (f === 'problems' && !p.issues.length) return false;
    if (F.agent === '_mine' && p.team.agent !== me()) return false;
    if (F.agent === '_none' && p.team.assignedRaw) return false;
    if (F.agent && F.agent[0] !== '_' && p.team.agent !== F.agent && p.team.assignedRaw !== F.agent) return false;
    if (F.rating === 'none' && p.team.rating) return false;
    if (F.rating && F.rating !== 'none' && String(p.team.rating) !== F.rating) return false;
    var rows = rowsFor(p, S.prop);
    if (F.ad && !rows.some(function (e) { return (e.ad || '') === F.ad; })) return false;
    if (F.tab && !rows.some(function (e) { return e.where.spreadsheetId + ':' + e.where.gid === F.tab; })) return false;
    if (F.days && !rows.some(function (e) { return e.at && e.at > Date.now() - Number(F.days) * DAY_MS; })) return false;
    var q = S.q.trim().toLowerCase();
    if (q) {
      var hay = [p.name, p.phone, p.email, p.team.assignedRaw, p.crm && p.crm.name].concat(p.team.notes.map(function (n) { return n.text; })).join(' ').toLowerCase();
      if (hay.indexOf(q) < 0 && String(p.phoneKey).indexOf(q.replace(/\D/g, '') || '§') < 0) return false;
    }
    return true;
  }
  function sorted(list) {
    var by = S.f.sort, out = list.slice();
    if (by === 'old') out.sort(function (a, b) { return lastAtFor(a) - lastAtFor(b); });
    else if (by === 'untouched') out.sort(function (a, b) { return (a.team.contacted ? 1 : 0) - (b.team.contacted ? 1 : 0) || firstAtFor(a) - firstAtFor(b); });
    else if (by === 'hot') out.sort(function (a, b) { return (b.team.rating || 0) - (a.team.rating || 0) || lastAtFor(b) - lastAtFor(a); });
    else if (by === 'name') out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    else out.sort(function (a, b) { return lastAtFor(b) - lastAtFor(a); });
    return out;
  }
  function currentList() { return sorted(peopleFor(S.prop).filter(passes)); }
  function tiles(a, code) {
    var p = code === 'all' ? null : S.plan.properties.find(function (x) { return x.code === code; });
    var create = p ? p.create : S.plan.people.filter(function (x) { return x.action === 'create'; }).length;
    var mine = peopleFor(S.prop).filter(function (x) { return x.team.agent === me(); }).length;
    var late = peopleFor(S.prop).filter(function (x) { return !x.team.contacted && firstAtFor(x) && Date.now() - firstAtFor(x) > SLA_MS; }).length;
    var t = function (n, label, cls, onclick) { return '<button class="ml-tile ' + (cls || '') + '"' + (onclick ? ' onclick="' + onclick + '"' : '') + '><div class="ml-tile-n">' + n + '</div><div class="ml-tile-l">' + label + '</div></button>'; };
    return '<div class="ml-tiles">' +
      t(a.people, 'People (' + a.enquiries + ' enquiries)', '', "MetaLeads.filter('all')") +
      t(mine, 'Assigned to me', '', "MetaLeads.setF('agent','_mine')") +
      t(a.people - a.assigned, 'Not assigned', a.people - a.assigned ? 'warn' : '', "MetaLeads.setF('agent','_none')") +
      t(late, 'Not contacted for over a day', late ? 'bad' : '', "MetaLeads.lateFirst()") +
      t(a.ratings[3], 'Hot', '', "MetaLeads.setF('rating','3')") +
      t(a.priority, 'Revisited — priority', a.priority ? 'warn' : '', "MetaLeads.filter('priority')") +
      t(a.inCrm, 'Already in the CRM', '', "MetaLeads.filter('crm')") +
      t(create, 'Would be new CRM leads', 'brand', "MetaLeads.filter('create')") + '</div>';
  }
  function selectHtml(key, value, options) {
    return '<select class="ml-f" onchange="MetaLeads.setF(' + js(key) + ',this.value)">' + options.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select>';
  }
  function toolbar() {
    var F = S.f, scope = peopleFor(S.prop);
    var ads = {}, tabs = {};
    scope.forEach(function (p) { rowsFor(p, S.prop).forEach(function (e) { if (e.ad) ads[e.ad] = 1; tabs[e.where.spreadsheetId + ':' + e.where.gid] = String(e.where.sheetTitle).trim() + ' › ' + e.where.tab; }); });
    var agentOpts = [['', 'Every agent'], ['_mine', 'Assigned to me'], ['_none', 'Not assigned']].concat(roster().map(function (e) { return [e, agentLabel(e)]; }));
    var any = F.agent || F.rating || F.ad || F.tab || F.days || S.q || S.filter !== 'all';
    return '<div class="ml-tools">' +
      selectHtml('agent', F.agent, agentOpts) +
      selectHtml('rating', F.rating, [['', 'Any rating'], ['3', 'Hot'], ['2', 'Warm'], ['1', 'Cold'], ['none', 'Not rated']]) +
      selectHtml('ad', F.ad, [['', 'Every ad']].concat(Object.keys(ads).sort().map(function (x) { return [x, x]; }))) +
      selectHtml('tab', F.tab, [['', 'Every sheet tab']].concat(Object.keys(tabs).map(function (k) { return [k, tabs[k]]; }))) +
      selectHtml('days', F.days, [['', 'Any date'], ['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days']]) +
      '<span class="ml-tools-sep"></span>' +
      '<label class="ml-dim">Sort</label>' + selectHtml('sort', F.sort, SORTS) +
      (any ? '<button class="ml-link" onclick="MetaLeads.clearF()">Clear filters</button>' : '') +
      '<button class="ml-btn sm" onclick="MetaLeads.csv()" title="Download the people shown as a spreadsheet"><i class="fa-solid fa-download"></i> CSV</button>' +
    '</div>';
  }
  function bulkBar(list) {
    var keys = Object.keys(S.sel).filter(function (k) { return S.sel[k]; });
    var all = list.length && list.every(function (p) { return S.sel[p.key]; });
    var head = '<label class="ml-selall"><input type="checkbox" ' + (all ? 'checked' : '') + ' onchange="MetaLeads.selAll(this.checked)"> ' + (keys.length ? keys.length + ' selected' : 'Select all shown') + '</label>';
    if (!keys.length) return '<div class="ml-bulk">' + head + '</div>';
    var opts = '<option value="">Assign to…</option>' + roster().map(function (e) { return '<option value="' + esc(e) + '">' + esc(agentLabel(e)) + '</option>'; }).join('') + '<option value="_none">— Not assigned —</option>';
    return '<div class="ml-bulk on">' + head +
      '<select class="ml-f" ' + (S.writing ? 'disabled' : '') + ' onchange="if(this.value)MetaLeads.bulkAssign(this.value)">' + opts + '</select>' +
      '<select class="ml-f" ' + (S.writing ? 'disabled' : '') + ' onchange="if(this.value)MetaLeads.bulkRate(this.value)"><option value="">Set rating…</option><option value="3">Hot</option><option value="2">Warm</option><option value="1">Cold</option></select>' +
      '<button class="ml-link" onclick="MetaLeads.selNone()">Clear selection</button>' +
      (S.writing ? '<span class="ml-dim"><i class="fa-solid fa-rotate fa-spin"></i> Writing to the sheet…</span>' : '<span class="ml-dim">Written to each lead’s row in its sheet' + (S.prop === 'all' ? '' : ' (' + esc(S.prop) + ' rows)') + '.</span>') +
    '</div>';
  }
  function leadsHtml() {
    if (!S.plan) return needRead();
    var a = MM().analyse(S.plan, S.prop === 'all' ? '' : S.prop);
    var list = currentList();
    var chips = FILTERS.map(function (f) { return '<button class="ml-chip sm' + (S.filter === f[0] ? ' on' : '') + '" onclick="MetaLeads.filter(' + js(f[0]) + ')">' + f[1] + '</button>'; }).join('');
    var rows = list.slice(0, S.shown).map(personHtml).join('');
    return propChips(true) + tiles(a, S.prop) +
      '<div class="ml-bar"><div class="ml-chips">' + chips + '</div><input class="ml-search" type="search" placeholder="Search name, phone, note…" value="' + esc(S.q) + '" oninput="MetaLeads.search(this.value)"></div>' +
      toolbar() +
      '<div class="ml-count">' + list.length + ' ' + (list.length === 1 ? 'person' : 'people') + '</div>' +
      (list.length ? bulkBar(list) + '<div class="ml-list">' + rows + '</div>' : '<div class="ml-empty">Nobody matches.</div>') +
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
  function waLink(p) {
    var k = p.phoneKey;
    if (!k || !p.phoneOk) return '';
    var prop = p.properties[0] ? (propName(p.properties[0]) || p.properties[0]) : 'the property';
    var my = me() ? agentLabel(me()) : '';
    var msg = 'Hi ' + (String(p.name || '').split(' ')[0] || '') + ', this is ' + (my || 'the team') + ' from 3 PIN Realty. Thank you for your enquiry about ' + prop + '. When is a good time to talk?';
    return 'https://wa.me/' + k + '?text=' + encodeURIComponent(msg);
  }
  function waitingFlag(p) {
    if (p.team.contacted) return '';
    var t = firstAtFor(p); if (!t) return '';
    var ms = Date.now() - t;
    return '<span class="ml-badge ' + (ms > SLA_MS ? 'bad' : 'warn') + '" title="Nothing written on this lead yet">Not contacted · ' + esc(gapText(ms)) + '</span>';
  }
  function personHtml(p) {
    var rows = rowsFor(p, S.prop);
    var open = S.open === p.key;
    var last = p.team.notes.length ? p.team.notes[p.team.notes.length - 1].text : '';
    var who = p.team.agent ? agentLabel(p.team.agent) : (p.team.assignedRaw ? p.team.assignedRaw + ' ?' : '');
    var wa = waLink(p);
    return '<div class="ml-person' + (open ? ' open' : '') + (S.sel[p.key] ? ' sel' : '') + '">' +
      '<div class="ml-prow-w">' +
      '<label class="ml-pick1" title="Select"><input type="checkbox" ' + (S.sel[p.key] ? 'checked' : '') + ' onchange="MetaLeads.sel(' + js(p.key) + ',this.checked)"></label>' +
      '<button class="ml-prow" onclick="MetaLeads.toggle(' + js(p.key) + ')">' +
        '<div class="ml-who"><div class="ml-name">' + esc(p.name || '(no name)') + (p.crm && p.crm.name && p.crm.name !== p.name ? ' <span class="ml-aka">CRM: ' + esc(p.crm.name) + '</span>' : '') + '</div>' +
        '<div class="ml-phone' + (p.phoneOk ? '' : ' bad') + '">' + esc(p.phone ? MM().displayPhone(p.phone) : 'no phone') + '</div></div>' +
        '<div class="ml-when"><div>' + esc(MM().fmtWhen(rows.length ? rows[rows.length - 1].at : p.lastAt)) + '</div>' +
        '<div class="ml-dim">' + (p.dupCodes.filter(function (c) { return S.prop === 'all' || c === S.prop; }).map(function (c) { return '<span class="ml-badge warn" title="More than one row for ' + esc(c) + '">Duplicate ×' + p.enquiries.filter(function (e) { return e.propertyCode === c; }).length + (S.prop === 'all' ? ' ' + esc(c) : '') + '</span>'; }).join(' ') || esc(rows[0] && rows[0].ad || '')) +
        (S.prop === 'all' || p.properties.length > 1 ? ' ' + p.properties.map(function (c) { return '<span class="ml-code">' + esc(c) + '</span>'; }).join(' ') : '') + '</div></div>' +
        '<div class="ml-team"><div>' + (who ? '<i class="fa-regular fa-user"></i> ' + esc(who) : '<span class="ml-dim">Not assigned</span>') + ' ' + ratingChip(p.team.rating) + '</div>' +
        '<div class="ml-dim ml-note">' + (last ? esc(last) : waitingFlag(p) || '—') + '</div></div>' +
        '<div class="ml-act">' + actionBadge(p) + (p.crm ? '<div class="ml-dim">' + esc(p.crm.stage || '') + (p.crm.agent ? ' · ' + esc(agentLabel(p.crm.agent)) : '') + '</div>' : '') +
        (p.issues.length ? '<div class="ml-issue"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(p.issues.join(' · ')) + '</div>' : '') + '</div>' +
      '</button>' +
      '<div class="ml-quick">' + (p.phoneOk ? '<a class="ml-qb" href="tel:+' + esc(p.phoneKey) + '" title="Call"><i class="fa-solid fa-phone"></i></a>' : '') +
        (wa ? '<a class="ml-qb wa" href="' + esc(wa) + '" target="_blank" rel="noopener" title="WhatsApp"><i class="fa-brands fa-whatsapp"></i></a>' : '') + '</div>' +
      '</div>' + (open ? detailHtml(p) : '') + '</div>';
  }
  function enquiryLine(e, prev) {
    var gap = prev && prev.at && e.at ? gapText(e.at - prev.at) : '';
    var link = e.where.spreadsheetId ? MM().sheetUrl(e.where.spreadsheetId, e.where.gid) : '';
    return '<div class="ml-enq">' +
      '<div class="ml-enq-t"><b>' + esc(MM().fmtWhen(e.at)) + '</b>' + (gap ? ' <span class="ml-gap">' + esc(gap) + ' later</span>' : '') + '</div>' +
      '<div class="ml-enq-d">' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(String(e.where.sheetTitle).trim() + ' › ' + e.where.tab) + ' · row ' + e.row + '</a>' : esc(e.where.tab)) +
      (e.where.tag ? ' <span class="ml-tag">' + esc(e.where.tag) + '</span>' : '') +
      ' · <span class="ml-code">' + esc(e.propertyCode) + '</span> · ' + esc(e.ad || '—') + ' · ' + esc({ ig: 'Instagram', fb: 'Facebook' }[e.platform] || e.platform || '') +
      (e.form ? ' · form “' + esc(e.form) + '”' : '') + '</div>' +
      (e.answers.length ? '<div class="ml-ans">' + e.answers.map(function (x) { return '<span>' + esc(x.label) + ' <b>' + esc(x.value) + '</b></span>'; }).join('') + '</div>' : '') +
      (e.alsoIn && e.alsoIn.length ? '<div class="ml-dim">Also copied in ' + e.alsoIn.map(function (a) { return esc(a.tab); }).join(', ') + '</div>' : '') +
      (e.metaId ? '<button class="ml-link ml-editrow" onclick="MetaLeads.editRow(' + js(rowKey(e)) + ')">' + (S.edit === rowKey(e) ? 'Close' : 'Edit this row') + '</button>' : '') +
      '</div>';
  }

  // ─── Working a lead: what is written to the sheet ──────────────────────
  var QUICK = ['RNR — no answer', 'Busy, call back', 'Details sent on WhatsApp', 'Interested — fix site visit', 'Site visit fixed', 'Visited', 'Budget mismatch', 'Location not suitable', 'Not interested', 'Wrong number', 'Already bought elsewhere'];
  function rowKey(e) { return e.where.spreadsheetId + ':' + e.where.gid + ':' + e.metaId; }
  function readTab(sid, gid) { return S.read && (S.read.tabs || []).find(function (t) { return t.spreadsheetId === sid && t.gid === gid; }); }
  function planTab(sid, gid) { return S.plan && S.plan.tabs.find(function (t) { return t.spreadsheetId === sid && t.gid === gid; }); }
  function cellOf(e, col) { var t = readTab(e.where.spreadsheetId, e.where.gid); var r = t && t.values[e.row - 1]; return r && r[col] != null ? String(r[col]).trim() : ''; }
  function teamCols(e) { var pt = planTab(e.where.spreadsheetId, e.where.gid); return pt ? pt.cols.filter(function (c) { return MM().TEAM_ROLES.indexOf(c.role) >= 0; }) : []; }
  function firstCol(e, role) { return teamCols(e).find(function (c) { return c.role === role; }) || null; }
  function today() { var d = new Date(Date.now() + 5.5 * 3600000); return d.getUTCDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; }
  function agentOptions(current) {
    var cur = current ? MM().matchAgent(current, roster()) : null;
    return '<option value="">— Not assigned —</option>' + roster().map(function (e) { return '<option value="' + esc(e) + '"' + (cur === e ? ' selected' : '') + '>' + esc(agentLabel(e)) + '</option>'; }).join('') +
      (current && !cur ? '<option value="_keep" selected>' + esc(current) + ' (as written)</option>' : '');
  }
  // The quick form: the latest row for the property in view — assign, rate, a remark, a follow-up.
  function workHtml(p) {
    var rows = rowsFor(p, S.prop).filter(function (e) { return e.metaId; });
    var e = rows[rows.length - 1];
    if (!e) return '';
    var aCol = firstCol(e, 'assigned'), rCol = firstCol(e, 'rating'), mCol = firstCol(e, 'remarks');
    var aNow = aCol ? cellOf(e, aCol.index) : '', rNow = rCol ? cellOf(e, rCol.index) : '', mNow = mCol ? cellOf(e, mCol.index) : '';
    var k = js(p.key), rated = MM().parseRating(rNow);
    return '<div class="ml-work"><div class="ml-h">Work this lead <span class="ml-dim">— written to ' + esc(String(e.where.sheetTitle).trim() + ' › ' + e.where.tab) + ', row ' + e.row + '</span></div>' +
      '<div class="ml-wgrid">' +
        '<label>Assigned to</label><select class="ml-f" id="mlwA">' + agentOptions(aNow) + '</select>' +
        '<label>Rating</label><div class="ml-rates">' + [3, 2, 1].map(function (n) { return '<button type="button" class="ml-rb r' + n + (rated === n ? ' on' : '') + '" onclick="MetaLeads.pickRate(this,' + n + ')">' + MM().RATING_LABEL[n] + '</button>'; }).join('') + '<input type="hidden" id="mlwR" value="' + (rated || '') + '"></div>' +
        '<label>' + esc(mCol ? mCol.label : 'Remarks') + '</label><textarea class="ml-in" id="mlwM" rows="2" placeholder="What did they say?">' + esc(mNow) + '</textarea>' +
        '<label>Add a follow-up</label><div><input class="ml-in" id="mlwF" placeholder="e.g. Busy, call back at 6 pm">' +
          '<div class="ml-qchips">' + QUICK.map(function (q) { return '<button type="button" class="ml-qc" onclick="MetaLeads.quickText(' + js(q) + ')">' + esc(q) + '</button>'; }).join('') + '</div>' +
          '<label class="ml-dim"><input type="checkbox" id="mlwD" ' + (S.stamp ? 'checked' : '') + ' onchange="MetaLeads.stamp(this.checked)"> add today’s date (' + esc(today()) + ')</label></div>' +
      '</div>' +
      '<div class="ml-wbtns"><button class="ml-btn primary" ' + (S.writing ? 'disabled' : '') + ' onclick="MetaLeads.saveWork(' + k + ')">' + (S.writing ? '<i class="fa-solid fa-rotate fa-spin"></i> Writing…' : 'Save to the sheet') + '</button>' +
        (p.phoneOk ? ' <a class="ml-btn" href="tel:+' + esc(p.phoneKey) + '"><i class="fa-solid fa-phone"></i> Call</a> <a class="ml-btn" href="' + esc(waLink(p)) + '" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> WhatsApp</a>' : '') + '</div>' +
    '</div>';
  }
  // Every team column of one row, as it is in the sheet, editable.
  function rowEditHtml(e) {
    if (S.edit !== rowKey(e)) return '';
    var cols = teamCols(e);
    var k = js(rowKey(e));
    return '<div class="ml-rowedit">' + (cols.length ? cols.map(function (c) {
      var v = cellOf(e, c.index);
      return '<label>' + esc(c.header || ('Column ' + MM().colLetter(c.index))) + ' <span class="ml-dim">' + MM().colLetter(c.index) + ' · ' + esc(MM().ROLES[c.role]) + '</span></label>' +
        '<textarea class="ml-in" rows="1" data-col="' + c.index + '" data-from="' + esc(v) + '">' + esc(v) + '</textarea>';
    }).join('') : '<div class="ml-dim">This row has no team columns yet — use Work this lead, which adds them.</div>') +
      '<div class="ml-wbtns"><button class="ml-btn primary sm" ' + (S.writing ? 'disabled' : '') + ' onclick="MetaLeads.saveRow(' + k + ')">Save row to the sheet</button> <button class="ml-btn sm" onclick="MetaLeads.editRow(null)">Cancel</button></div></div>';
  }
  // Write edits, tab by tab; each answer is put into the rows on screen at once (no re-read).
  async function writeEdits(groups) {
    var total = 0, conflicts = [], errs = [];
    S.writing = true; render();
    try {
      for (var key in groups) {
        var g = groups[key];
        var d = await api('write', { spreadsheetId: g.sid, gid: g.gid, edits: g.edits });
        var t = readTab(g.sid, g.gid);
        if (t) {
          (d.added || []).forEach(function (a) { while (t.values[0].length <= a.col) t.values[0].push(''); t.values[0][a.col] = a.header; });
          (d.applied || []).forEach(function (a) { var r = t.values[a.row - 1] || (t.values[a.row - 1] = []); while (r.length <= a.col) r.push(''); r[a.col] = a.value; });
        }
        total += (d.applied || []).length;
        conflicts = conflicts.concat(d.conflicts || []); errs = errs.concat(d.errors || []);
      }
    } catch (e) { errs.push(e.message); }
    S.writing = false;
    replan(); render();
    if (errs.length) toast(errs[0]);
    else if (conflicts.length) toast(conflicts.length + ' change' + (conflicts.length > 1 ? 's were' : ' was') + ' not written — the sheet changed since it was read. Press Read the sheets, then try again.');
    else toast(total ? 'Written to the sheet (' + total + ' cell' + (total > 1 ? 's' : '') + ')' : 'Nothing changed');
    return { total: total, conflicts: conflicts, errors: errs };
  }
  function addEdit(groups, e, edit) {
    var k = e.where.spreadsheetId + ':' + e.where.gid;
    (groups[k] = groups[k] || { sid: e.where.spreadsheetId, gid: e.where.gid, edits: [] }).edits.push(Object.assign({ metaId: e.metaId }, edit));
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
      '<div class="ml-col"><div class="ml-h">Enquiries (' + rows.length + ')</div>' + rows.map(function (e, i) { return enquiryLine(e, rows[i - 1]) + rowEditHtml(e); }).join('') + '</div>' +
      '<div class="ml-col">' + workHtml(p) + '<div class="ml-h">Written in the sheet</div>' +
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
    var whole = MM().analyse(S.plan, code);
    // One tab picked: everything below is that tab's alone.
    var tabSel = S.tab && whole.byTab.find(function (t) { return t.key === S.tab; });
    if (S.tab && !tabSel) S.tab = null;
    var a = tabSel ? MM().analyse(S.plan, code, Date.now(), 30, S.tab) : whole;
    var max = Math.max.apply(null, a.series.map(function (x) { return x.n; }).concat([1]));
    var series = '<div class="ml-series">' + a.series.map(function (x) {
      return '<div class="ml-s" title="' + esc(x.label + ': ' + x.n) + '"><div class="ml-s-b" style="height:' + Math.round(100 * x.n / max) + '%"></div><div class="ml-s-l">' + (x.n ? x.n : '') + '</div></div>';
    }).join('') + '</div><div class="ml-s-axis"><span>' + esc(a.series.length ? a.series[0].label : '') + '</span><span>' + esc(a.series.length ? a.series[a.series.length - 1].label : '') + '</span></div>';
    var rate = [{ label: 'Hot (3)', n: a.ratings[3] }, { label: 'Warm (2)', n: a.ratings[2] }, { label: 'Cold (1)', n: a.ratings[1] }, { label: 'Not rated', n: a.ratings.none }];
    var pct = function (n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; };
    var card = function (h, inner) { return '<div class="ml-card"><div class="ml-h">' + h + '</div>' + inner + '</div>'; };
    var pctOf = function (n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; };
    var tabTable = whole.byTab.length ? '<div class="ml-card"><div class="ml-h">By sheet and tab <span class="ml-dim">— click a tab for its own analysis</span></div>' +
      '<div class="ml-tt"><div class="ml-tt-r ml-tt-h"><span>Sheet › tab</span><span>Enquiries</span><span>People</span><span>Last 7 days</span><span>Written</span><span>Duplicates</span><span>In CRM</span><span>Top ad</span></div>' +
      whole.byTab.map(function (t) {
        return '<button class="ml-tt-r' + (S.tab === t.key ? ' on' : '') + '" onclick="MetaLeads.tab(' + js(t.key) + ')">' +
          '<span><b>' + esc(String(t.sheetTitle).trim()) + ' › ' + esc(t.title) + '</b>' + (t.tag ? ' <span class="ml-tag">' + esc(t.tag) + '</span>' : '') +
            (!code ? ' <span class="ml-code">' + esc(t.propertyCode) + '</span>' : '') +
            (t.remark ? '<div class="ml-dim">' + esc(t.remark) + '</div>' : '') +
            '<div class="ml-dim">' + esc(t.firstAt ? MM().fmtWhen(t.firstAt).split(',')[0] + ' – ' + MM().fmtWhen(t.lastAt).split(',')[0] : 'no rows') + '</div></span>' +
          '<span>' + t.enquiries + '</span><span>' + t.people + '</span><span>' + t.last7 + '</span><span>' + pctOf(t.contacted, t.people) + '</span><span>' + t.duplicates + '</span><span>' + t.inCrm + '</span><span>' + esc(t.topAd || '—') + '</span></button>';
      }).join('') + '</div></div>' : '';
    return propChips(true) +
      (tabSel ? '<div class="ml-tabsel"><i class="fa-solid fa-filter"></i> Only <b>' + esc(String(tabSel.sheetTitle).trim() + ' › ' + tabSel.title) + '</b>' + (tabSel.tag ? ' <span class="ml-tag">' + esc(tabSel.tag) + '</span>' : '') +
        ' <button class="ml-link" onclick="MetaLeads.tab(null)">Show the whole ' + (code ? 'property' : 'list') + ' ✕</button></div>' : '') +
      '<div class="ml-tiles">' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.enquiries + '</div><div class="ml-tile-l">Enquiries</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.people + '</div><div class="ml-tile-l">People</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.last7 + '</div><div class="ml-tile-l">Enquiries, last 7 days</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + pct(a.contacted, a.people) + '</div><div class="ml-tile-l">Have something written (' + a.contacted + ')</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + pct(a.assigned, a.people) + '</div><div class="ml-tile-l">Assigned (' + a.assigned + ')</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.repeats + '</div><div class="ml-tile-l">With duplicate rows</div></div>' +
        '<div class="ml-tile"><div class="ml-tile-n">' + a.inCrm + '</div><div class="ml-tile-l">Already in the CRM</div></div>' +
      '</div>' +
      tabTable + teamTable(a) + adTable(a) +
      card('Enquiries per day' + (a.series.length ? ' <span class="ml-dim">(' + a.series.length + ' days, India time)</span>' : ''), a.series.length ? series : '<div class="ml-dim">No dates.</div>') +
      '<div class="ml-grid">' +
        card('By ad', bars(a.byAd, a.enquiries)) +
        card('By platform', bars(a.byPlatform, a.enquiries)) +
        card('Rating (latest in the sheet)', bars(rate, a.people)) +
        card('Assigned to (in the sheet)', bars(a.byAgent.map(function (x) { return { label: x.label.indexOf('@') > 0 ? agentLabel(x.label) : x.label, n: x.n }; }), a.people)) +
        card('Already in the CRM — their stage', a.byStage.length ? bars(a.byStage, a.inCrm) : '<div class="ml-dim">None of them is a CRM lead yet.</div>') +
        a.questions.map(function (q) { return card('Form: ' + esc(q.label), bars(q.answers)); }).join('') +
      '</div>';
  }

  // The admin's reports: who holds which leads and how far they got; which ad brings better leads.
  function teamTable(a) {
    if (!a.agents.length) return '';
    var pct = function (n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; };
    return '<div class="ml-card"><div class="ml-h">Team — who holds which leads <span class="ml-dim">(click to see their leads)</span></div><div class="ml-tt">' +
      '<div class="ml-tt-r ml-tt-h ml-team-r"><span>Agent</span><span>Leads</span><span>Contacted</span><span>Not contacted</span><span>Hot</span><span>Warm</span><span>Priority</span></div>' +
      a.agents.map(function (x) {
        var label = x.agent ? (x.agent.indexOf('@') > 0 ? agentLabel(x.agent) : x.agent + ' (not on the team list)') : 'Not assigned';
        var f = x.agent ? x.agent : '_none';
        return '<button class="ml-tt-r ml-team-r" onclick="MetaLeads.agentLeads(' + js(f) + ')"><span><b>' + esc(label) + '</b></span><span>' + x.people + '</span><span>' + x.contacted + ' <span class="ml-dim">' + pct(x.contacted, x.people) + '</span></span>' +
          '<span' + (x.untouched ? ' class="ml-bad"' : '') + '>' + x.untouched + '</span><span>' + x.hot + '</span><span>' + x.warm + '</span><span>' + x.priority + '</span></button>';
      }).join('') + '</div></div>';
  }
  function adTable(a) {
    if (!a.adQuality.length) return '';
    var pct = function (n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; };
    return '<div class="ml-card"><div class="ml-h">Lead quality by ad <span class="ml-dim">(ratings from the sheet)</span></div><div class="ml-tt">' +
      '<div class="ml-tt-r ml-tt-h ml-ad-r"><span>Ad</span><span>Enquiries</span><span>People</span><span>Contacted</span><span>Hot</span><span>Warm or hot</span><span>Cold</span></div>' +
      a.adQuality.map(function (x) {
        return '<button class="ml-tt-r ml-ad-r" onclick="MetaLeads.adLeads(' + js(x.ad) + ')"><span><b>' + esc(x.ad) + '</b></span><span>' + x.enquiries + '</span><span>' + x.people + '</span><span>' + pct(x.contacted, x.people) + '</span>' +
          '<span>' + x.hot + '</span><span>' + pct(x.warmOrHot, x.people) + '</span><span>' + x.cold + '</span></button>';
      }).join('') + '</div></div>';
  }

  // ─── Setup ─────────────────────────────────────────────────────────────
  // Grouped by property: each property opens to its sheets and tabs — the sheet's link, each tab →
  // its property (picked, never guessed), its leads at the last read, its tag and remark. A sheet is
  // read only when someone presses Read. Every change is saved at once.
  function invByCode(code) {
    var c = String(code || '').toUpperCase();
    return inv().find(function (x) { return String(x.propertyCode || x.id || '').toUpperCase() === c; }) || null;
  }
  function propertySelect(code, attrs) {
    var list = inv().slice().sort(function (x, y) { return String(x.propertyCode || x.id).localeCompare(String(y.propertyCode || y.id)); });
    var has = !code || list.some(function (x) { return String(x.propertyCode || x.id).toUpperCase() === String(code).toUpperCase(); });
    var opts = '<option value="">Pick the property…</option>' +
      (has ? '' : '<option value="' + esc(code) + '" selected>' + esc(code) + '</option>') +
      list.map(function (x) {
        var c = String(x.propertyCode || x.id);
        return '<option value="' + esc(c) + '"' + (String(code || '').toUpperCase() === c.toUpperCase() ? ' selected' : '') + '>' + esc(c + (x.name ? ' — ' + x.name : '')) + '</option>';
      }).join('');
    return '<select class="ml-psel" ' + attrs + '>' + opts + '</select>';
  }
  function tabCode(s, t) { return String(t.propertyCode || s.propertyCode || '').toUpperCase(); }
  function lastReadOf(sourceId) { return S.cfg.lastRead && (S.cfg.lastRead.sheets || []).find(function (x) { return x.id === sourceId; }) || null; }
  function tabLeads(s, t) {
    var lr = lastReadOf(s.id);
    if (!lr) return null;
    if (!lr.ok) return { error: lr.error };
    var r = (lr.rows || []).find(function (x) { return x.gid === t.gid; });
    return r ? { n: r.rows } : null;
  }
  function shortUrl(id) { return 'docs.google.com/spreadsheets/d/' + id.slice(0, 10) + '…'; }

  function setupHtml() {
    if (S.cfgError) return '<div class="ml-alert bad">' + esc(S.cfgError) + ' <button class="ml-btn" onclick="MetaLeads.reload()">Try again</button></div>';
    if (!S.cfg) return '<div class="ml-empty"><i class="fa-solid fa-rotate fa-spin"></i> Loading the setup…</div>';
    var mgr = !!S.cfg.manager, list = S.draft || [];
    if (mgr && !list.length && !S.adding && !S.addClosed) { S.adding = true; S.add = { link: '', busy: false, error: null, share: false, result: null, tabs: {} }; setTimeout(function () { MetaLeads.available(); }, 0); }
    // Every tab, with its sheet, grouped by the property it is mapped to.
    var groups = {}, order = [];
    list.forEach(function (s, i) {
      (s.tabs || []).forEach(function (t, j) {
        var c = tabCode(s, t) || '';
        if (!groups[c]) { groups[c] = []; order.push(c); }
        groups[c].push({ s: s, i: i, t: t, j: j });
      });
    });
    order.sort(function (x, y) { return (x ? 0 : 1) - (y ? 0 : 1) || x.localeCompare(y); });
    var body = order.map(function (c) { return groupHtml(c, groups[c], mgr); }).join('');
    return '<div class="ml-card ml-map">' +
        '<div class="ml-map-h"><div><div class="ml-h2">Lead sheets by property</div>' +
          '<div class="ml-dim">Each tab of a lead sheet is mapped to a property. Nothing is read until you press Read.</div></div>' +
          (mgr && !S.adding ? '<button class="ml-btn primary" onclick="MetaLeads.startAdd()"><i class="fa-solid fa-plus"></i> Add sheet</button>' : '') + '</div>' +
        (mgr ? '' : '<div class="ml-alert">Only a manager can change the mapping. You can read the sheets and work the leads.</div>') +
        (S.adding ? addPanel() : '') +
        (order.length ? body : (S.adding ? '' : '<div class="ml-empty sm">No sheet mapped yet.' + (mgr ? ' Press <b>Add sheet</b>.' : '') + '</div>')) +
      '</div>' +
      '<div class="ml-foot"><i class="fa-solid fa-circle-info"></i> A sheet must be shared with <code>' + esc(S.cfg.shareWith) + '</code> as Editor <button class="ml-link" onclick="MetaLeads.copy(' + js(S.cfg.shareWith) + ')">Copy</button></div>';
  }
  function groupHtml(code, items, mgr) {
    var closed = S.pgClosed[code || '_'];
    var sheets = {}; items.forEach(function (x) { sheets[x.s.id] = 1; });
    var leads = items.reduce(function (n, x) { var l = tabLeads(x.s, x.t); return n + (l && l.n ? l.n : 0); }, 0);
    var name = code ? propName(code) : '';
    var head = '<button class="ml-pg-h" onclick="MetaLeads.pg(' + js(code || '_') + ')"><i class="fa-solid fa-chevron-' + (closed ? 'right' : 'down') + '"></i> ' +
      (code ? '<span class="ml-code">' + esc(code) + '</span> <b>' + esc(name || '') + '</b>' : '<b class="ml-bad">Not mapped to a property</b>') +
      '<span class="ml-dim"> · ' + Object.keys(sheets).length + ' sheet' + (Object.keys(sheets).length === 1 ? '' : 's') + ' · ' + items.length + ' tab' + (items.length === 1 ? '' : 's') + (leads ? ' · ' + leads + ' leads at the last read' : '') + '</span></button>';
    if (closed) return '<div class="ml-pgroup">' + head + '</div>';
    var lastSheet = null;
    var rows = items.map(function (x) {
      var first = lastSheet !== x.s.id; lastSheet = x.s.id;
      return tabRowHtml(x, first, mgr);
    }).join('');
    return '<div class="ml-pgroup open">' + head +
      '<div class="ml-tmap"><div class="ml-tmap-th"><span>Sheet</span><span>Tab</span><span>Property</span><span>Leads</span><span></span></div>' + rows + '</div></div>';
  }
  function tabRowHtml(x, first, mgr) {
    var s = x.s, t = x.t, key = s.id + ':' + t.gid;
    var l = tabLeads(s, t);
    var lr = lastReadOf(s.id);
    var editing = S.noteFor === key;
    var leads = s.on === false ? '<span class="ml-badge">Sheet off</span>' : t.on === false ? '<span class="ml-badge">Tab off</span>'
      : l && l.error ? '<span class="ml-badge bad" title="' + esc(l.error) + '">' + (/share it/.test(l.error) ? 'Not shared' : 'Cannot read') + '</span>'
      : l ? '<b>' + l.n + '</b>' : '<span class="ml-dim">—</span>';
    var sheetCell = first
      ? '<a href="' + esc(MM().sheetUrl(s.spreadsheetId, t.gid)) + '" target="_blank" rel="noopener" class="ml-sheetlink"><b>' + esc(String(s.title || '').trim()) + '</b> <i class="fa-solid fa-arrow-up-right-from-square"></i></a>' +
        '<div class="ml-url">' + esc(shortUrl(s.spreadsheetId)) + '</div>' +
        '<div class="ml-sheet-act">' +
          '<button class="ml-btn sm" ' + (S.readingOne === s.id || s.on === false ? 'disabled' : '') + ' onclick="MetaLeads.readOne(' + js(s.id) + ')"><i class="fa-solid fa-rotate' + (S.readingOne === s.id ? ' fa-spin' : '') + '"></i> Read</button>' +
          (lr && lr.ok ? '<span class="ml-dim"> ' + esc(timeAgoSafe(S.cfg.lastRead.at)) + '</span>' : '') +
          (mgr ? ' <label class="ml-sw" title="Read this sheet or not"><input type="checkbox" ' + (s.on !== false ? 'checked' : '') + ' onchange="MetaLeads.srcOn(' + x.i + ',this.checked)"> On</label>' +
            '<button class="ml-icon" title="Disconnect this sheet" onclick="MetaLeads.remove(' + x.i + ')"><i class="fa-regular fa-trash-can"></i></button>' : '') +
        '</div>'
      : '<span class="ml-dim ml-same">same sheet</span>';
    var note = (t.tag || t.remark) && !editing ? '<div class="ml-tabnote">' + (t.tag ? '<span class="ml-tag">' + esc(t.tag) + '</span> ' : '') + esc(t.remark || '') + '</div>' : '';
    var noteEdit = editing ? '<div class="ml-noteedit"><input class="ml-in ml-tag-in" maxlength="40" placeholder="Tag (e.g. Above 2 Cr form)" value="' + esc(t.tag || '') + '">' +
      '<input class="ml-in ml-remark-in" maxlength="500" placeholder="Remark for this tab" value="' + esc(t.remark || '') + '">' +
      '<button class="ml-btn sm primary" onclick="MetaLeads.saveNote(' + x.i + ',' + x.j + ')">Save</button> <button class="ml-btn sm" onclick="MetaLeads.note(null)">Cancel</button></div>' : '';
    return '<div class="ml-trow' + (s.on === false || t.on === false ? ' off' : '') + '">' +
        '<div class="ml-c-sheet">' + sheetCell + '</div>' +
        '<div class="ml-c-tab">' + (mgr ? '<label title="Read this tab or not"><input type="checkbox" ' + (t.on !== false ? 'checked' : '') + ' onchange="MetaLeads.tabOn(' + x.i + ',' + x.j + ',this.checked)"> ' : '<label>') + '<b>' + esc(t.title) + '</b></label>' +
          (mgr ? ' <button class="ml-link" onclick="MetaLeads.note(' + js(key) + ')">' + (t.tag || t.remark ? 'Edit tag' : '+ Tag / remark') + '</button>' : '') +
          note + noteEdit + '</div>' +
        '<div class="ml-c-prop">' + (mgr ? propertySelect(tabCode(s, t), 'onchange="MetaLeads.setTabProp(' + x.i + ',' + x.j + ',this.value)"')
          : '<span class="ml-code">' + esc(tabCode(s, t)) + '</span> ' + esc(propName(tabCode(s, t)))) + '</div>' +
        '<div class="ml-c-leads">' + leads + '</div>' +
        '<div class="ml-c-act"><button class="ml-link" onclick="MetaLeads.cols(' + js(key) + ')">' + (S.colsFor === key ? 'Hide columns' : 'Columns') + '</button></div>' +
        (S.colsFor === key ? '<div class="ml-trow-x">' + colsFor(s, t, x.i, x.j, mgr) + '</div>' : '') +
      '</div>';
  }
  function colsFor(s, t, i, j, mgr) {
    var pt = S.plan && S.plan.tabs.find(function (x) { return x.spreadsheetId === s.spreadsheetId && x.gid === t.gid; });
    return pt ? colsHtml(pt, i, j, mgr) : '<div class="ml-dim">Read this sheet to see what each column holds.</div>';
  }
  function addPanel() {
    var A = S.add, r = A.result;
    var err = A.error ? '<div class="ml-alert bad">' + esc(A.error) +
      (A.share ? '<div class="ml-sa"><code>' + esc(S.cfg.shareWith) + '</code> <button class="ml-btn sm" onclick="MetaLeads.copy(' + js(S.cfg.shareWith) + ')"><i class="fa-regular fa-copy"></i> Copy</button></div><div class="ml-dim">In the sheet: Share → paste this address → Editor → Send. Then press Check again.</div>' : '') + '</div>' : '';
    var tabs = r ? r.tabs.map(function (t) {
      var T2 = A.tabs[t.gid] || {};
      return '<div class="ml-arow' + (T2.on ? '' : ' off') + '">' +
        '<label><input type="checkbox" ' + (T2.on ? 'checked' : '') + ' onchange="MetaLeads.addTabOn(' + t.gid + ',this.checked)"> <b>' + esc(t.title) + '</b></label>' +
        '<span class="ml-dim">' + t.count + ' rows · ' + (t.looksMeta ? 'Meta leads' : '<span class="ml-bad">not a Meta export</span>') + '</span>' +
        '<span class="ml-arrow"><i class="fa-solid fa-arrow-right"></i></span>' +
        '<div class="ml-pick">' + propertySelect(T2.code || '', 'onchange="MetaLeads.addTabProp(' + t.gid + ',this.value)"') + '</div>' +
        '<input class="ml-in ml-addtag" maxlength="40" placeholder="Tag (optional)" value="' + esc(T2.tag || '') + '" oninput="MetaLeads.addTabTag(' + t.gid + ',this.value)">' +
      '</div>';
    }).join('') : '';
    return '<div class="ml-addpanel">' +
      '<div class="ml-h">Add a lead sheet</div>' +
      '<div class="ml-addline"><input class="ml-in ml-link-in" placeholder="Paste the Google Sheets link" value="' + esc(A.link) + '" oninput="MetaLeads.addLink(this.value)">' +
        '<button class="ml-btn" ' + (A.busy ? 'disabled' : '') + ' onclick="MetaLeads.check()">' + (A.busy ? '<i class="fa-solid fa-rotate fa-spin"></i> Checking…' : 'Check') + '</button></div>' + err +
      (r ? '' : availableHtml()) +
      (r ? '<div class="ml-found"><div class="ml-found-h"><a href="' + esc(MM().sheetUrl(r.spreadsheetId)) + '" target="_blank" rel="noopener"><b>' + esc(String(r.title).trim()) + '</b> <i class="fa-solid fa-arrow-up-right-from-square"></i></a> <span class="ml-dim">— pick the property for each tab</span></div>' + tabs + '</div>' : '') +
      '<div class="ml-addbtns">' + (r ? '<button class="ml-btn primary" ' + (S.saving ? 'disabled' : '') + ' onclick="MetaLeads.saveAdd()">Save mapping</button> ' : '') + '<button class="ml-btn" onclick="MetaLeads.cancelAdd()">Cancel</button></div>' +
    '</div>';
  }
  // The sheets the app can open (shared with its account): Meta ad lead sheets first, one click.
  function availableHtml() {
    var V = S.avail;
    if (!V || V.loading) return '<div class="ml-avail"><div class="ml-dim"><i class="fa-solid fa-rotate fa-spin"></i> Finding the sheets shared with the app…</div></div>';
    if (V.error) return '<div class="ml-avail"><div class="ml-alert bad">' + esc(V.error) + '</div></div>';
    var item = function (f) {
      return '<div class="ml-av' + (f.mapped ? ' mapped' : '') + '"><div><b>' + esc(String(f.title).trim()) + '</b>' +
        '<div class="ml-dim">' + esc(f.owner || '') + (f.modifiedTime ? ' · edited ' + esc(timeAgoSafe(f.modifiedTime)) : '') + '</div></div>' +
        (f.mapped ? '<span class="ml-badge ok">Mapped</span>' : '<button class="ml-btn sm" onclick="MetaLeads.choose(' + js(f.id) + ')">Choose</button>') + '</div>';
    };
    var meta = V.files.filter(function (f) { return f.isMeta; }), other = V.files.filter(function (f) { return !f.isMeta; });
    return '<div class="ml-avail">' +
      '<div class="ml-h">Meta ad lead sheets the app can open <span class="ml-dim">' + meta.length + '</span></div>' +
      (meta.length ? meta.map(item).join('') : '<div class="ml-dim">None yet. Share the ad\'s lead sheet with the app (below), then press <button class="ml-link" onclick="MetaLeads.available(true)">Look again</button>.</div>') +
      (other.length ? '<details class="ml-other"><summary>Other sheets shared with the app (' + other.length + ')</summary>' + other.map(item).join('') + '</details>' : '') +
      '<div class="ml-dim ml-avail-f">Not in the list? It is not shared with the app yet — share it with <code>' + esc(S.cfg.shareWith) + '</code> as Editor, then <button class="ml-link" onclick="MetaLeads.available(true)">look again</button>, or paste its link above.</div>' +
    '</div>';
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
    prop: function (c) { S.prop = c; S.open = null; S.shown = PAGE; S.tab = null; render(); },
    tab: function (k) { S.tab = S.tab === k ? null : k; render(); },
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
    agentLeads: function (agent) { S.f = { agent: agent, rating: '', ad: '', tab: '', days: '', sort: 'untouched' }; S.filter = 'all'; MetaLeads.go('meta-leads'); },
    adLeads: function (ad) { S.f = { agent: '', rating: '', ad: ad, tab: '', days: '', sort: 'new' }; S.filter = 'all'; MetaLeads.go('meta-leads'); },
    setF: function (k, v) { S.f[k] = v; S.shown = PAGE; if (S.view !== 'meta-leads') { MetaLeads.go('meta-leads'); return; } render(); },
    clearF: function () { S.f = { agent: '', rating: '', ad: '', tab: '', days: '', sort: S.f.sort }; S.filter = 'all'; S.q = ''; render(); },
    lateFirst: function () { S.filter = 'uncontacted'; S.f.sort = 'untouched'; render(); },
    sel: function (k, on) { S.sel[k] = on; render(); },
    selAll: function (on) { currentList().forEach(function (p) { S.sel[p.key] = on; }); render(); },
    selNone: function () { S.sel = {}; render(); },
    bulkAssign: function (email) {
      var list = S.plan.people.filter(function (p) { return S.sel[p.key]; });
      var name = email === '_none' ? '' : agentLabel(email);
      if (!confirm((name ? 'Assign ' + list.length + ' lead' + (list.length > 1 ? 's' : '') + ' to ' + name : 'Clear the agent of ' + list.length + ' lead' + (list.length > 1 ? 's' : '')) + '? It is written in the Assigned to column of each lead’s row' + (S.prop === 'all' ? '' : ' for ' + S.prop) + '.')) { render(); return; }
      var groups = {};
      list.forEach(function (p) { rowsFor(p, S.prop).forEach(function (e) { if (!e.metaId) return; var c = firstCol(e, 'assigned'); addEdit(groups, e, { field: 'assigned', value: name, from: c ? cellOf(e, c.index) : '' }); }); });
      writeEdits(groups).then(function (r) { if (!r.errors.length && !r.conflicts.length) S.sel = {}; render(); });
    },
    bulkRate: function (n) {
      var list = S.plan.people.filter(function (p) { return S.sel[p.key]; });
      var groups = {};
      list.forEach(function (p) { rowsFor(p, S.prop).forEach(function (e) { if (!e.metaId) return; var c = firstCol(e, 'rating'); addEdit(groups, e, { field: 'rating', value: String(n), from: c ? cellOf(e, c.index) : '' }); }); });
      writeEdits(groups).then(function (r) { if (!r.errors.length && !r.conflicts.length) S.sel = {}; render(); });
    },
    pickRate: function (btn, n) {
      var box = btn.parentNode, hid = box.querySelector('input'); var on = hid.value === String(n);
      hid.value = on ? '' : String(n);
      box.querySelectorAll('.ml-rb').forEach(function (b) { b.classList.toggle('on', !on && b === btn); });
    },
    quickText: function (q) { var f = document.getElementById('mlwF'); if (f) { f.value = f.value ? f.value + ', ' + q : q; f.focus(); } },
    stamp: function (on) { S.stamp = on; },
    saveWork: function (key) {
      var p = S.plan.people.find(function (x) { return x.key === key; });
      var rows = rowsFor(p, S.prop).filter(function (e) { return e.metaId; }), e = rows[rows.length - 1];
      var A = document.getElementById('mlwA').value, R = document.getElementById('mlwR').value, M = document.getElementById('mlwM').value.trim(), F = document.getElementById('mlwF').value.trim();
      var aCol = firstCol(e, 'assigned'), rCol = firstCol(e, 'rating'), mCol = firstCol(e, 'remarks');
      var aNow = aCol ? cellOf(e, aCol.index) : '', rNow = rCol ? cellOf(e, rCol.index) : '', mNow = mCol ? cellOf(e, mCol.index) : '';
      var groups = {};
      if (A !== '_keep') { var name = A ? agentLabel(A) : ''; if (name !== aNow && !(A && MM().matchAgent(aNow, roster()) === A)) addEdit(groups, e, { field: 'assigned', value: name, from: aNow }); }
      if (R && MM().parseRating(rNow) !== Number(R)) addEdit(groups, e, { field: 'rating', value: R, from: rNow });
      if (M !== mNow) addEdit(groups, e, mCol ? { col: mCol.index, value: M, from: mNow } : { field: 'remarks', value: M, from: '' });
      if (F) addEdit(groups, e, { field: 'followup', next: true, value: S.stamp ? F + ' (' + today() + ')' : F });
      if (!Object.keys(groups).length) { toast('Nothing changed'); return; }
      writeEdits(groups);
    },
    editRow: function (k) { S.edit = S.edit === k ? null : k; render(); },
    saveRow: function (k) {
      var e = null;
      S.plan.people.some(function (p) { return p.enquiries.some(function (x) { if (rowKey(x) === k) { e = x; return true; } return false; }); });
      if (!e) return;
      var groups = {};
      document.querySelectorAll('#metaLeadsView .ml-rowedit textarea').forEach(function (t) {
        var from = t.getAttribute('data-from'), v = t.value.trim();
        if (v !== from) addEdit(groups, e, { col: Number(t.getAttribute('data-col')), value: v, from: from });
      });
      if (!Object.keys(groups).length) { toast('Nothing changed'); return; }
      writeEdits(groups).then(function (r) { if (!r.errors.length && !r.conflicts.length) { S.edit = null; render(); } });
    },
    csv: function () {
      var list = currentList();
      var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var head = ['Name', 'Phone', 'Email', 'Properties', 'First enquiry', 'Last enquiry', 'Enquiries', 'Ads', 'Assigned to', 'Rating', 'Latest note', 'Contacted', 'In the CRM (stage)'];
      var lines = [head.join(',')].concat(list.map(function (p) {
        var rows = rowsFor(p, S.prop);
        return [p.name, p.phone ? MM().displayPhone(p.phone) : '', p.email, p.properties.join(' '), MM().fmtWhen(firstAtFor(p)), MM().fmtWhen(lastAtFor(p)), rows.length,
          Array.from(new Set(rows.map(function (e) { return e.ad; }))).join(' / '), p.team.agent ? agentLabel(p.team.agent) : p.team.assignedRaw,
          p.team.rating ? MM().RATING_LABEL[p.team.rating] : '', p.team.notes.length ? p.team.notes[p.team.notes.length - 1].text : '', p.team.contacted ? 'yes' : 'no', p.crm ? p.crm.stage : ''].map(q).join(',');
      }));
      var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'meta-ads-leads-' + (S.prop === 'all' ? 'all' : S.prop) + '.csv';
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    },
    cols: function (k) { S.colsFor = S.colsFor === k ? null : k; render(); },
    pg: function (c) { S.pgClosed[c] = !S.pgClosed[c]; render(); },
    note: function (k) { S.noteFor = k; render(); if (k) setTimeout(function () { var x = document.querySelector('#metaLeadsView .ml-tag-in'); if (x) x.focus(); }, 30); },
    saveNote: function (i, j) {
      var tag = (document.querySelector('#metaLeadsView .ml-tag-in') || {}).value || '', remark = (document.querySelector('#metaLeadsView .ml-remark-in') || {}).value || '';
      var n = clone(S.draft); n[i].tabs[j].tag = tag.trim(); n[i].tabs[j].remark = remark.trim();
      persist(n, function () { S.noteFor = null; toast('Saved'); });
    },
    tabOn: function (i, j, on) { var n = clone(S.draft); n[i].tabs[j].on = on; persist(n, function () { toast(on ? 'Tab on' : 'Tab off — not read'); }); },
    srcOn: function (i, on) { var n = clone(S.draft); n[i].on = on; persist(n, function () { toast(on ? 'Sheet on' : 'Sheet off — not read'); }); },
    remove: function (i) {
      var t = String(S.draft[i].title).trim();
      if (!confirm('Disconnect “' + t + '” and all its tabs? Its leads stay in the sheet; it is just not read any more.')) return;
      var n = clone(S.draft); n.splice(i, 1); persist(n, function () { toast('Disconnected'); });
    },
    setTabProp: function (i, j, code) {
      if (!code) return;
      var n = clone(S.draft); n[i].tabs[j].propertyCode = code;
      persist(n, function () { toast(n[i].tabs[j].title + ' → ' + code + '. Read the sheet to see it.'); });
    },
    role: function (i, j, idx, role) { var n = clone(S.draft); var t = n[i].tabs[j]; t.overrides = t.overrides || {}; t.overrides[idx] = role; persist(n, function () { toast('Saved — read the sheet again to apply'); }); },
    readOne: function (id) {
      if (S.readingOne) return;
      S.readingOne = id; render();
      api('read', { sourceId: id }).then(function (d) {
        // The sheet's tabs replace its earlier ones; the other sheets' stay as read.
        var keep = S.read ? (S.read.tabs || []).filter(function (t) { return t.sourceId !== id; }) : [];
        var errs = S.read ? (S.read.errors || []).filter(function (e) { return e.sourceId !== id; }) : [];
        S.read = { ok: true, at: d.at, tabs: keep.concat(d.tabs || []), errors: errs.concat(d.errors || []) };
        replan();
        toast(d.errors && d.errors.length ? d.errors[0].error : 'Read — ' + (d.tabs || []).reduce(function (n, t) { return n + Math.max((t.values || []).length - 1, 0); }, 0) + ' rows. Nothing was added to the CRM.');
        loadConfig(true);
      }).catch(function (e) { toast(e.message); }).then(function () { S.readingOne = null; render(); });
    },
    startAdd: function () { S.adding = true; S.add = { link: '', busy: false, error: null, share: false, result: null, tabs: {} }; MetaLeads.available(); render(); },
    available: function (force) {
      if (S.avail && !S.avail.error && !force) { render(); return; }
      S.avail = { loading: true, files: [] }; render();
      api('available').then(function (d) { S.avail = { files: d.files || [] }; })
        .catch(function (e) { S.avail = { error: e.message, files: [] }; }).then(render);
    },
    choose: function (id) { S.add.link = MM().sheetUrl(id); MetaLeads.check(); },
    cancelAdd: function () { S.adding = false; S.addClosed = true; render(); },
    addLink: function (v) { S.add.link = v; },
    addTabOn: function (gid, on) { S.add.tabs[gid] = Object.assign({}, S.add.tabs[gid], { on: on }); render(); },
    addTabProp: function (gid, code) { S.add.tabs[gid] = Object.assign({}, S.add.tabs[gid], { code: code }); },
    addTabTag: function (gid, v) { S.add.tabs[gid] = Object.assign({}, S.add.tabs[gid], { tag: v }); },
    check: function () {
      var A = S.add, link = MM().parseSheetLink(A.link);
      A.error = null; A.share = false; A.result = null;
      if (!link) { A.error = 'Paste the link of a Google Sheet (docs.google.com/spreadsheets/…)'; render(); return; }
      if ((S.draft || []).some(function (s) { return s.spreadsheetId === link.spreadsheetId; })) { A.error = 'That sheet is already mapped — change its tabs below'; render(); return; }
      A.busy = true; render();
      inspectLink(A.link).then(function (r) {
        A.result = r; A.tabs = {};
        // Meta's own tabs ticked; no property picked for any — that is the person's choice.
        r.tabs.forEach(function (t) { A.tabs[t.gid] = { on: t.looksMeta, code: '', tag: '' }; });
      }).catch(function (e) { A.error = e.message; A.share = !!(e.data && e.data.code === 'share'); })
        .then(function () { A.busy = false; render(); });
    },
    saveAdd: function () {
      var A = S.add, r = A.result;
      var on = r.tabs.filter(function (t) { return (A.tabs[t.gid] || {}).on; });
      if (!on.length) { toast('Tick at least one tab'); return; }
      var missing = on.filter(function (t) { return !(A.tabs[t.gid] || {}).code; });
      if (missing.length) { toast('Pick the property for ' + missing.map(function (t) { return t.title; }).join(', ')); return; }
      var src = { spreadsheetId: r.spreadsheetId, title: r.title, propertyCode: '', on: true,
        tabs: on.map(function (t) { var x = A.tabs[t.gid]; return { gid: t.gid, title: t.title, on: true, overrides: {}, propertyCode: x.code, tag: (x.tag || '').trim() }; }) };
      var n = clone(S.draft || []); n.push(src);
      persist(n, function () {
        S.adding = false;
        if (S.avail && S.avail.files) S.avail.files.forEach(function (f) { if (f.id === r.spreadsheetId) f.mapped = true; });
        toast('Mapped: ' + String(r.title).trim() + '. Press Read on it to see its leads.');
      });
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

  // ─── pages ─────────────────────────────────────────────────────────────
  // Each screen has its own address: /ads, /ads-duplicates, /ads-analysis, /ads-setup (vercel.json
  // serves crm.html for them). Flat on purpose: crm.html's files are linked relative to the root.
  var PATHS = { 'meta-leads': '/ads', 'ml-dupes': '/ads-duplicates', 'ml-analysis': '/ads-analysis', 'ml-setup': '/ads-setup' };
  function viewOfPath(path) {
    var p = String(path || '').replace(/\/+$/, '');
    if (p === '/ads.html') return 'meta-leads';
    for (var v in PATHS) if (PATHS[v] === p) return v;
    return null;
  }
  window.metaLeadsPathView = viewOfPath;
  function syncPath(view) {
    var want = PATHS[view];
    if (!want || location.pathname === want) return;
    try {
      // Each screen is a page in the history, so Back goes to the one before. A ?nav= link (from
      // another console) only renames the address it arrived on.
      var url = want + location.hash;
      if (/[?&]nav=/.test(location.search)) history.replaceState({ ml: view }, '', url);
      else history.pushState({ ml: view }, '', url);
    } catch (e) { /* no history API */ }
  }
  // Back / Forward between the screens (or back out of them).
  window.addEventListener('popstate', function () {
    var v = viewOfPath(location.pathname);
    if (v && typeof toggleView === 'function') { S.fromPop = true; toggleView(v); S.fromPop = false; }
    else if (!v && el() && el().style.display !== 'none' && typeof toggleView === 'function') toggleView(typeof lastBrowseView === 'string' ? lastBrowseView : 'kanban');
  });
  // Opened at /ads… : handed to the CRM's own start-up as ?nav=<screen> (crm-assets/nav-boot.js
  // opens it once the page is ready — opening it here, earlier, raced the sign-in).
  (function () {
    var v = viewOfPath(location.pathname);
    if (v && !/[?&]nav=/.test(location.search)) {
      try { history.replaceState(history.state, '', location.pathname + (location.search ? location.search + '&' : '?') + 'nav=' + v + location.hash); } catch (e) { /* no history API */ }
    }
  })();

  window.renderMetaLeadsView = function (view) {
    S.view = view || 'meta-leads';
    if (!S.fromPop) syncPath(S.view);
    document.title = { 'meta-leads': 'Meta Ads Leads', 'ml-dupes': 'Duplicates · Meta Ads Leads', 'ml-analysis': 'Analysis · Meta Ads Leads', 'ml-setup': 'Setup · Meta Ads Leads' }[S.view] + ' — 3 PIN Realty';
    loadConfig();
    whenInventory();
    render();
  };
})();
