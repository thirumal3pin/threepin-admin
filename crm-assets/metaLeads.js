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
    f: { agent: '', rating: '', ad: '', tab: '', days: '', sort: 'new' }, sel: {}, edit: null, writing: false, stamp: true, workRow: {}, drafts: {}, dtab: 'overview', selMode: false, changed: {}, mods: {}, modCfg: {}, briefs: {}, bq: [], brun: {}, bDone: 0, bTotal: 0, layout: 'list', tsort: { key: '', dir: 1 }, tf: {},
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
      setTimeout(autoRead, 0);
    }).catch(function (e) { S.cfgError = e.message; })
      .then(function () { S.cfgLoading = false; render(); });
  }
  // Each sheet in its own call, three at a time — each answer stays small and quick however many
  // sheets are connected. → one combined answer, as a single read would have given.
  async function readEach(ids) {
    var out = { ok: true, tabs: [], errors: [], at: Date.now(), mods: {}, unchanged: [] }, i = 0;
    async function worker() {
      while (i < ids.length) {
        var id = ids[i++];
        try {
          // Skipped only when neither the sheet nor its mapping changed since its rows were read.
          var have = S.read && (S.read.tabs || []).some(function (t) { return t.sourceId === id; });
          var since = have && S.mods[id] && S.modCfg[id] === cfgSig(id) ? {} : null; if (since) since[id] = S.mods[id];
          var d = await api('read', { sourceId: id, since: since });
          out.tabs = out.tabs.concat(d.tabs || []); out.errors = out.errors.concat(d.errors || []); out.at = d.at || out.at;
          Object.keys(d.mods || {}).forEach(function (k) { out.mods[k] = d.mods[k]; S.modCfg[k] = cfgSig(k); });
          (d.unchanged || []).forEach(function (k) { out.unchanged.push(k); });
        }
        catch (e) { out.errors.push({ sourceId: id, title: (((S.cfg && S.cfg.sources) || []).find(function (x) { return x.id === id; }) || {}).title || id, error: e.message }); }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    // Not changed since the last read: the rows already here stand.
    if (S.read && out.unchanged.length) out.tabs = out.tabs.concat((S.read.tabs || []).filter(function (t) { return out.unchanged.indexOf(t.sourceId) >= 0; }));
    var order = ids;
    out.tabs.sort(function (a, b) { return order.indexOf(a.sourceId) - order.indexOf(b.sourceId); });
    return out;
  }
  // ─── Phone ─────────────────────────────────────────────────────────────
  // On a phone the screen works like a mobile CRM: compact rows, a lead opens as its own full
  // screen (Back closes it) with Call / WhatsApp / Take and tabs Overview · Update · Enquiries.
  function isPhone() { return !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches); }
  var wasPhone = null;
  window.addEventListener('resize', function () { var now = isPhone(); if (wasPhone !== null && now !== wasPhone && el() && el().style.display !== 'none') softRender(); wasPhone = now; });
  function initials(name) { var w = String(name || '?').replace(/^(dr|mr|mrs|ms)\.?\s+/i, '').trim().split(/\s+/); return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); }
  function avatar(p) {
    var h = 0, s = String(p.key || p.name || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return '<span class="ml-avt c' + (Math.abs(h) % 6) + '" aria-hidden="true">' + esc(initials(p.name)) + '</span>';
  }
  function relShort(t) {
    if (!t) return '';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return Math.max(1, m) + 'm';
    if (m < 24 * 60) return Math.round(m / 60) + 'h';
    if (m < 7 * 24 * 60) return Math.round(m / 1440) + 'd';
    return shortWhen(t).split(',')[0];
  }
  // The lead, opened: a side panel on a computer; its own screen on a phone.
  function drawerHtml(p) {
    if (!p) return '';
    var k = js(p.key), wa = waLink(p), phone = isPhone();
    var take = !p.team.assignedRaw && canTake() && p.enquiries.some(function (e) { return e.metaId; });
    var acts = '<div class="ml-dacts">' +
      (p.phoneOk ? '<a class="ml-dact" href="tel:+' + esc(p.phoneKey) + '"><i class="fa-solid fa-phone"></i><span>Call</span></a>' : '') +
      (wa ? '<a class="ml-dact wa" href="' + esc(wa) + '" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i><span>WhatsApp</span></a>' : '') +
      (take ? '<button class="ml-dact take" onclick="MetaLeads.take(' + k + ')"' + (S.writing ? ' disabled' : '') + '><i class="fa-regular fa-hand"></i><span>Take</span></button>' : '') +
      (p.crm ? '<button class="ml-dact" onclick="MetaLeads.openLead(' + js(p.crm.id) + ')"><i class="fa-solid fa-arrow-up-right-from-square"></i><span>In CRM</span></button>' : '') + '</div>';
    var tabs = '<div class="ml-dtabs" role="tablist">' + [['overview', 'Overview'], ['update', 'Update'], ['history', 'Enquiries ' + p.enquiries.length]].map(function (t) {
      return '<button role="tab" aria-selected="' + (S.dtab === t[0]) + '" class="' + (S.dtab === t[0] ? 'on' : '') + '" onclick="MetaLeads.dtab(\'' + t[0] + '\')">' + esc(t[1]) + '</button>';
    }).join('') + '</div>';
    var who = p.team.agent ? agentLabel(p.team.agent) : p.team.assignedRaw;
    return '<div class="ml-drawer-bg" onclick="MetaLeads.closeLead()"></div><aside class="ml-drawer' + (phone ? ' full' : '') + '" role="dialog" aria-label="' + esc(p.name || 'Lead') + '">' +
      '<div class="ml-drawer-h">' + (phone ? '<button class="ml-back" onclick="MetaLeads.closeLead()" aria-label="Back to the leads"><i class="fa-solid fa-chevron-left"></i></button>' : '') +
        '<div class="ml-dh-who">' + (phone ? avatar(p) : '') + '<div class="ml-dh-t"><div class="ml-name">' + esc(p.name || '(no name)') + '</div>' +
        '<div class="ml-dim">' + esc(p.phone ? MM().displayPhone(p.phone) : 'no phone') + ' · ' + esc(p.properties.join(', ')) + (phone && who ? ' · ' + esc(who) : '') + '</div></div></div>' +
        (phone ? '' : '<button class="ml-icon" title="Close (Esc)" onclick="MetaLeads.closeLead()">✕</button>') + '</div>' +
      (phone ? acts + tabs : '') +
      '<div class="ml-person open">' + detailHtml(p) + '</div></aside>';
  }

  // Each person's rows as read (their enquiries and the team's cells): to tell what a refresh changed.
  function rowSigs() {
    var out = {};
    (S.plan ? S.plan.people : []).forEach(function (p) {
      out[p.key] = hashStr(JSON.stringify(p.enquiries.map(function (e) { var t = e.team; return [e.metaId || e.row, e.propertyCode, t.assigned, t.ratingRaw, t.remarks, t.followups, t.notes]; })));
    });
    return out;
  }
  // A sheet's mapping as set up (tabs on, properties, columns): read again when it changes.
  function cfgSig(id) { var src = ((S.cfg && S.cfg.sources) || []).find(function (x) { return x.id === id; }); return src ? JSON.stringify([src.on, src.propertyCode, src.tabs]) : ''; }
  function readSheets(quiet) {
    if (S.reading) return;
    var ids = ((S.cfg && S.cfg.sources) || []).filter(function (x) { return x.on !== false; }).map(function (x) { return x.id; });
    S.reading = true; S.readError = null; render();
    var before = S.plan ? rowSigs() : null;
    (ids.length ? readEach(ids) : api('read')).then(function (d) {
      S.read = d; S.shown = PAGE;
      Object.keys(d.mods || {}).forEach(function (k) { S.mods[k] = d.mods[k]; });
      replan();
      if (S.open && !S.plan.people.some(function (x) { return x.key === S.open; })) S.open = null;
      // What came in or changed since the last refresh — marked until the next one.
      var news = 0, upd = 0;
      if (before) {
        S.changed = {};
        var after = rowSigs();
        Object.keys(after).forEach(function (k) { if (!before[k]) { S.changed[k] = 'new'; news++; } else if (before[k] !== after[k]) { S.changed[k] = 'updated'; upd++; } });
      }
      var same = (d.unchanged || []).length;
      if (S.cfg) S.cfg.lastRead = { at: d.at, by: (window.crmAuth && window.crmAuth.email) || '', sheets: [] };
      loadConfig(true);
      if (d.errors && d.errors.length) toast('Read, with ' + d.errors.length + ' sheet problem' + (d.errors.length > 1 ? 's' : ''));
      else if (before && (news || upd)) toast((news ? news + ' new lead' + (news > 1 ? 's' : '') : '') + (news && upd ? ', ' : '') + (upd ? upd + ' updated' : '') + (same ? ' · ' + same + ' sheet' + (same > 1 ? 's' : '') + ' unchanged, not read again' : ''));
      else if (before && !quiet) toast('No changes since the last refresh' + (same ? ' — ' + same + ' sheet' + (same > 1 ? 's' : '') + ' not read again' : ''));
      else if (!quiet) toast('Sheets read');
      agentDefault();
      loadBriefs();
    }).catch(function (e) { S.readError = e.message; })
      .then(function () { S.reading = false; render(); });
  }
  // ─── The AI brief: stage, next step and when, what they want, objections ──
  // Read by the CRM's own lead AI on the server (api/_meta-leads-brief.js) from the ad forms, the
  // sheet's notes and — for a CRM lead — its notes and chat. Stored; asked again only when what the
  // page would send has changed (sig), or the CRM lead moved since.
  var STAGE_NAME = {}, LOST_NAME = {}, HOLD_NAME = {};
  function names() {
    if (STAGE_NAME.new || !MM() || !MM().STAGE_DEFS) return;
    MM().STAGE_DEFS.forEach(function (d) { STAGE_NAME[d.key] = d.name; });
    LOST_NAME = MM().LOST_REASONS || {}; HOLD_NAME = MM().HOLD_REASONS || {};
  }
  function hashStr(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function briefInput(p) {
    var rows = p.enquiries.map(function (e) {
      var t = e.team;
      return { at: e.at || 0, code: e.propertyCode, where: String(e.where.sheetTitle || '').trim() + ' › ' + e.where.tab, tag: e.where.tag || '', tabNote: e.where.remark || '',
        ad: e.ad || '', platform: { ig: 'Instagram', fb: 'Facebook' }[e.platform] || e.platform || '', form: e.form || '',
        answers: e.answers.map(function (a) { return [a.label, a.value]; }), assigned: t.assigned || '', rating: t.ratingRaw || '',
        notes: t.remarks.concat(t.followups, t.notes).map(function (n) { return [n.label, n.text]; }) };
    });
    var body = { k: p.key, name: p.name || '', crmId: p.crm ? p.crm.id : '', props: p.properties.map(function (c) { return { code: c, name: propName(c) || '' }; }), rows: rows };
    body.sig = hashStr(JSON.stringify(body) + '|' + (p.crm ? (p.crm.updatedAt || 0) : ''));
    return body;
  }
  function briefStale(p, b) {
    if (!b) return true;
    if (b.sig !== briefInput(p).sig) return true;
    if (b.err && Date.now() - (b.errAt || 0) > 5 * 60000) return true;
    return false;
  }
  function loadBriefs() {
    api('briefs').then(function (d) { S.briefs = d.briefs || {}; softRender(); }).catch(function () { /* the list works without */ });
  }
  // Cost (the owner's rule, 7 Nov 2026): a brief is read when someone asks for it (Get AI brief /
  // Refresh brief), or on its own only for a lead that already has one, has changed since, and
  // whose brief is at least a day old — never every lead, never in the background.
  function maybeAutoBrief(p) {
    var b = p && S.briefs[p.key];
    if (b && b.v && !b.err && briefStale(p, b) && Date.now() - (b.at || 0) >= DAY_MS) queueBriefs(p.key);
  }
  function queueBriefs(first) {
    if (!S.plan || !first) return;
    var fp = S.plan.people.find(function (x) { return x.key === first; });
    if (!fp || S.brun[first] || S.bq.indexOf(first) >= 0 || !briefStale(fp, S.briefs[first])) return;
    var want = [first];
    if (!S.bq.length && !Object.keys(S.brun).length) { S.bDone = 0; S.bTotal = 0; }
    S.bq = S.bq.concat(want.filter(function (k) { return S.bq.indexOf(k) < 0; }));
    S.bTotal = S.bDone + S.bq.length + Object.keys(S.brun).length;
    pumpBriefs();
  }
  function pumpBriefs(force) {
    while (Object.keys(S.brun).length < 2 && S.bq.length) (function (key) {
      var p = S.plan && S.plan.people.find(function (x) { return x.key === key; });
      if (!p) return;
      S.brun[key] = 1;
      api('brief', { person: briefInput(p) }).then(function (d) {
        if (d.brief) S.briefs[key] = d.brief;
        if (d.capped) { S.bq = []; S.bCapped = d.error; toast(d.error); }
      })
        .catch(function (e) { S.briefs[key] = Object.assign({}, S.briefs[key] || {}, { k: key, sig: briefInput(p).sig, err: e.message, errAt: Date.now() }); })
        .then(function () { delete S.brun[key]; S.bDone++; softRender(); pumpBriefs(); });
    })(S.bq.shift());
    if (!S.bq.length && !Object.keys(S.brun).length) softRender();
  }
  // A redraw never under someone's fingers: while a field here has the focus it waits for the blur.
  function fieldFocused() { var a = document.activeElement; return !!(a && el() && el().contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); }
  function softRender() { if (fieldFocused()) { S.needRender = true; return; } S.needRender = false; render(); }
  document.addEventListener('focusout', function () { setTimeout(function () { if (S.needRender && !fieldFocused()) { S.needRender = false; render(); } }, 60); });

  // When is the next thing due, and what is it — from the brief.
  var IST = 5.5 * 3600000;
  function istDay(t) { return Math.floor((t + IST) / 86400000); }
  function whenText(t) {
    var d = istDay(t) - istDay(Date.now());
    var time = new Date(t + IST), hh = time.getUTCHours(), mm = time.getUTCMinutes();
    var clock = (hh % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (hh < 12 ? ' am' : ' pm');
    var showClock = !(hh === 10 && mm === 0) && !(hh === 0 && mm === 0);
    var day = d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getUTCDay()] + ' ' + time.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][time.getUTCMonth()];
    return day + (showClock ? ' ' + clock : '');
  }
  // → { state: 'lost'|'hold'|'overdue'|'today'|'later'|'todo'|'waiting'|'none', at, text, action }
  function nextOf(p) {
    var b = S.briefs[p.key], v = b && b.v;
    if (!v) return null;
    if (v.stage === 'lost') return { state: 'lost', text: 'Lost · ' + (LOST_NAME[v.lostReason] || 'not interested'), action: '' };
    if (v.stage === 'on_hold') return { state: 'hold', at: v.holdUntil, text: 'On hold' + (v.holdUntil ? ' till ' + whenText(v.holdUntil) : ''), action: v.next.action || '' };
    var at = v.next.dueAt || (v.visit && v.visit.status === 'scheduled' && v.visit.at) || null;
    if (v.next.owner === 'team' && at) {
      var d = istDay(at) - istDay(Date.now());
      return { state: d < 0 ? 'overdue' : d === 0 ? 'today' : 'later', at: at, text: (d < 0 ? 'Overdue · ' : '') + whenText(at), action: v.next.action || '' };
    }
    if (v.next.owner === 'team') return { state: 'todo', text: 'To do', action: v.next.action || '' };
    if (v.next.owner === 'lead') return { state: 'waiting', text: 'Waiting for them', action: v.next.action || '' };
    return { state: 'none', text: '', action: '' };
  }
  function isDue(p) { var n = nextOf(p); return !!n && (n.state === 'overdue' || n.state === 'today'); }
  function dueChip(p) {
    var n = nextOf(p);
    if (!n || !n.text || n.state === 'none') return '';
    var cls = { lost: 'bad', overdue: 'bad', today: 'warn', hold: '', later: 'info', todo: 'info', waiting: '' }[n.state] || '';
    var icon = { lost: 'fa-circle-xmark', hold: 'fa-pause', waiting: 'fa-hourglass-half' }[n.state] || 'fa-phone';
    return '<span class="ml-badge ml-due ' + cls + '" title="' + esc(n.action || n.text) + '"><i class="fa-solid ' + icon + '"></i> ' + esc(n.text) + '</span>';
  }
  function money(n) { return n >= 1e7 ? '₹' + (Math.round(n / 1e5) / 100) + ' Cr' : n >= 1e5 ? '₹' + (Math.round(n / 1e3) / 100) + ' L' : n >= 1e3 ? '₹' + Math.round(n / 1e3) + 'k' : '₹' + n; }
  function wantChips(w) {
    if (!w) return '';
    var c = [];
    if (w.deal && w.deal !== 'unknown') c.push({ buy: 'Buy', rent: 'Rent', lease: 'Lease', either: 'Buy or rent' }[w.deal]);
    if (w.budget_min || w.budget_max) c.push((w.budget_min && w.budget_max ? money(w.budget_min) + '–' + money(w.budget_max) : money(w.budget_max || w.budget_min)) + ({ per_month: ' / month', lease_amount: ' lease' }[w.budget_unit] || ''));
    if (w.size_sqft_min) c.push(w.size_sqft_min.toLocaleString('en-IN') + '+ sq. ft.');
    (w.bhk || []).forEach(function (n) { c.push(n + ' BHK'); });
    (w.types || []).forEach(function (t) { c.push({ apartment: 'Apartment', villa: 'Villa', independent_house: 'Independent house', plot: 'Plot', commercial: 'Commercial' }[t] || t); });
    (w.areas || []).forEach(function (a) { c.push(a); });
    if (w.ready_by) c.push(w.ready_by === 'immediate' ? 'Needs it now' : 'By ' + w.ready_by);
    (w.must_have || []).forEach(function (a) { c.push(a); });
    var out = c.length ? '<div class="ml-bk"><span class="ml-bk-l">Looking for</span><div class="ml-bk-c">' + c.map(function (x) { return '<span class="ml-want">' + esc(x) + '</span>'; }).join('') + '</div></div>' : '';
    if ((w.deal_breakers || []).length) out += '<div class="ml-bk"><span class="ml-bk-l">Ruled out</span><div class="ml-bk-c">' + w.deal_breakers.map(function (x) { return '<span class="ml-want no">' + esc(x) + '</span>'; }).join('') + '</div></div>';
    return out;
  }
  function briefHtml(p) {
    names();
    var b = S.briefs[p.key], v = b && b.v, busy = !!S.brun[p.key] || S.bq.indexOf(p.key) >= 0;
    var k = js(p.key);
    var head = '<div class="ml-brief-h"><span class="ml-brief-t"><i class="fa-solid fa-wand-magic-sparkles"></i> Before you call</span>' +
      (v ? '<span class="ml-stage s-' + esc(v.stage) + '">' + esc(STAGE_NAME[v.stage] || v.stage) + '</span>' + (v.urgency === 'high' ? '<span class="ml-badge bad">Urgent</span>' : '') : '') +
      '<span class="ml-brief-r">' + (busy ? '<span class="ml-dim"><i class="fa-solid fa-rotate fa-spin"></i> Reading…</span>' : (b && b.at ? '<span class="ml-dim">AI · ' + esc(timeAgoSafe(b.at)) + '</span>' : '')) +
      '</span></div>';
    if (!v) {
      return '<div class="ml-brief empty">' + head + (busy ? '<div class="ml-dim">Reading the enquiries, the sheet’s notes' + (p.crm ? ', and the CRM notes and chat' : '') + '…</div>' :
        '<div class="ml-brief-get"><div class="ml-dim">' + (b && b.err ? 'Could not read: ' + esc(b.err) : 'The stage, when to call and what to say, what they want — read by the AI from the form, the sheet’s notes' + (p.crm ? ' and the CRM' : '') + '.') + '</div>' +
        '<button class="ml-btn sm" onclick="MetaLeads.brief(' + k + ')"><i class="fa-solid fa-wand-magic-sparkles"></i> Get AI brief</button></div>') + '</div>';
    }
    var stale = !busy && briefStale(p, b);
    var n = nextOf(p) || {};
    var nextLine = '';
    if (n.state === 'lost') nextLine = '<div class="ml-next lost"><b>' + esc(n.text) + '</b>' + (v.evidence ? '<div>' + esc(v.evidence) + '</div>' : '') + '</div>';
    else if (n.state === 'hold') nextLine = '<div class="ml-next hold"><b>' + esc(n.text) + '</b> — ' + esc(HOLD_NAME[v.holdReason] || 'paused by them') + (n.action ? '<div>' + esc(n.action) + '</div>' : '') + '</div>';
    else if (n.action) nextLine = '<div class="ml-next ' + esc(n.state) + '"><span class="ml-next-w">' + esc(n.state === 'waiting' ? 'Waiting for them' : n.at ? n.text.replace('Overdue · ', 'Overdue — ') : 'Next') + '</span><b>' + esc(n.action) + '</b></div>';
    var visit = v.visit && v.visit.status !== 'none' ? '<div class="ml-bk"><span class="ml-bk-l">Visit</span><div class="ml-bk-c">' + esc({ requested: 'Asked for', scheduled: 'Fixed', done: 'Done', cancelled: 'Cancelled' }[v.visit.status] || v.visit.status) + (v.visit.at ? ' · ' + esc(whenText(v.visit.at)) : '') + (v.visit.property ? ' · ' + esc(v.visit.property) : '') + '</div></div>' : '';
    var src = b.src || {};
    var from = [src.rows ? src.rows + ' enquir' + (src.rows > 1 ? 'ies' : 'y') : '', src.notes ? src.notes + ' sheet note' + (src.notes > 1 ? 's' : '') : 'no sheet notes',
      src.crm ? 'CRM: ' + src.crmNotes + ' note' + (src.crmNotes === 1 ? '' : 's') + (src.chat ? ', ' + src.chat + ' chat messages' : '') : ''].filter(Boolean).join(' · ');
    return '<div class="ml-brief">' + head +
      (stale ? '<div class="ml-brief-stale"><span><i class="fa-solid fa-circle-exclamation"></i> The notes changed since this brief.</span><button class="ml-btn sm" onclick="MetaLeads.brief(' + k + ')"><i class="fa-solid fa-rotate-right"></i> Refresh brief</button></div>' : '') +
      (v.line ? '<div class="ml-brief-line">' + esc(v.line) + '</div>' : '') + nextLine + visit + wantChips(v.want) +
      (v.evidence && n.state !== 'lost' ? '<div class="ml-evid">“' + esc(v.evidence) + '”</div>' : '') +
      '<div class="ml-brief-f">Read from ' + esc(from) + '. The AI can be wrong — check the notes.' + (b.err ? ' <span class="ml-bad">Last refresh failed: ' + esc(b.err) + '</span>' : '') + '</div></div>';
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
    return '<div class="ml-head"><div class="ml-head-l"><h2 class="ml-title"><i class="fa-brands fa-meta"></i> Meta Ads Leads</h2>' +
      '<div class="ml-sub">From the Google Sheets your Meta ads fill</div></div>' +
      '<div class="ml-head-r">' + (S.bTotal && S.bDone < S.bTotal ? '<span class="ml-last"><i class="fa-solid fa-wand-magic-sparkles"></i> AI reading leads ' + S.bDone + ' / ' + S.bTotal + '</span>' : '') + '<span class="ml-last">' + esc(last) + '</span>' +
      '<button class="ml-btn ml-read' + (S.read ? '' : ' primary') + '" ' + (S.reading ? 'disabled' : '') + ' onclick="MetaLeads.read()"><i class="fa-solid fa-rotate' + (S.reading ? ' fa-spin' : '') + '"></i> ' + '<span class="ml-hide-s">' + (S.reading ? 'Reading…' : (S.read ? 'Refresh' : 'Read the sheets')) + '</span></button></div></div>' +
      '<div class="ml-test"><i class="fa-solid fa-circle-info"></i> <span>Edits here are <b>written to the Google Sheet</b>. Nothing is added to the CRM yet.</span></div>' +
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
  var FILTERS = [['all', 'All'], ['changed', 'New or updated'], ['due', 'Follow-up due'], ['priority', 'Priority for the agent'], ['uncontacted', 'Not contacted yet'], ['create', 'New to the CRM'], ['crm', 'Already in the CRM'], ['repeat', 'Duplicates'], ['multi', 'More than one property'], ['problems', 'Problems']];
  var SORTS = [['next', 'What to do next'], ['new', 'Newest enquiry first'], ['old', 'Oldest enquiry first'], ['untouched', 'Not contacted first (oldest waiting)'], ['hot', 'Highest rating first'], ['name', 'Name A–Z']];
  var DAY_MS = 86400000;
  // A lead nobody has written on for this long is flagged — a Meta lead goes cold within a day.
  var SLA_MS = 24 * 3600000;
  var FKEY = 'ml.filters';
  function saveF() { try { localStorage.setItem(FKEY, JSON.stringify({ f: S.f, by: me(), layout: S.layout, tsort: S.tsort })); } catch (e) { /* no storage */ } }
  (function loadF() { try { var x = JSON.parse(localStorage.getItem(FKEY) || 'null'); if (x && x.f) { S.f = Object.assign(S.f, x.f); S.fRestored = true; } if (x && x.layout) S.layout = x.layout; if (x && x.tsort) S.tsort = x.tsort; } catch (e) { /* none */ } })();
  function agentDefault() {
    if (S.agentDefaulted || S.fRestored || !S.plan || !S.cfg || S.cfg.manager) return;
    S.agentDefaulted = true;
    if (S.plan.people.some(function (p) { return p.team.agent === me(); })) { S.f.agent = '_mine'; S.f.sort = 'next'; }
  }
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
    if (f === 'due' && !isDue(p)) return false;
    if (f === 'changed' && !S.changed[p.key]) return false;
    if (f === 'problems' && !p.issues.length) return false;
    if (F.agent === '_mine' && p.team.agent !== me()) return false;
    if (F.agent === '_none' && p.team.assignedRaw) return false;
    if (F.agent && F.agent[0] !== '_' && p.team.agent !== F.agent && p.team.assignedRaw !== F.agent) return false;
    if (F.rating === 'none' && p.team.rating) return false;
    if (F.rating === '4+' && !(p.team.rating >= 4)) return false;
    if (F.rating && F.rating !== 'none' && F.rating !== '4+' && String(p.team.rating) !== F.rating) return false;
    var rows = rowsFor(p, S.prop);
    if (F.ad && !rows.some(function (e) { return (e.ad || '') === F.ad; })) return false;
    if (F.tab && !rows.some(function (e) { return e.where.spreadsheetId + ':' + e.where.gid === F.tab; })) return false;
    if (F.days && !rows.some(function (e) { return e.at && e.at > Date.now() - Number(F.days) * DAY_MS; })) return false;
    var q = S.q.trim().toLowerCase();
    if (q) {
      var bv = S.briefs[p.key] && S.briefs[p.key].v;
      var hay = [p.name, p.phone, p.email, p.team.assignedRaw, p.crm && p.crm.name, bv && bv.line, bv && bv.next && bv.next.action].concat(p.team.notes.map(function (n) { return n.text; })).join(' ').toLowerCase();
      if (hay.indexOf(q) < 0 && String(p.phoneKey).indexOf(q.replace(/\D/g, '') || '§') < 0) return false;
    }
    return true;
  }
  function sorted(list) {
    var by = S.f.sort, out = list.slice();
    if (by === 'next') {
      // Due today or overdue (earliest first) → never contacted (longest waiting) → due later →
      // ours to do → waiting for them → on hold → lost.
      var rank = function (p) {
        var n = nextOf(p);
        if (n && (n.state === 'overdue' || n.state === 'today')) return [0, n.at];
        if (!p.team.contacted) return [1, firstAtFor(p) || 0];
        if (!n) return [3, -lastAtFor(p)];
        return [{ later: 2, todo: 3, waiting: 4, none: 4, hold: 5, lost: 6 }[n.state], n.at || -lastAtFor(p)];
      };
      out.sort(function (a, b) { var x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; });
      return out;
    }
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
    // My leads / Unassigned: the counts are of those leads only (an unassigned lead is never in "mine").
    if (S.f.agent === '_mine' || S.f.agent === '_none') {
      var c = code === 'all' ? '' : code;
      var ppl = peopleFor(S.prop).filter(function (x) { return S.f.agent === '_mine' ? x.team.agent === me() : !x.team.assignedRaw; });
      var enq = ppl.reduce(function (n, x) { return n + rowsFor(x, S.prop).length; }, 0);
      var notYet = ppl.filter(function (x) { return !x.team.contacted; }).length;
      var lateN = ppl.filter(function (x) { return !x.team.contacted && firstAtFor(x) && Date.now() - firstAtFor(x) > SLA_MS; }).length;
      var pri = ppl.filter(function (x) { return MM().isPriorityFor(x, c); }).length;
      return '<div class="ml-tiles">' +
        t(ppl.length, (S.f.agent === '_mine' ? 'Assigned to me' : 'Not assigned') + ' (' + enq + ' enquiries)', '', "MetaLeads.filter('all')") +
        t(lateN, 'Not contacted for over a day', lateN ? 'bad' : '', "MetaLeads.lateFirst()") +
        t(notYet, 'Not contacted yet', notYet ? 'warn' : '', "MetaLeads.filter('uncontacted')") +
        t(ppl.filter(isDue).length, 'Follow-ups due today', ppl.filter(isDue).length ? 'warn' : '', "MetaLeads.filter('due')") +
        t(ppl.filter(function (x) { return x.team.rating >= 4; }).length, 'Rated 4–5', '', "MetaLeads.setF('rating','4+')") +
        t(pri, 'Revisited — priority', pri ? 'warn' : '', "MetaLeads.filter('priority')") +
        t(ppl.filter(function (x) { return x.crm; }).length, 'Already in the CRM', '', "MetaLeads.filter('crm')") +
        t(ppl.filter(function (x) { return x.action === 'create'; }).length, 'Would be new CRM leads', '', "MetaLeads.filter('create')") + '</div>';
    }
    return '<div class="ml-tiles">' +
      t(a.people, 'People (' + a.enquiries + ' enquiries)', '', "MetaLeads.filter('all')") +
      t(peopleFor(S.prop).filter(isDue).length, 'Follow-ups due today', peopleFor(S.prop).filter(isDue).length ? 'warn' : '', "MetaLeads.filter('due')") +
      t(a.people - a.assigned, 'Not assigned', a.people - a.assigned ? 'warn' : '', "MetaLeads.setF('agent','_none')") +
      t(late, 'Not contacted for over a day', late ? 'bad' : '', "MetaLeads.lateFirst()") +
      t(a.ratings[5] + a.ratings[4], 'Rated 4–5', '', "MetaLeads.setF('rating','4+')") +
      t(a.priority, 'Revisited — priority', a.priority ? 'warn' : '', "MetaLeads.filter('priority')") +
      t(a.inCrm, 'Already in the CRM', '', "MetaLeads.filter('crm')") +
      t(create, 'Would be new CRM leads', '', "MetaLeads.filter('create')") + '</div>';
  }
  // My leads / Unassigned (to take) / All — the first thing an agent picks.
  function canTake() { var m = me(); return !!m && roster().indexOf(m) >= 0; }
  function mineSwitch() {
    var scope = peopleFor(S.prop), F = S.f;
    var mine = scope.filter(function (x) { return x.team.agent === me(); }).length;
    var none = scope.filter(function (x) { return !x.team.assignedRaw; }).length;
    var b = function (v, label, n, hint) {
      return '<button class="' + (F.agent === v ? 'on' : '') + '" title="' + esc(hint) + '" onclick="MetaLeads.setF(\'agent\',' + js(v) + ')">' + label + ' <span class="ml-n">' + n + '</span></button>';
    };
    return '<div class="ml-sw" role="group" aria-label="Whose leads">' +
      b('_mine', '<i class="fa-regular fa-user"></i> My leads', mine, 'Leads assigned to you') +
      b('_none', '<i class="fa-regular fa-hand"></i> Unassigned', none, 'Nobody has these yet — take one') +
      b('', 'All', scope.length, 'Everyone') + '</div>';
  }
  function selectHtml(key, value, options) {
    return '<select class="ml-f' + (key === 'sort' ? ' ml-sort' : ' fsel' + (value ? ' set' : '')) + '" aria-label="' + esc(key) + '" onchange="MetaLeads.setF(' + js(key) + ',this.value)">' + options.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select>';
  }
  function toolbar() {
    var F = S.f, scope = peopleFor(S.prop);
    var ads = {}, tabs = {};
    scope.forEach(function (p) { rowsFor(p, S.prop).forEach(function (e) { if (e.ad) ads[e.ad] = 1; tabs[e.where.spreadsheetId + ':' + e.where.gid] = String(e.where.sheetTitle).trim() + ' › ' + e.where.tab; }); });
    var agentOpts = [['', 'Every agent'], ['_mine', 'Assigned to me'], ['_none', 'Not assigned']].concat(roster().map(function (e) { return [e, agentLabel(e)]; }));
    var any = F.agent || F.rating || F.ad || F.tab || F.days || S.q || S.filter !== 'all';
    // The switch (My leads / Unassigned) is not counted as a filter here — it is on screen already.
    var nSet = ['agent', 'rating', 'ad', 'tab', 'days'].filter(function (k) { return F[k] && !(k === 'agent' && (F[k] === '_mine' || F[k] === '_none')); }).length;
    return '<div class="ml-tools' + (S.fOpen ? ' open' : '') + '">' +
      '<button class="ml-btn sm ml-fbtn" onclick="MetaLeads.fOpen()"><i class="fa-solid fa-sliders"></i> Filters' + (nSet ? ' <span class="ml-fn">' + nSet + '</span>' : '') + '</button>' +
      selectHtml('agent', F.agent, agentOpts) +
      selectHtml('rating', F.rating, [['', 'Any rating'], ['4+', 'Rated 4 and above'], ['5', 'Rating 5'], ['4', 'Rating 4'], ['3', 'Rating 3'], ['2', 'Rating 2'], ['1', 'Rating 1'], ['none', 'Not rated']]) +
      selectHtml('ad', F.ad, [['', 'Every ad']].concat(Object.keys(ads).sort().map(function (x) { return [x, x]; }))) +
      selectHtml('tab', F.tab, [['', 'Every sheet tab']].concat(Object.keys(tabs).map(function (k) { return [k, tabs[k]]; }))) +
      selectHtml('days', F.days, [['', 'Any date'], ['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days']]) +
      '<span class="ml-tools-sep"></span>' +
      selectHtml('sort', F.sort, SORTS) +
      (any ? '<button class="ml-link" onclick="MetaLeads.clearF()">Clear filters</button>' : '') +
      '<button class="ml-btn sm" onclick="MetaLeads.csv()" title="Download the people shown as a spreadsheet"><i class="fa-solid fa-download"></i><span class="ml-hide-s"> CSV</span></button>' +
    '</div>';
  }
  function bulkBar(list) {
    var keys = Object.keys(S.sel).filter(function (k) { return S.sel[k]; });
    var all = list.length && list.every(function (p) { return S.sel[p.key]; });
    var head = '<label class="ml-selall"><input type="checkbox" ' + (all ? 'checked' : '') + ' onchange="MetaLeads.selAll(this.checked)"> ' + (keys.length ? keys.length + ' selected' : 'Select all ' + list.length) + '</label>';
    var sm = '<button class="ml-link ml-selbtn" onclick="MetaLeads.selMode()">' + (S.selMode ? 'Done' : 'Select') + '</button>';
    if (!keys.length) return '<div class="ml-bulk">' + head + sm + '</div>';
    var opts = '<option value="">Assign to…</option>' + roster().map(function (e) { return '<option value="' + esc(e) + '">' + esc(agentLabel(e)) + '</option>'; }).join('') + '<option value="_none">— Not assigned —</option>';
    return '<div class="ml-bulk on">' + head +
      '<select class="ml-f" ' + (S.writing ? 'disabled' : '') + ' onchange="if(this.value)MetaLeads.bulkAssign(this.value)">' + opts + '</select>' +
      '<select class="ml-f" ' + (S.writing ? 'disabled' : '') + ' onchange="if(this.value)MetaLeads.bulkRate(this.value)"><option value="">Set rating…</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select>' +
      (canTake() ? '<button class="ml-btn sm" ' + (S.writing ? 'disabled' : '') + ' onclick="MetaLeads.bulkAssign(' + js(me()) + ')">Assign to me</button>' : '') +
      '<button class="ml-link" onclick="MetaLeads.selNone()">Clear selection</button>' +
      (S.writing ? '<span class="ml-dim"><i class="fa-solid fa-rotate fa-spin"></i> Writing to the sheet…</span>' : '<span class="ml-dim">Written to each lead’s row in its sheet' + (S.prop === 'all' ? '' : ' (' + esc(S.prop) + ' rows)') + '.</span>') +
    '</div>';
  }
  // ─── The table: the sheet's own columns, sortable and filterable ──────────
  function textsOf(p, role) {
    var out = [];
    rowsFor(p, S.prop).forEach(function (e) {
      [e.team].concat((e.alsoIn || []).map(function (a) { return a.team; })).forEach(function (t) {
        var list = role === 'remarks' ? t.remarks.concat(t.notes) : t.followups;
        list.forEach(function (n) { if (out.indexOf(n.text) < 0) out.push(n.text); });
      });
    });
    return out;
  }
  var TCOLS = [
    { key: 'name', label: 'Name', get: function (p) { return p.name || ''; } },
    { key: 'phone', label: 'Phone', get: function (p) { return p.phone ? MM().displayPhone(p.phone) : ''; } },
    { key: 'prop', label: 'Property', get: function (p) { return p.properties.join(' '); } },
    { key: 'at', label: 'Enquired', get: function (p) { return MM().fmtWhen(lastAtFor(p)); }, sort: function (p) { return lastAtFor(p); }, nofilter: true },
    { key: 'ad', label: 'Ad', get: function (p) { return Array.from(new Set(rowsFor(p, S.prop).map(function (e) { return e.ad; }).filter(Boolean))).join(', '); } },
    { key: 'agent', label: 'Assigned to', get: function (p) { return p.team.agent ? agentLabel(p.team.agent) : (p.team.assignedRaw || ''); }, pick: true },
    { key: 'rating', label: 'Rating', get: function (p) { return p.team.rating ? String(p.team.rating) : ''; }, sort: function (p) { return p.team.rating || 0; }, pick: ['5', '4', '3', '2', '1', '—'] },
    { key: 'remarks', label: 'Remarks (in the sheet)', get: function (p) { return textsOf(p, 'remarks').join(' · '); }, wide: true },
    { key: 'fu', label: 'Follow-ups', get: function (p) { return textsOf(p, 'followups').join(' · '); }, wide: true },
    { key: 'done', label: 'Contacted', get: function (p) { return p.team.contacted ? 'Yes' : 'Not yet'; }, pick: ['Yes', 'Not yet'] },
    { key: 'crm', label: 'CRM', get: function (p) { return p.crm ? (p.crm.stage || 'In CRM') : ''; } }
  ];
  function tableRows(list) {
    var tf = S.tf;
    var out = list.filter(function (p) {
      return TCOLS.every(function (c) {
        var want = String(tf[c.key] || '').trim().toLowerCase();
        if (!want) return true;
        var v = String(c.get(p) || '').toLowerCase();
        if (want === '—') return !v;
        return c.pick ? v === want : v.indexOf(want) >= 0;
      });
    });
    var col = TCOLS.find(function (c) { return c.key === S.tsort.key; });
    if (col) {
      var val = col.sort || function (p) { return String(col.get(p) || '').toLowerCase(); };
      out.sort(function (a, b) {
        var x = val(a), y = val(b);
        // Blanks always last, whichever way.
        var ex = x === '' || x === 0, ey = y === '' || y === 0;
        if (ex !== ey) return ex ? 1 : -1;
        return (x > y ? 1 : x < y ? -1 : 0) * S.tsort.dir;
      });
    }
    return out;
  }
  function tableHtml(list) {
    var rows = tableRows(list);
    var head = '<tr><th class="ml-tsel"></th>' + TCOLS.map(function (c) {
      var on = S.tsort.key === c.key;
      return '<th class="' + (c.wide ? 'wide' : '') + '"><button class="ml-th' + (on ? ' on' : '') + '" onclick="MetaLeads.tsort(' + js(c.key) + ')">' + esc(c.label) + (on ? (S.tsort.dir > 0 ? ' ▲' : ' ▼') : '') + '</button></th>';
    }).join('') + '</tr>';
    var agents = Array.from(new Set(list.map(function (p) { return TCOLS[5].get(p); }).filter(Boolean))).sort();
    var filt = '<tr class="ml-tfilt"><th></th>' + TCOLS.map(function (c) {
      if (c.nofilter) return '<th></th>';
      var v = S.tf[c.key] || '';
      if (c.pick) {
        var opts = (c.pick === true ? agents.concat(['—']) : c.pick);
        return '<th><select onchange="MetaLeads.tf(' + js(c.key) + ',this.value)"><option value="">All</option>' + opts.map(function (o) { return '<option' + (v === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select></th>';
      }
      return '<th><input type="search" placeholder="Filter" value="' + esc(v) + '" oninput="MetaLeads.tfType(' + js(c.key) + ',this.value)"></th>';
    }).join('') + '</tr>';
    var body = rows.slice(0, S.shown).map(function (p) {
      var open = S.open === p.key;
      return '<tr class="ml-tr' + (open ? ' open' : '') + (S.sel[p.key] ? ' sel' : '') + (p.team.contacted ? '' : ' fresh') + '">' +
        '<td class="ml-tsel"><input type="checkbox" ' + (S.sel[p.key] ? 'checked' : '') + ' onchange="MetaLeads.sel(' + js(p.key) + ',this.checked)"></td>' +
        TCOLS.map(function (c) {
          var v = c.get(p);
          var cell = c.key === 'rating' && p.team.rating ? ratingChip(p.team.rating)
            : c.key === 'name' ? '<b>' + esc(v || '(no name)') + '</b>' + (MM().isPriorityFor(p, S.prop === 'all' ? '' : S.prop) ? ' <span class="ml-badge pri" title="Revisited — priority">⚡</span>' : '')
            : c.key === 'done' && !p.team.contacted ? waitingFlag(p) || '<span class="ml-dim">Not yet</span>'
            : esc(v || '—');
          return '<td class="' + (c.wide ? 'wide' : '') + '" onclick="MetaLeads.toggle(' + js(p.key) + ')" title="' + esc(c.wide ? v : '') + '">' + (c.wide ? '<div class="ml-clamp">' + cell + '</div>' : cell) + '</td>';
        }).join('') + '</tr>';
    }).join('');
    // The lead opened from the table: a side panel, the table still in view behind it.
    var openP = S.open && rows.find(function (x) { return x.key === S.open; });
    var drawer = drawerHtml(openP);
    return '<div class="ml-count">' + rows.length + ' of ' + list.length + ' ' + (list.length === 1 ? 'person' : 'people') +
        (Object.keys(S.tf).some(function (k) { return S.tf[k]; }) ? ' · <button class="ml-link" onclick="MetaLeads.tfClear()">Clear column filters</button>' : '') + '</div>' +
      bulkBar(rows) +
      '<div class="ml-tablewrap"><table class="ml-table"><thead>' + head + filt + '</thead><tbody>' + (body || '<tr><td colspan="' + (TCOLS.length + 1) + '" class="ml-dim" style="padding:18px;text-align:center">Nobody matches.</td></tr>') + '</tbody></table></div>' +
      (rows.length > S.shown ? '<button class="ml-btn ml-more" onclick="MetaLeads.more()">Show more (' + (rows.length - S.shown) + ' left)</button>' : '') + drawer;
  }
  // Esc closes the side panel.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && (S.layout === 'table' || isPhone()) && S.open && el() && el().style.display !== 'none' && document.querySelector('#metaLeadsView .ml-drawer')) { S.open = null; render(); }
  });
  function leadsHtml() {
    if (!S.plan) return needRead();
    var a = MM().analyse(S.plan, S.prop === 'all' ? '' : S.prop);
    var list = currentList();
    var chips = FILTERS.map(function (f) { return '<button class="ml-chip sm' + (S.filter === f[0] ? ' on' : '') + '" onclick="MetaLeads.filter(' + js(f[0]) + ')">' + f[1] + '</button>'; }).join('');
    var phone = isPhone();
    var rows = list.slice(0, S.shown).map(personHtml).join('');
    var nSet = ['agent', 'rating', 'ad', 'tab', 'days'].filter(function (k) { return S.f[k] && !(k === 'agent' && (S.f[k] === '_mine' || S.f[k] === '_none')); }).length;
    var openP = phone && S.open ? list.concat(S.plan.people).find(function (x) { return x.key === S.open; }) : null;
    var sw = '<div class="ml-layout"><button class="' + (S.layout !== 'table' ? 'on' : '') + '" onclick="MetaLeads.layout(\'list\')"><i class="fa-solid fa-list"></i> List</button><button class="' + (S.layout === 'table' ? 'on' : '') + '" onclick="MetaLeads.layout(\'table\')"><i class="fa-solid fa-table"></i> Table</button></div>';
    return propChips(true) + mineSwitch() + tiles(a, S.prop) +
      '<div class="ml-bar"><input class="ml-search" type="search" placeholder="Search name, phone, note…" value="' + esc(S.q) + '" oninput="MetaLeads.search(this.value)">' +
        '<button class="ml-btn ml-fbtn2' + (S.fOpen ? ' on' : '') + '" onclick="MetaLeads.fOpen()" aria-expanded="' + !!S.fOpen + '"><i class="fa-solid fa-sliders"></i> Filters' + (nSet ? ' <span class="ml-fn">' + nSet + '</span>' : '') + '</button>' +
        '<div class="ml-chips ml-scroll">' + chips + '</div></div>' +
      '<div class="ml-tools-w' + (S.fOpen ? ' open' : '') + '">' + sw + toolbar() + '</div>' +
      (S.layout === 'table' && !phone ? tableHtml(list) :
        (list.length ? bulkBar(list) + '<div class="ml-list' + (S.selMode ? ' selmode' : '') + '">' + rows + '</div>' : '<div class="ml-empty">Nobody matches.</div>') + (phone ? drawerHtml(openP) : '') +
        (list.length > S.shown ? '<button class="ml-btn ml-more" onclick="MetaLeads.more()">Show more (' + (list.length - S.shown) + ' left)</button>' : ''));
  }
  function actionBadge(p) {
    var b;
    if (p.action === 'create') b = '';
    else if (p.action === 'attach') b = '<span class="ml-badge" title="Already a CRM lead; a sync would add ' + esc(p.missingCodes.join(', ')) + ' to their properties">In CRM · would add ' + esc(p.missingCodes.join(', ')) + '</span>';
    else if (p.action === 'reopen') b = '<span class="ml-badge bad" title="Their CRM lead is ' + esc(p.crm.stage) + '; a sync would reopen it, marked duplicate">Would reopen (was ' + esc(p.crm.stage) + ')</span>';
    else if (p.action === 'revisit') b = '<span class="ml-badge warn" title="Already a CRM lead for this property and enquired again through the ad">In CRM · enquired again</span>';
    else b = '<span class="ml-badge ok" title="Already a CRM lead for this property, nothing new">In CRM · already linked</span>';
    if (MM().isPriorityFor(p, S.prop === 'all' ? '' : S.prop)) b += (b ? ' ' : '') + '<span class="ml-badge pri" title="Revisited (duplicate ad lead) — the agent should update this lead first"><i class="fa-solid fa-bolt"></i> Revisited · priority</span>';
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
  function ratingChip(r) { return r ? '<span class="ml-rate r' + r + '" title="Lead rating ' + r + ' of 5">★ ' + r + '</span>' : ''; }
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
  // The latest note written for this person (the newest row that has one): its column and text.
  function latestNote(p) {
    var rows = rowsFor(p, S.prop).slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var count = 0, last = null;
    rows.forEach(function (e) { var l = e.team.remarks.concat(e.team.followups, e.team.notes); count += l.length; if (l.length) last = l[l.length - 1]; });
    return last ? { label: last.label, text: last.text, count: count } : null;
  }
  // "7 Nov, 3:59 am" this year; the year only when it is another one.
  function shortWhen(t) {
    if (!t) return '—';
    var s = MM().fmtWhen(t), y = String(new Date(Date.now() + 5.5 * 3600000).getUTCFullYear());
    return s.replace(' ' + y + ',', ',');
  }
  function personHtml(p) {
    var rows = rowsFor(p, S.prop);
    var open = S.open === p.key;
    var who = p.team.agent ? agentLabel(p.team.agent) : (p.team.assignedRaw ? p.team.assignedRaw + ' ?' : '');
    var wa = waLink(p), note = latestNote(p);
    var dups = p.dupCodes.filter(function (c) { return S.prop === 'all' || c === S.prop; }).map(function (c) { return '<span class="ml-badge warn" title="More than one row for ' + esc(c) + '">Duplicate ×' + p.enquiries.filter(function (e) { return e.propertyCode === c; }).length + (S.prop === 'all' ? ' ' + esc(c) : '') + '</span>'; }).join(' ');
    var codes = S.prop === 'all' || p.properties.length > 1 ? p.properties.map(function (c) { return '<span class="ml-code">' + esc(c) + '</span>'; }).join(' ') : '';
    var ad = rows.length ? rows[rows.length - 1].ad : '';
    var ch = S.changed[p.key];
    var status = (ch ? '<span class="ml-badge ' + (ch === 'new' ? 'info' : 'chg') + '" title="Since the last refresh">' + (ch === 'new' ? 'New' : 'Updated') + '</span> ' : '') + dueChip(p) + ' ' + waitingFlag(p) + ' ' + actionBadge(p);
    return '<div class="ml-person' + (open ? ' open' : '') + (S.sel[p.key] ? ' sel' : '') + '">' +
      '<div class="ml-prow-w">' +
      '<label class="ml-pick1" title="Select"><input type="checkbox" ' + (S.sel[p.key] ? 'checked' : '') + ' onchange="MetaLeads.sel(' + js(p.key) + ',this.checked)"></label>' +
      '<button class="ml-prow" onclick="MetaLeads.toggle(' + js(p.key) + ')" aria-expanded="' + open + '">' + avatar(p) +
        '<div class="ml-who"><div class="ml-name">' + esc(p.name || '(no name)') + (p.crm && p.crm.name && p.crm.name !== p.name ? ' <span class="ml-aka">CRM: ' + esc(p.crm.name) + '</span>' : '') + '</div>' +
        '<div class="ml-phone' + (p.phoneOk ? '' : ' bad') + '">' + esc(p.phone ? MM().displayPhone(p.phone) : 'no phone') + '</div></div>' +
        '<div class="ml-when"><div class="ml-when-t">' + esc(shortWhen(rows.length ? rows[rows.length - 1].at : p.lastAt)) + '</div><div class="ml-when-r">' + esc(relShort(rows.length ? rows[rows.length - 1].at : p.lastAt)) + '</div>' +
        '<div class="ml-meta">' + (dups || (ad ? '<span class="ml-dim">' + esc(ad) + '</span>' : '')) + (codes ? ' ' + codes : '') + '</div></div>' +
        '<div class="ml-team"><div class="ml-agent">' + (who ? '<i class="fa-regular fa-user"></i> ' + esc(who) : '<span class="ml-unas">Not assigned</span>') + ' ' + ratingChip(p.team.rating) + '</div>' +
          (note ? '<div class="ml-note" title="' + esc(note.label + ': ' + note.text) + '"><span class="ml-tn-l">' + esc(note.label) + '</span> ' + esc(note.text) + '</div>' : '<div class="ml-note ml-dim">No notes yet</div>') + '</div>' +
        // On a phone: one line — the AI's next step when there is one, else the latest note.
        '<div class="ml-mline">' + (function () { var n = nextOf(p); return n && n.action ? '<i class="fa-solid fa-arrow-right"></i> ' + esc(n.action) : note ? esc(note.text) : '<span class="ml-dim">No notes yet</span>'; })() + '</div>' +
        '<div class="ml-act">' + '<div class="ml-badges">' + '<span class="ml-badge ml-magent">' + (who ? esc(who) : 'Not assigned') + (p.team.rating ? ' ★ ' + p.team.rating : '') + '</span> ' + status + '</div>' +
          (p.crm ? '<div class="ml-dim">CRM: ' + esc(p.crm.stage || '') + (p.crm.agent ? ' · ' + esc(agentLabel(p.crm.agent)) : '') + '</div>' : '') +
          (p.issues.length ? '<div class="ml-issue"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(p.issues.join(' · ')) + '</div>' : '') + '</div>' +
      '</button>' +
      '<div class="ml-quick">' + (!p.team.assignedRaw && canTake() && rows.some(function (e) { return e.metaId; }) ? '<button class="ml-take" title="Assign this lead to me — written in the sheet" onclick="MetaLeads.take(' + js(p.key) + ')"' + (S.writing ? ' disabled' : '') + '>Take</button>' : '') + (p.phoneOk ? '<a class="ml-qb" href="tel:+' + esc(p.phoneKey) + '" title="Call" aria-label="Call"><i class="fa-solid fa-phone"></i></a>' : '') +
        (wa ? '<a class="ml-qb wa" href="' + esc(wa) + '" target="_blank" rel="noopener" title="WhatsApp" aria-label="WhatsApp"><i class="fa-brands fa-whatsapp"></i></a>' : '') + '</div>' +
      '</div>' + (open && !isPhone() ? detailHtml(p) : '') + '</div>';
  }
  function enquiryLine(e, prev, ctx) {
    var gap = prev && prev.at && e.at ? gapText(e.at - prev.at) : '';
    var link = e.where.spreadsheetId ? MM().sheetUrl(e.where.spreadsheetId, e.where.gid) : '';
    return '<div class="ml-enq' + (ctx && ctx.isWork ? ' work' : '') + '">' +
      '<div class="ml-enq-t"><b>' + esc(MM().fmtWhen(e.at)) + '</b>' + (gap ? ' <span class="ml-gap">' + esc(gap) + ' later</span>' : '') + '</div>' +
      '<div class="ml-enq-d">' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(String(e.where.sheetTitle).trim() + ' › ' + e.where.tab) + ' · row ' + e.row + '</a>' : esc(e.where.tab)) +
      (e.where.tag ? ' <span class="ml-tag">' + esc(e.where.tag) + '</span>' : '') +
      ' · <span class="ml-code">' + esc(e.propertyCode) + '</span> · ' + esc(e.ad || '—') + ' · ' + esc({ ig: 'Instagram', fb: 'Facebook' }[e.platform] || e.platform || '') +
      (e.form ? ' · form “' + esc(e.form) + '”' : '') + '</div>' +
      (e.answers.length ? '<div class="ml-ans">' + e.answers.map(function (x) { return '<span>' + esc(x.label) + ' <b>' + esc(x.value) + '</b></span>'; }).join('') + '</div>' : '') +
      (e.alsoIn && e.alsoIn.length ? '<div class="ml-dim">Also copied in ' + e.alsoIn.map(function (a) { return esc(a.tab); }).join(', ') + '</div>' : '') +
      (ctx ? rowTeamHtml(e, ctx) : '') +
      (e.metaId ? '<div class="ml-enq-btns"><button class="ml-link ml-editrow" onclick="MetaLeads.editRow(' + js(rowKey(e)) + ')">' + (S.edit === rowKey(e) ? 'Close' : 'Edit this row') + '</button>' +
        (ctx && ctx.canPick && !ctx.isWork ? '<button class="ml-link" onclick="MetaLeads.workRow(' + js(ctx.key) + ',' + js(rowKey(e)) + ')">Work on this row</button>' : '') + '</div>' : '') +
      '</div>';
  }

  // ─── Working a lead: what is written to the sheet ──────────────────────
  var QUICK = ['RNR — no answer', 'Busy, call back', 'Details sent on WhatsApp', 'Interested — fix site visit', 'Site visit fixed', 'Visited', 'Budget mismatch', 'Location not suitable', 'Not interested', 'Wrong number', 'Already bought elsewhere'];
  function rowKey(e) { return e.where.spreadsheetId + ':' + e.where.gid + ':' + e.metaId; }
  function readTab(sid, gid) { return S.read && (S.read.tabs || []).find(function (t) { return t.spreadsheetId === sid && t.gid === gid; }); }
  function planTab(sid, gid) { return S.plan && S.plan.tabs.find(function (t) { return t.spreadsheetId === sid && t.gid === gid; }); }
  function cellOf(e, col) { var t = readTab(e.where.spreadsheetId, e.where.gid); var r = t && t.values[e.row - 1]; return r && r[col] != null ? String(r[col]).trim() : ''; }
  function teamCols(e) { var pt = planTab(e.where.spreadsheetId, e.where.gid); return pt ? pt.cols.filter(function (c) { return MM().TEAM_ROLES.indexOf(c.role) >= 0; }) : []; }
  // The row's notes in order (Remarks, Follow up 1, 2…) with what each holds now.
  function notesOf(e) { return MM().noteChain(teamCols(e)).map(function (c) { return { index: c.index, header: c.header, label: c.header || ('Column ' + MM().colLetter(c.index)), value: cellOf(e, c.index) }; }); }
  // Where "Add a note" writes: the cell after the last note written, or a new column.
  function nextNoteLabel(e) {
    var ch = notesOf(e), last = -1;
    ch.forEach(function (x, i) { if (x.value) last = i; });
    if (last + 1 < ch.length) return ch[last + 1].label;
    if (!firstCol(e, 'remarks') && last < 0) return 'Remarks (a new column)';
    var n = teamCols(e).filter(function (c) { return c.role === 'followup'; }).length + 1;
    return 'Follow up ' + n + ' (a new column)';
  }
  function firstCol(e, role) { return teamCols(e).find(function (c) { return c.role === role; }) || null; }
  function today() { var d = new Date(Date.now() + 5.5 * 3600000); return d.getUTCDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; }
  function agentOptions(current) {
    var cur = current ? MM().matchAgent(current, roster()) : null;
    return '<option value="">— Not assigned —</option>' + roster().map(function (e) { return '<option value="' + esc(e) + '"' + (cur === e ? ' selected' : '') + '>' + esc(agentLabel(e)) + '</option>'; }).join('') +
      (current && !cur ? '<option value="_keep" selected>' + esc(current) + ' (as written)</option>' : '');
  }
  // The quick form: the latest row for the property in view — assign, rate, a remark, a follow-up.
  function workRow(p) {
    var rows = rowsFor(p, S.prop).filter(function (e) { return e.metaId; });
    var want = S.workRow[p.key];
    return rows.find(function (e) { return rowKey(e) === want; }) || rows[rows.length - 1] || null;
  }
  function workHtml(p) {
    var rows = rowsFor(p, S.prop).filter(function (e) { return e.metaId; });
    var e = workRow(p);
    if (!e) return '';
    var pickRow = rows.length > 1 ? '<label>Write to</label><select class="ml-f" onchange="MetaLeads.workRow(' + js(p.key) + ',this.value)">' + rows.slice().reverse().map(function (x) {
      return '<option value="' + esc(rowKey(x)) + '"' + (x === e ? ' selected' : '') + '>' + esc(x.propertyCode + ' · ' + String(x.where.sheetTitle).trim() + ' › ' + x.where.tab + ' · ' + MM().fmtWhen(x.at).split(',')[0]) + '</option>';
    }).join('') + '</select>' : '';
    var aCol = firstCol(e, 'assigned'), rCol = firstCol(e, 'rating');
    var aNow = aCol ? cellOf(e, aCol.index) : '', rNow = rCol ? cellOf(e, rCol.index) : '';
    var k = js(p.key), rated = MM().parseRating(rNow), rk = rowKey(e);
    var notes = notesOf(e).filter(function (x) { return x.value; });
    var lastNote = notes.length ? notes[notes.length - 1].index : -1;
    // Every note already in the row, column by column, each editable in place.
    var notesHtml = notes.map(function (x) {
      var dk = rk + ':c' + x.index, v = S.drafts[dk] != null ? S.drafts[dk] : x.value;
      return '<label>' + esc(x.label) + (x.index === lastNote ? ' <span class="ml-latest">latest</span>' : '') + '</label>' +
        '<textarea class="ml-in ml-note-in" rows="' + Math.min(4, Math.max(1, Math.ceil(v.length / 60))) + '" data-col="' + x.index + '" data-header="' + esc(x.header || '') + '" data-from="' + esc(x.value) + '" oninput="MetaLeads.draft(' + js(rk) + ',\'c' + x.index + '\',this.value)">' + esc(v) + '</textarea>';
    }).join('');
    return '<div class="ml-work"><div class="ml-h"><b>Work this lead</b> <span class="ml-dim">Written to ' + esc(String(e.where.sheetTitle).trim() + ' › ' + e.where.tab) + ', row ' + e.row + '</span></div>' +
      '<div class="ml-wgrid">' + pickRow +
        '<label>Assigned to</label><select class="ml-f" id="mlwA">' + agentOptions(aNow) + '</select>' +
        '<label>Rating <span class="ml-dim">1–5</span></label><div class="ml-rates">' + [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" class="ml-rb r' + n + (rated === n ? ' on' : '') + '" title="' + n + ' of 5" onclick="MetaLeads.pickRate(this,' + n + ')">' + n + '</button>'; }).join('') + '<input type="hidden" id="mlwR" value="' + (rated || '') + '"></div>' +
        (notes.length ? '<div class="ml-wsub">Notes <span class="ml-dim">— tap one to edit it</span></div>' + notesHtml : '') +
        '<label>Add a note</label><div><input class="ml-in" id="mlwF" value="' + esc(S.drafts[p.key + ':F'] || '') + '" oninput="MetaLeads.draft(' + k + ',\'F\',this.value)" placeholder="' + (notes.length ? 'e.g. Busy, call back at 6 pm' : 'What did they say?') + ' — Enter saves" onkeydown="if(event.key===\'Enter\'){event.preventDefault();MetaLeads.saveWork(' + k + ')}">' +
          '<div class="ml-goes">Goes into <b>' + esc(nextNoteLabel(e).replace(' (a new column)', '')) + '</b>' + (/a new column/.test(nextNoteLabel(e)) ? ' — a new column, added to the sheet' : '') + '</div>' +
          '<button type="button" class="ml-link ml-qtoggle" onclick="MetaLeads.quickOpen(this)">Quick phrases <i class="fa-solid fa-chevron-down"></i></button>' +
          '<div class="ml-qchips" hidden>' + QUICK.map(function (q) { return '<button type="button" class="ml-qc" onclick="MetaLeads.quickText(' + js(q) + ')">' + esc(q) + '</button>'; }).join('') + '</div>' +
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
        '<textarea class="ml-in" rows="1" data-col="' + c.index + '" data-header="' + esc(c.header || '') + '" data-from="' + esc(v) + '">' + esc(v) + '</textarea>';
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
        try {
          var d = await api('write', { spreadsheetId: g.sid, gid: g.gid, edits: g.edits });
          var t = readTab(g.sid, g.gid);
          if (t) {
            (d.added || []).forEach(function (a) { while (t.values[0].length <= a.col) t.values[0].push(''); t.values[0][a.col] = a.header; });
            var idc = (t.values[0] || []).findIndex(function (h) { return String(h).trim().toLowerCase() === 'id'; });
            (d.applied || []).forEach(function (a) {
              var ri = idc < 0 ? -1 : t.values.findIndex(function (r, i) { return i > 0 && String((r || [])[idc] || '').trim() === a.metaId; });
              if (ri < 0) return;   // not in this copy any more: the next read shows it
              var r = t.values[ri]; while (r.length <= a.col) r.push(''); r[a.col] = a.value;
            });
          }
          total += (d.applied || []).length;
          conflicts = conflicts.concat(d.conflicts || []); errs = errs.concat(d.errors || []);
          if ((d.applied || []).length) g.done = true;
        } catch (e) { errs.push(e.message); }   // one tab failing does not stop the others
      }
    } catch (e) { errs.push(e.message); }
    S.writing = false;
    replan(); render();
    var op = S.open && S.plan && S.plan.people.find(function (x) { return x.key === S.open; }); if (op) maybeAutoBrief(op);
    if (errs.length) toast(errs.length > 1 ? errs[0] + ' (and ' + (errs.length - 1) + ' more)' : errs[0]);
    else if (conflicts.length) {
      toast(conflicts.length + ' change' + (conflicts.length > 1 ? 's were' : ' was') + ' not written — someone changed the sheet. It has been read again: check and save again.');
      Object.keys(groups).forEach(function (k) { var sid = groups[k].sid; var src = (S.cfg.sources || []).find(function (x) { return x.spreadsheetId === sid; }); if (src) MetaLeads.readOne(src.id); });
    }
    else toast(total ? 'Written to the sheet (' + total + ' cell' + (total > 1 ? 's' : '') + ')' : 'Nothing changed');
    return { total: total, conflicts: conflicts, errors: errs };
  }
  function addEdit(groups, e, edit) {
    var k = e.where.spreadsheetId + ':' + e.where.gid;
    (groups[k] = groups[k] || { sid: e.where.spreadsheetId, gid: e.where.gid, edits: [] }).edits.push(Object.assign({ metaId: e.metaId }, edit));
  }
  // What one row says in the sheet (assigned, rating, notes) — the row in the form says so instead.
  function rowTeamHtml(e, ctx) {
    if (ctx.isWork) return '<div class="ml-enq-team"><span class="ml-inform"><i class="fa-solid fa-pen"></i> In the form — notes and rating are edited there</span></div>';
    var t = e.team, notes = t.remarks.concat(t.followups, t.notes);
    var hit = t.assigned ? MM().matchAgent(t.assigned, roster()) : null;
    var who = t.assigned ? (hit ? agentLabel(hit) : t.assigned + ' ?') : '';
    if (!who && !t.rating && !notes.length) return '<div class="ml-enq-team ml-dim">Nothing written in this row yet</div>';
    return '<div class="ml-enq-team">' + (who || t.rating ? '<div>' + (who ? '<span class="ml-ewho" title="' + esc(hit ? 'Written “' + t.assigned + '” — ' + hit : 'Not on the team list') + '"><i class="fa-regular fa-user"></i> ' + esc(who) + '</span>' : '') + ' ' + ratingChip(t.rating) + '</div>' : '') +
      notes.map(function (n) { return '<div class="ml-enq-n"><span class="ml-tn-l">' + esc(n.label) + '</span> ' + esc(n.text) + '</div>'; }).join('') + '</div>';
  }
  function gapText(ms) {
    var h = ms / 3600000;
    if (h < 1) return Math.max(1, Math.round(ms / 60000)) + ' min';
    if (h < 48) return Math.round(h) + ' h';
    return Math.round(h / 24) + ' days';
  }
  function detailHtml(p) {
    var rows = p.enquiries, crm = p.crm, w = workRow(p);
    var canPick = rows.filter(function (e) { return e.metaId; }).length > 1;
    return '<div class="ml-detail" data-tab="' + esc(S.dtab) + '">' +
      '<div class="ml-col ml-col-work"><div class="ml-sec-ov">' + briefHtml(p) + '</div><div class="ml-sec-up">' + workHtml(p) + '</div>' +
        '<div class="ml-sec-ov ml-sec-crm"><div class="ml-h">In the CRM</div>' +
        '<div class="ml-would">' + wouldDo(p) + '</div>' +
        (crm ? '<div class="ml-crm">' +
          '<div class="ml-kv"><span>Lead</span><b>' + esc(crm.name || '—') + '</b></div>' +
          '<div class="ml-kv"><span>Stage</span><b>' + esc(crm.stage || '—') + '</b></div>' +
          '<div class="ml-kv"><span>Agent</span><b>' + esc(agentLabel(crm.agent) || '—') + '</b></div>' +
          '<div class="ml-kv"><span>Properties</span><b>' + (crm.propertyCodes.length ? crm.propertyCodes.map(function (c) { return '<span class="ml-code">' + esc(c) + '</span>'; }).join(' ') : '—') + '</b></div>' +
          (crm.propertyInterest ? '<div class="ml-kv"><span>Looking for</span><b>' + esc(crm.propertyInterest) + '</b></div>' : '') +
          (crm.budget ? '<div class="ml-kv"><span>Budget</span><b>' + esc(crm.budget) + '</b></div>' : '') +
          '<div class="ml-kv"><span>Since</span><b>' + esc(crm.createdAt ? MM().fmtWhen(crm.createdAt) : '—') + '</b></div>' +
          (crm.followUpAt ? '<div class="ml-kv"><span>Follow-up</span><b>' + esc(MM().fmtWhen(crm.followUpAt)) + '</b></div>' : '') +
          (crm.lostReason ? '<div class="ml-kv"><span>Lost reason</span><b>' + esc(crm.lostReason) + '</b></div>' : '') +
          (crm.summary ? '<div class="ml-sum"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + esc(crm.summary) + '</div>' : '') +
          '<button class="ml-btn sm" onclick="MetaLeads.openLead(' + js(crm.id) + ')"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open in the CRM</button></div>'
          : '<div class="ml-dim">Not a CRM lead yet.</div>') + '</div>' +
      '</div>' +
      '<div class="ml-col ml-col-hist ml-sec-hi"><div class="ml-h">Enquiries (' + rows.length + ')' + (canPick ? ' <span class="ml-dim">— each with what its row says</span>' : '') + '</div>' +
        rows.map(function (e, i) { return enquiryLine(e, rows[i - 1], { key: p.key, isWork: e === w, canPick: canPick && !!e.metaId }) + rowEditHtml(e); }).join('') + '</div>' +
    '</div>';
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
    var rate = [5, 4, 3, 2, 1].map(function (n) { return { label: 'Rating ' + n, n: a.ratings[n] }; }).concat([{ label: 'Not rated', n: a.ratings.none }]);
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
        card('Already in the CRM — their stage', a.byStage.length ? bars(a.byStage, a.inCrm) : '<div class="ml-dim">None of them is a CRM lead yet.</div>') +
        a.questions.map(function (q) { return card('Form: ' + esc(q.label), bars(q.answers)); }).join('') +
      '</div>';
  }

  // The admin's reports: who holds which leads and how far they got; which ad brings better leads.
  function teamTable(a) {
    if (!a.agents.length) return '';
    var pct = function (n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; };
    return '<div class="ml-card"><div class="ml-h">Team — who holds which leads <span class="ml-dim">(click to see their leads)</span></div><div class="ml-tt">' +
      '<div class="ml-tt-r ml-tt-h ml-team-r"><span>Agent</span><span>Leads</span><span>Contacted</span><span>Not contacted</span><span>Rated 4–5</span><span>Rated 3</span><span>Priority</span></div>' +
      a.agents.map(function (x) {
        var label = x.agent ? (x.agent.indexOf('@') > 0 ? agentLabel(x.agent) : x.agent + ' (not on the team list)') : 'Not assigned';
        var f = x.agent ? x.agent : '_none';
        return '<button class="ml-tt-r ml-team-r" onclick="MetaLeads.agentLeads(' + js(f) + ')"><span><b>' + esc(label) + '</b></span><span>' + x.people + '</span><span>' + x.contacted + ' <span class="ml-dim">' + pct(x.contacted, x.people) + '</span></span>' +
          '<span' + (x.untouched ? ' class="ml-bad"' : '') + '>' + x.untouched + '</span><span>' + x.top + '</span><span>' + x.mid + '</span><span>' + x.priority + '</span></button>';
      }).join('') + '</div></div>';
  }
  function adTable(a) {
    if (!a.adQuality.length) return '';
    var pct = function (n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; };
    return '<div class="ml-card"><div class="ml-h">Lead quality by ad <span class="ml-dim">(ratings from the sheet)</span></div><div class="ml-tt">' +
      '<div class="ml-tt-r ml-tt-h ml-ad-r"><span>Ad</span><span>Enquiries</span><span>People</span><span>Contacted</span><span>Rated 4–5</span><span>Rated 3+</span><span>Average rating</span></div>' +
      a.adQuality.map(function (x) {
        return '<button class="ml-tt-r ml-ad-r" onclick="MetaLeads.adLeads(' + js(x.ad) + ')"><span><b>' + esc(x.ad) + '</b></span><span>' + x.enquiries + '</span><span>' + x.people + '</span><span>' + pct(x.contacted, x.people) + '</span>' +
          '<span>' + x.top + '</span><span>' + pct(x.threePlus, x.people) + '</span><span>' + (x.avg != null ? '★ ' + x.avg + ' <span class="ml-dim">(' + x.rated + ' rated)</span>' : '—') + '</span></button>';
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
    read: function () { readSheets(false); },
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
    toggle: function (k, force) {
      var was = S.open;
      S.open = force ? k : (S.open === k ? null : k);
      if (S.open && S.open !== was) S.dtab = 'overview';
      if (S.open && !was && isPhone()) { try { history.pushState(Object.assign({}, history.state || {}, { mlLead: S.open }), '', location.href); } catch (e) { /* no history */ } } if (S.open && S.plan) maybeAutoBrief(S.plan.people.find(function (x) { return x.key === S.open; })); if (force) {
        S.filter = 'all'; S.q = ''; S.tf = {};
        var p = S.plan && S.plan.people.find(function (x) { return x.key === k; });
        if (p && S.prop !== 'all' && p.properties.indexOf(S.prop) < 0) S.prop = 'all';
        // A filter that hides them (My leads, a rating, an ad…) is cleared, and said so.
        if (p && !passes(p)) { S.f = { agent: '', rating: '', ad: '', tab: '', days: '', sort: S.f.sort }; saveF(); toast('Filters cleared to show ' + (p.name || 'this lead')); }
        S.shown = Math.max(S.shown, peopleFor(S.prop).length);
      }
      render();
      if (force) setTimeout(function () {
        var o = document.querySelector('#metaLeadsView .ml-person.open') || document.querySelector('#metaLeadsView tr.ml-tr.open');
        if (!o) return;
        o.scrollIntoView({ block: 'center' });
        o.classList.add('ml-flash'); setTimeout(function () { o.classList.remove('ml-flash'); }, 2600);
      }, 40);
    },
    openLead: function (id) { if (typeof openDetail === 'function') openDetail(id); },
    copy: function (t) { try { navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { toast(t); } },
    agentLeads: function (agent) { S.f = { agent: agent, rating: '', ad: '', tab: '', days: '', sort: 'untouched' }; S.filter = 'all'; MetaLeads.go('meta-leads'); },
    adLeads: function (ad) { S.f = { agent: '', rating: '', ad: ad, tab: '', days: '', sort: 'new' }; S.filter = 'all'; MetaLeads.go('meta-leads'); },
    brief: function (key) { if (S.brun[key]) return; S.bq = S.bq.filter(function (k) { return k !== key; }); S.bq.unshift(key); S.bTotal = S.bDone + S.bq.length + Object.keys(S.brun).length; pumpBriefs(key); render(); },
    dtab: function (t) { S.dtab = t; render(); var d = document.querySelector('#metaLeadsView .ml-drawer.full'); if (d) d.scrollTop = 0; },
    closeLead: function () {
      if (isPhone() && history.state && history.state.mlLead) { history.back(); return; }
      S.open = null; render();
    },
    selMode: function () { S.selMode = !S.selMode; if (!S.selMode) S.sel = {}; render(); },
    fOpen: function () { S.fOpen = !S.fOpen; render(); },
    layout: function (l) { S.layout = l; S.shown = PAGE; saveF(); render(); },
    tsort: function (k) { S.tsort = S.tsort.key === k ? { key: k, dir: -S.tsort.dir } : { key: k, dir: k === 'at' || k === 'rating' ? -1 : 1 }; saveF(); render(); },
    tf: function (k, v) { S.tf[k] = v; S.shown = PAGE; render(); },
    tfType: function (k, v) {
      S.tf[k] = v; S.shown = PAGE;
      clearTimeout(S.tft); S.tft = setTimeout(function () {
        render();
        var box = document.querySelector('#metaLeadsView .ml-tfilt th:nth-child(' + (TCOLS.findIndex(function (c) { return c.key === k; }) + 2) + ') input');
        if (box) { box.focus(); try { box.setSelectionRange(v.length, v.length); } catch (e) {} }
      }, 220);
    },
    tfClear: function () { S.tf = {}; render(); },
    setF: function (k, v) { S.f[k] = v; S.shown = PAGE; saveF(); if (S.view !== 'meta-leads') { MetaLeads.go('meta-leads'); return; } render(); },
    clearF: function () { S.f = { agent: '', rating: '', ad: '', tab: '', days: '', sort: S.f.sort }; S.filter = 'all'; S.q = ''; saveF(); render(); },
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
    // Take an unassigned lead: my name in Assigned to on each of its rows (only cells still empty).
    take: function (key) {
      var p = S.plan.people.find(function (x) { return x.key === key; });
      if (!p || !canTake()) return;
      var name = agentLabel(me()), groups = {};
      rowsFor(p, S.prop).forEach(function (e) {
        if (!e.metaId) return;
        var c = firstCol(e, 'assigned'), now = c ? cellOf(e, c.index) : '';
        if (!now) addEdit(groups, e, { field: 'assigned', value: name, from: '' });
      });
      if (!Object.keys(groups).length) { toast('Already assigned'); return; }
      writeEdits(groups).then(function (r) { if (!r.errors.length && !r.conflicts.length) toast((p.name || 'The lead') + ' is yours — in My leads'); });
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
    quickText: function (q) {
      var f = document.getElementById('mlwF'); if (f) { f.value = f.value ? f.value + ', ' + q : q; f.dispatchEvent(new Event('input')); f.focus(); }
      var box = document.querySelector('#metaLeadsView .ml-work .ml-qchips'); if (box) box.hidden = true;   // picked: out of the way again
    },
    // The preset phrases stay hidden until asked for (no re-render, so typing is never lost).
    quickOpen: function (btn) { var box = btn.parentNode.querySelector('.ml-qchips'); if (box) box.hidden = !box.hidden; },
    draft: function (key, f, v) { S.drafts[key + ':' + f] = v; },
    stamp: function (on) { S.stamp = on; },
    saveWork: function (key) {
      var p = S.plan.people.find(function (x) { return x.key === key; });
      var e = workRow(p);
      var A = document.getElementById('mlwA').value, R = document.getElementById('mlwR').value, F = document.getElementById('mlwF').value.trim();
      var aCol = firstCol(e, 'assigned'), rCol = firstCol(e, 'rating');
      var aNow = aCol ? cellOf(e, aCol.index) : '', rNow = rCol ? cellOf(e, rCol.index) : '';
      var groups = {}, rk = rowKey(e), noteKeys = [];
      if (A !== '_keep') { var name = A ? agentLabel(A) : ''; if (name !== aNow && !(A && MM().matchAgent(aNow, roster()) === A)) addEdit(groups, e, { field: 'assigned', value: name, from: aNow }); }
      if (R && MM().parseRating(rNow) !== Number(R)) addEdit(groups, e, { field: 'rating', value: R, from: rNow });
      // Notes edited in place: each in its own column, refused if the sheet changed it meanwhile.
      document.querySelectorAll('#metaLeadsView .ml-work textarea.ml-note-in').forEach(function (t) {
        var from = t.getAttribute('data-from'), v = t.value.trim();
        noteKeys.push(rk + ':c' + t.getAttribute('data-col'));
        if (v !== from) addEdit(groups, e, { col: Number(t.getAttribute('data-col')), header: t.getAttribute('data-header') || '', value: v, from: from });
      });
      // A new note: Remarks if empty, else the next follow-up column after the last note.
      if (F) addEdit(groups, e, { field: 'log', value: S.stamp ? F + ' (' + today() + ')' : F });
      if (!Object.keys(groups).length) { toast('Nothing changed'); return; }
      writeEdits(groups).then(function (r) {
        // Saved: the drafts go. Refused: the remark shows the sheet's new text (to be merged by the
        // person), the typed follow-up stays to be saved again.
        if (!r.errors.length) { noteKeys.forEach(function (d) { delete S.drafts[d]; }); if (!r.conflicts.length) delete S.drafts[key + ':F']; }
        render();
      });
    },
    workRow: function (pk, rk) { S.workRow[pk] = rk; render(); },
    editRow: function (k) { S.edit = S.edit === k ? null : k; render(); },
    saveRow: function (k) {
      var e = null;
      S.plan.people.some(function (p) { return p.enquiries.some(function (x) { if (rowKey(x) === k) { e = x; return true; } return false; }); });
      if (!e) return;
      var groups = {};
      document.querySelectorAll('#metaLeadsView .ml-rowedit textarea').forEach(function (t) {
        var from = t.getAttribute('data-from'), v = t.value.trim();
        if (v !== from) addEdit(groups, e, { col: Number(t.getAttribute('data-col')), header: t.getAttribute('data-header') || '', value: v, from: from });
      });
      if (!Object.keys(groups).length) { toast('Nothing changed'); return; }
      writeEdits(groups).then(function (r) { if (!r.errors.length && !r.conflicts.length) { S.edit = null; render(); } });
    },
    csv: function () {
      var list = currentList();
      var q = function (v) { v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var head = ['Name', 'Phone', 'Email', 'Properties', 'First enquiry', 'Last enquiry', 'Enquiries', 'Ads', 'Assigned to', 'Rating', 'Latest note', 'Contacted', 'In the CRM (stage)', 'AI: stage', 'AI: next step', 'AI: due'];
      var lines = [head.join(',')].concat(list.map(function (p) {
        var rows = rowsFor(p, S.prop);
        return [p.name, p.phoneOk ? p.phoneKey.slice(2) : (p.phone || ''), p.email, p.properties.join(' '), MM().fmtWhen(firstAtFor(p)), MM().fmtWhen(lastAtFor(p)), rows.length,
          Array.from(new Set(rows.map(function (e) { return e.ad; }))).join(' / '), p.team.agent ? agentLabel(p.team.agent) : p.team.assignedRaw,
          p.team.rating ? String(p.team.rating) : '', p.team.notes.length ? p.team.notes[p.team.notes.length - 1].text : '', p.team.contacted ? 'yes' : 'no', p.crm ? p.crm.stage : '',
          (S.briefs[p.key] && S.briefs[p.key].v) ? (STAGE_NAME[S.briefs[p.key].v.stage] || S.briefs[p.key].v.stage) : '', (nextOf(p) || {}).action || '', (nextOf(p) || {}).text || ''].map(q).join(',');
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
      if (S.readingOne) { S.readQueue = (S.readQueue || []).concat(S.readQueue && S.readQueue.indexOf(id) >= 0 ? [] : [id]); return; }
      S.readingOne = id; render();
      api('read', { sourceId: id }).then(function (d) {
        // The sheet's tabs replace its earlier ones; the other sheets' stay as read.
        var keep = S.read ? (S.read.tabs || []).filter(function (t) { return t.sourceId !== id; }) : [];
        var errs = S.read ? (S.read.errors || []).filter(function (e) { return e.sourceId !== id; }) : [];
        S.read = { ok: true, at: d.at, tabs: keep.concat(d.tabs || []), errors: errs.concat(d.errors || []) };
        Object.keys(d.mods || {}).forEach(function (k) { S.mods[k] = d.mods[k]; S.modCfg[k] = cfgSig(k); });
        replan();
        toast(d.errors && d.errors.length ? d.errors[0].error : 'Read — ' + (d.tabs || []).reduce(function (n, t) { return n + Math.max((t.values || []).length - 1, 0); }, 0) + ' rows. Nothing was added to the CRM.');
        loadConfig(true);
      }).catch(function (e) { toast(e.message); }).then(function () {
        S.readingOne = null; render();
        var next = (S.readQueue || []).shift(); if (next) MetaLeads.readOne(next);
      });
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
    // Never under someone's fingers: while a field here has the focus, the redraw waits.
    var a = document.activeElement;
    if (a && el().contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
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
    if (S.open && el() && el().style.display !== 'none' && !(history.state && history.state.mlLead) && isPhone()) { S.open = null; render(); return; }
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

  var STALE_MS = 10 * 60000;
  // Reading is just reading (no lead, no cell changes): the leads are read when the screen opens, and
  // again when the last read is over 10 minutes old — nobody has to remember to press Read.
  function autoRead() {
    if (S.reading || S.readError || !S.cfg || !(S.cfg.sources || []).some(function (x) { return x.on !== false; })) return;
    if (!S.read || Date.now() - (S.read.at || 0) > STALE_MS) readSheets(true);
  }
  window.renderMetaLeadsView = function (view) {
    S.view = view || 'meta-leads';
    if (S.cfg) autoRead();
    if (!S.fromPop) syncPath(S.view);
    document.title = { 'meta-leads': 'Meta Ads Leads', 'ml-dupes': 'Duplicates · Meta Ads Leads', 'ml-analysis': 'Analysis · Meta Ads Leads', 'ml-setup': 'Setup · Meta Ads Leads' }[S.view] + ' — 3 PIN Realty';
    loadConfig();
    whenInventory();
    render();
  };
})();
