// ═══════ WHATSAPP CAMPAIGNS — templates, lead lists and campaigns through TailorTalk ═══════
//
// Its own section of the app rail, drawn inside the CRM page because the leads it picks from are
// already loaded and kept live here. Four screens:
//
//   Dashboard     what is approved, what went out and how it landed, the replies waiting for a
//                 person, and the stage journeys due today (crm-assets/journeys.js) — tomorrow's
//                 visits to remind, this week's to ask for feedback, a sold-out property's
//                 interested leads, a new listing's matched buyers… each one tap from the wizard
//   Templates     the library: TailorTalk's live list with approval status, drafts written here
//                 by hand, from the starter library or by AI, and the way each gets approved
//   New campaign  template → property and values → who (quick lists, filters, search, AI, ticks,
//                 contacts typed in) → test, CSV for TailorTalk Broadcast, or send from here
//   Campaigns     every campaign, how each person on it replied and what it led to — who moved
//                 on to a visit, Negotiating or Won after it, read from the CRM's live leads
//
// Nothing here is sent without a person pressing Send and typing how many; the server holds
// every rule that matters (approved only, every variable filled, one message per number, the
// test number only for tests, who is held back) — see api/_campaign.js. The pure rules both
// sides share are crm-assets/campaignModel.js, bridged onto window.crmCampaign.
//
// Each screen, wizard step and campaign has its own address (#cmp-new/3, #cmp/<id>…), so the
// browser's Back and a reload land where the person was; each dialog owns one history entry
// (AppNav.openLayer), so a phone's Back closes it rather than leaving the page.

(function () {
  'use strict';

  var CM = function () { return window.crmCampaign; };
  // The stage journeys (a module, bridged after this script loads — absent for a moment at start).
  var JM = function () { return window.crmJourneys || null; };
  var esc = function (s) { return typeof escapeHtml === 'function' ? escapeHtml(s == null ? '' : String(s)) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  // A value handed to an onclick: a JavaScript string, escaped for the attribute it sits in — a
  // name with a quote or a backslash in it can never break out of the handler.
  var js = function (v) { return esc(JSON.stringify(v == null ? '' : v)); };
  var toast = function (m) { if (typeof showToast === 'function') showToast(m); };
  var DAY = 86400000;
  // [view, label, icon, the shorter label a phone shows]
  var TABS = [['campaigns', 'Dashboard', 'fa-solid fa-gauge-high', 'Dashboard'], ['cmp-templates', 'Templates', 'fa-regular fa-file-lines', 'Templates'], ['cmp-new', 'New campaign', 'fa-regular fa-paper-plane', 'New'], ['cmp-history', 'Campaigns', 'fa-solid fa-clock-rotate-left', 'Sent']];
  var STEPS = ['Template', 'Property & values', 'Who gets it', 'Review & send'];

  var S = {
    view: 'campaigns',
    templates: null, tplError: null, tplLoading: false,
    campaigns: null, cmpError: null,
    settings: null, metaReady: false,
    tplFilter: 'all', tplQ: '',
    editor: null,
    detail: null, detailLoading: false, detailLimit: 500,
    sending: null,
    wiz: null,
    jCache: null,
    // A button pressed and not answered yet — pressed again, it does nothing.
    busy: {}
  };

  // Whatever the rules modules export by that name (campaignModel first, then journeys), or null —
  // newer rules are used when they are there, and the screen still works while they are not.
  function rule(name) {
    var C = CM(), J = JM();
    if (C && C[name] !== undefined) return C[name];
    if (J && J[name] !== undefined) return J[name];
    return null;
  }
  // A fresh id for one press of Send / Send a test / Download CSV. The server answers a repeat of
  // the same id with what the first one did, so a double click, or a retry after a timeout, can
  // never make a second campaign.
  function newRequestId() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* older browser */ }
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  // A short fingerprint of what is being sent, so the same campaign pressed again keeps its id.
  function fingerprint(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  // ─── server ──────────────────────────────────────────────────────────
  // Opened straight from a link (?nav=campaigns), the screen asks before sign-in has finished:
  // it waits for it, a few seconds at most, rather than saying "log in again".
  async function idToken() {
    for (var i = 0; i < 40; i++) {
      var tok = window.crmAuth && window.crmAuth.getIdToken ? await window.crmAuth.getIdToken().catch(function () { return null; }) : null;
      if (tok) return tok;
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    return null;
  }
  // Every answer is checked before anything says it worked: a gateway timeout or an HTML error
  // page is not an answer — the work may or may not have happened — and neither is a failure code.
  var SLOW_OPS = { create: 1, send: 1, 'test-send': 1, status: 1, cancel: 1, resolve: 1 };
  async function api(op, body) {
    var tok = await idToken();
    if (!tok) throw new Error('Please log in again');
    var res;
    try {
      res = await fetch('/api/tailortalk?action=campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify(Object.assign({ op: op }, body || {}))
      });
    } catch (e) {
      throw Object.assign(new Error('No connection — check the internet and try again'), { network: true, data: {} });
    }
    var raw = await res.text().catch(function () { return ''; });
    var data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    var slow = res.status === 504 || res.status === 502 || res.status === 503 || res.status === 408;
    var slowMsg = SLOW_OPS[op] ? 'The server took too long — open the campaign to see what went' : 'The server took too long — try again';
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw Object.assign(new Error(slow || /timed? ?out|FUNCTION_INVOCATION_TIMEOUT/i.test(raw.slice(0, 400)) ? slowMsg : 'The server sent back something unexpected (' + res.status + ') — try again'), { status: res.status, timeout: slow, data: {} });
    }
    if (data.notConfigured) return data;
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || (slow ? slowMsg : 'Request failed (' + res.status + ')')), { data: data, status: res.status, timeout: slow });
    return data;
  }

  function loadTemplates(force) {
    if (S.tplLoading || (S.templates && !force)) return;
    S.tplLoading = true; S.tplError = null;
    api('templates').then(function (r) { S.templates = Array.isArray(r.templates) ? r.templates : []; S.jCache = null; })
      .catch(function (e) { S.tplError = e.message; })
      .then(function () { S.tplLoading = false; render(); });
  }
  function loadCampaigns() {
    api('list').then(function (r) {
      S.campaigns = Array.isArray(r.campaigns) ? r.campaigns : []; S.cmpError = null;
      // A campaign whose counts moved is fetched again for its scorecard.
      S.campaigns.forEach(function (c) { var f = S.full[c.id]; if (f && JSON.stringify(f.counts || {}) !== JSON.stringify(c.counts || {})) delete S.full[c.id]; });
    })
      .catch(function (e) { S.cmpError = e.message; })
      .then(function () { S.jCache = null; render(); loadFull(); });
  }
  function loadSettings() {
    api('settings').then(function (r) { S.settings = r.settings || {}; S.metaReady = !!r.metaReady; S.jCache = null; render(); }).catch(function () { /* the defaults stand in */ });
  }
  // The settings, with the defaults for anything the server has not stored yet.
  function settings() {
    var st = S.settings || {}, C = CM();
    return {
      testNumber: st.testNumber || '919941880088', optOut: st.optOut || [], marketingOptOut: st.marketingOptOut || [], marketingGapDays: st.marketingGapDays == null ? 7 : st.marketingGapDays,
      marketingRate: st.marketingRate == null ? C.DEFAULT_RATES.MARKETING : st.marketingRate, utilityRate: st.utilityRate == null ? C.DEFAULT_RATES.UTILITY : st.utilityRate,
      quietStart: st.quietStart == null ? C.QUIET_DEFAULT.start : st.quietStart, quietEnd: st.quietEnd == null ? C.QUIET_DEFAULT.end : st.quietEnd,
      lists: Array.isArray(st.lists) ? st.lists : []
    };
  }
  // The inventory comes through the Firestore module, which loads after this script. Asked for
  // before it is there, loadInventory() would settle on an empty list for the whole session.
  function whenFirestore() {
    return new Promise(function (resolve) {
      var tries = 0;
      (function wait() {
        if ((window.crmFirebase && window.crmFirebase.getInventory) || tries++ > 80) return resolve();
        setTimeout(wait, 150);
      })();
    });
  }
  function boot() {
    loadTemplates(); loadCampaigns(); loadSettings();
    if (typeof loadInventory === 'function') whenFirestore().then(function () { return loadInventory(); }).then(function () { S.jCache = null; render(); });
  }

  // ─── lead helpers (all over the CRM's live leads) ─────────────────────
  function allLeads() { return (typeof leads !== 'undefined' && Array.isArray(leads)) ? leads : []; }
  function leadById(id) { return allLeads().find(function (l) { return l && l.id === id; }) || null; }
  function leadsMap() { var m = {}; allLeads().forEach(function (l) { if (l && l.id) m[l.id] = l; }); return m; }
  function inv() { return (typeof inventory !== 'undefined' && Array.isArray(inventory)) ? inventory : []; }
  function propById(id) { if (!id) return null; var k = String(id).toUpperCase(); return inv().find(function (p) { return p.id === id || String(p.propertyCode || '').toUpperCase() === k; }) || null; }
  function visitOfLead(l) { return window.crmPipeline && window.crmPipeline.visitOf ? window.crmPipeline.visitOf(l) : { at: null, status: 'none', property: null }; }
  function stageOf(l) { return typeof stageById === 'function' ? stageById(l.stageId) : null; }
  function stageKind(l) { var s = stageOf(l); return s && window.crmPipeline && window.crmPipeline.stageKindOf ? window.crmPipeline.stageKindOf(s) : null; }
  function contactOf(l) { return CM().waNumber(l.phone || (l.tt && l.tt.contact) || ''); }
  function lastActive(l) { return Math.max((l.tt && l.tt.lastMessageAt) || 0, l.updatedAt || 0, l.createdAt || 0); }
  // A number typed in or uploaded that is already a CRM lead's is that lead — with its visit,
  // property, stage and every rule that holds it back. The most recently active one wins a tie.
  function leadsByNumber() {
    var m = {};
    allLeads().forEach(function (l) { var n = l && contactOf(l); if (n && (!m[n] || lastActive(l) > lastActive(m[n]))) m[n] = l; });
    return m;
  }
  function linkedProps(l) {
    var out = [];
    (l.propertyCodes || []).forEach(function (c) { var p = propById(c); if (p && out.indexOf(p) < 0) out.push(p); });
    return out;
  }
  function hasProp(l, pid) {
    if (typeof leadHasProperty === 'function' && leadHasProperty(l, pid)) return true;
    var p = propById(pid), v = visitOfLead(l);
    return !!(p && v.property && String(v.property).toUpperCase() === String(p.propertyCode || p.id).toUpperCase());
  }
  // The property a lead hears about when the campaign says "each lead's own": the one they
  // visited (for visit lists), else the sold-out one (for sold-out lists), else the first linked.
  function ownProp(l, quick) {
    var v = visitOfLead(l);
    var visited = v.property ? propById(v.property) : null;
    var linked = linkedProps(l);
    if (quick === 'soldout' || quick === 'sold_out') { var sold = linked.filter(function (p) { return p.soldOut; })[0] || (visited && visited.soldOut ? visited : null); if (sold) return sold; }
    if (visited && /visit|planned|tomorrow|feedback|reminder|no_show/.test(quick || '')) return visited;
    return linked[0] || visited || null;
  }
  function intentOf(l) {
    var i = (l.ai && l.ai.intent) || '';
    if (i === 'buy') return 'buyer';
    if (i === 'rent') return 'tenant';
    if (i === 'sell' || i === 'rent_out') return 'owner';
    if (/seller/i.test(l.enquiryType || '')) return 'owner';
    var s = ((l.tt && l.tt.values && l.tt.values.propertyInterest) || l.propertyInterest || '').toLowerCase();
    if (/\brent|lease\b/.test(s)) return 'tenant';
    return l.enquiryType ? 'buyer' : '';
  }
  function budgetOf(l) {
    var raw = l.budget || (l.tt && l.tt.values && l.tt.values.budget) || '';
    return typeof window.parseBudgetToINR === 'function' ? window.parseBudgetToINR(raw) : null;
  }
  function areaText(l) {
    return [l.propertyInterest, l.tt && l.tt.values && l.tt.values.propertyInterest, l.ai && l.ai.line]
      .concat(linkedProps(l).map(function (p) { return p.location + ' ' + p.name; })).filter(Boolean).join(' ').toLowerCase();
  }
  function startOfDay(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function stageKeyOfLead(l) { var s = stageOf(l); return s && window.crmPipeline ? window.crmPipeline.stageKeyOf(s) : null; }
  function crmStages() { return typeof stages !== 'undefined' && Array.isArray(stages) ? stages : []; }
  function agentLabel(e) { return typeof agentName === 'function' ? agentName(e) : String(e || '').split('@')[0]; }
  // The team member a message names ({{agent_name}}, {{agent_phone}}): the one sent on the lead's
  // site visit, else the lead's agent, else whoever is sending. The team list keeps only emails;
  // a phone comes from the team entry if it ever has one, else from the numbers the site-visit
  // dialog remembers on this device for each name.
  var OFFICE_PHONE = '90808 95163';
  var HOST_SKIP = /^(sales|admin|info|office|accounts|support|hello|team|contact)$/i;
  function hostPhone(name) {
    var k = String(name || '').trim().toLowerCase();
    if (!k) return '';
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem('pinSiteVisitHosts') || '{}') || {}; } catch (e) { /* none on this device */ }
    return saved[k] || ({ thirumal: '99418 80088' })[k.split(' ')[0]] || '';
  }
  function agentOf(l) {
    var visitAgents = l && Array.isArray(l.siteVisitAgents) ? l.siteVisitAgents : [];
    var email = visitAgents.find(function (e) { return !HOST_SKIP.test(String(e).split('@')[0]); }) || (l && l.assignedAgent) || (typeof currentUserEmail !== 'undefined' ? currentUserEmail : '') || '';
    if (!email) return null;
    var roster = typeof team !== 'undefined' && team ? Object.keys(team).map(function (k) { return team[k]; }) : [];
    var m = roster.find(function (x) { return x && String(x.email || '').toLowerCase() === String(email).toLowerCase(); }) || {};
    var name = (m.name && String(m.name)) || agentLabel(email);
    // No number on file for this person: the office line AIRA already gives leads, so a reminder is
    // never held back for want of a phone.
    var phone = m.phone || m.mobile || m.whatsapp || hostPhone(name) || OFFICE_PHONE;
    return { name: name, email: email, phone: phone ? CM().prettyNumber(phone) : '' };
  }

  // ─── stage journeys and replies (crm-assets/journeys.js over the live leads) ──
  // The match engine scores a lead against a property; journeys.js takes it as a plain function so
  // it stays pure. Profiles are built once per lead and property for one round of journeys.
  function matchFn() {
    var PM = window.PinMatch, list = inv();
    if (!PM || !list.length) return null;
    var ctx = null, reqs = {}, props = {};
    return function (lead, p) {
      if (!PM.isBuyerLead(lead)) return null;
      if (!ctx) ctx = { idf: PM.idfFor(list), area: PM.areaModelFor(list), now: Date.now() };
      var req = reqs[lead.id] || (reqs[lead.id] = PM.requirementProfile(lead, { inventory: list }));
      if (!req.budget && !req.localities && !req.bhk && !req.types) return null;
      var prof = props[p.id] || (props[p.id] = PM.propertyProfile(p));
      var sc = PM.score(req, prof, ctx);
      return sc.vetoed ? null : sc.pct;
    };
  }
  // The journeys due now — worked out again when the leads, campaigns, settings or inventory
  // change, and at most once a minute otherwise.
  function journeys() {
    var J = JM();
    if (!J || !S.campaigns) return [];
    var stamp = Math.floor(Date.now() / 60000);
    if (S.jCache && S.jCache.stamp === stamp) return S.jCache.list;
    var list = [];
    try {
      var st = settings();
      list = J.dueJourneys({ leads: allLeads(), stages: crmStages(), campaigns: S.campaigns, inventory: inv(), now: Date.now(),
        match: matchFn(), optOut: st.optOut, marketingOptOut: st.marketingOptOut, gapDays: st.marketingGapDays, settings: st, optOutOf: optOutOf,
        categoryFor: function (purpose) { var t = templateFor(purpose); return t ? t.category : ''; } });
    } catch (e) { console.warn('Campaign journeys:', e); }
    S.jCache = { stamp: stamp, list: list };
    return list;
  }
  function dismissed() { try { return JSON.parse(localStorage.getItem('pinCmpDismiss') || '{}'); } catch (e) { return {}; } }
  // A card about one property stays hidden; any other comes back after three days if still due.
  function isHidden(j, d) {
    if (j.propertyId) return !!(d['j:' + j.key] || (j.type === 'sold_out' && d['sold:' + j.propertyId]));
    return !!(d['j:' + j.key] && Date.now() - d['j:' + j.key] < 3 * DAY);
  }
  // What a reply meant for the numbers: positive (wants something — a call, a visit, options…),
  // negative (stop, not interested) or neutral (ok / thanks). The rules module's reading when it
  // has one; else the plain one below.
  var POSITIVE = { call: 1, visit: 1, options: 1, feedback: 1, referral: 1, seller: 1, loan: 1, reschedule: 1 };
  var NEGATIVE = { optout: 1, marketing_optout: 1, not_this: 1, found: 1 };
  function sentiment(reply) {
    if (!reply) return '';
    var f = rule('replySentiment'), action = reply.action || 'other';
    if (typeof f === 'function') { try { var s = f(action); if (/^(positive|negative|neutral)$/.test(s)) return s; } catch (e) { /* the plain reading */ } }
    return POSITIVE[action] ? 'positive' : NEGATIVE[action] ? 'negative' : 'neutral';
  }
  // The replies waiting for a person: the ONE rule the bell, Daily task and this dashboard share
  // (leadAttention.replyNeedsPerson — open, and not an ok / STOP / "not this one").
  var NO_PERSON = { ack: 1, optout: 1, marketing_optout: 1, not_this: 1 };
  function needsPerson(l) {
    var LA = window.leadAttention, C = CM(), J = JM();
    if (LA && typeof LA.replyNeedsPerson === 'function') return !!LA.replyNeedsPerson(l);
    if (C && typeof C.replyNeedsPerson === 'function') return !!C.replyNeedsPerson(null, l);
    return !!(J && J.replyIsOpen(l) && l.campaignReply && !NO_PERSON[l.campaignReply.action]);
  }
  function repliesWaiting() {
    return allLeads().filter(function (l) { return l && l.campaignReply && needsPerson(l); }).sort(function (a, b) { return b.campaignReply.at - a.campaignReply.at; });
  }
  // The server's "not now" refusals, however it words them: quiet hours (a person may send anyway)
  // and the Marketing window (offers only 10 AM – 8 PM — nobody may override it).
  function isQuietRefusal(e) {
    var d = (e && e.data) || {};
    return !!(d.quietHours || d.code === 'quiet_hours' || d.reason === 'quiet_hours' || d.canOverride === false || /quiet hours/i.test((e && e.message) || ''));
  }
  function quietNow() { var st = settings(); return CM().inQuietHours(Date.now(), st.quietStart, st.quietEnd); }
  function quietSpan() { var st = settings(), C = CM(); return C.hourLabel(st.quietStart) + ' – ' + C.hourLabel(st.quietEnd); }
  // "12 opted out · 2 messaged recently" from the server's skipped list ({ key, why }).
  function whySummary(list) {
    var n = {}, order = [];
    (list || []).forEach(function (s) { var w = (s && s.why) || 'held back'; if (!n[w]) { n[w] = 0; order.push(w); } n[w]++; });
    return order.map(function (w) { return n[w] + ' ' + w; }).join(' · ');
  }

  // ─── templates ───────────────────────────────────────────────────────
  var STATUS_META = {
    APPROVED: ['Approved', 'ok'], PENDING: ['In review', 'wait'], IN_REVIEW: ['In review', 'wait'], SUBMITTED: ['Submitted — awaiting TailorTalk', 'wait'],
    REJECTED: ['Rejected', 'bad'], PAUSED: ['Paused', 'bad'], DISABLED: ['Disabled', 'bad'], DRAFT: ['Draft', 'draft']
  };
  function statusPill(st) { var m = STATUS_META[st] || [st || 'Unknown', 'draft']; return '<span class="cmp-pill s-' + m[1] + '">' + esc(m[0]) + '</span>'; }
  function catPill(c) { return c ? '<span class="cmp-cat c-' + esc(String(c).toLowerCase()) + '">' + esc(c === 'UTILITY' ? 'Utility' : c === 'MARKETING' ? 'Marketing' : c) + '</span>' : ''; }
  function approved() { return (S.templates || []).filter(function (t) { return t.status === 'APPROVED'; }); }
  function tplByName(n) { return (S.templates || []).find(function (t) { return t.name === n; }) || null; }
  function purposeOf(t) {
    if (!t) return '';
    if (t.purpose) return t.purpose;
    var C = CM();
    if (C && typeof C.purposeOf === 'function') return C.purposeOf(t);
    var n = t.name;
    // The more particular names first: a "feedback nudge" is not the feedback ask itself.
    if (/nudge/.test(n)) return 'feedback_nudge';
    if (/referr|review|after_purchase/.test(n)) return 'referral';
    if (/options?_follow/.test(n)) return 'options_followup';
    if (/feedback/.test(n)) return 'visit_feedback';
    if (/sold/.test(n)) return 'sold_out';
    if (/remind/.test(n)) return 'visit_reminder';
    if (/confirm/.test(n)) return 'visit_confirmed';
    if (/re_?engage/.test(n)) return 'reengage';
    if (/new_listing|just_listed/.test(n)) return 'new_listing';
    if (/follow/.test(n)) return 'followup';
    if (/price_drop/.test(n)) return 'price_drop';
    if (/price/.test(n)) return 'price_update';
    if (/brochure/.test(n)) return 'brochure';
    return '';
  }
  // The words either side of a variable in the template's text — what {{2}} means is "visit to
  // {{2}} on", not the number.
  function varContext(t, v) {
    var text = String((t && ((t.header || '') + '\n' + (t.body || ''))) || '');
    var re = new RegExp('\\{\\{\\s*' + String(v).replace(/[^a-z0-9_]/gi, '') + '\\s*\\}\\}');
    var m = re.exec(text);
    if (!m) return null;
    // Only the words on the same line, without WhatsApp's *bold* / _italic_ marks.
    var clean = function (x) { return x.replace(/[*_~]/g, '').replace(/\{\{[^}]*\}\}/g, '…'); };
    var before = clean(text.slice(0, m.index).split('\n').pop()).split(/\s+/).filter(Boolean).slice(-3).join(' ');
    var after = clean(text.slice(m.index + m[0].length).split('\n')[0]).split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
    return { before: before, after: after };
  }
  // A numbered variable says nothing about itself: its meaning is guessed from the words around it
  // ("Hi {{1}}" a name, "visit to {{2}}" the property, "on {{3}}" the date). Named ones keep the
  // rules module's guess from the name.
  function guessFromWords(ctx, prevSource) {
    if (!ctx) return '';
    var b = ctx.before.toLowerCase(), a = ctx.after.toLowerCase();
    if (/(^|\s)(hi|hello|dear|namaste|vanakkam|hey)[\s,!]*$/.test(b) || /^(sir|madam|ji)\b/.test(a)) return 'lead_name';
    if (/\b(code|ref)[\s:#-]*$/.test(b)) return 'code';
    if (/(₹|rs\.?|price|now at|at just|starting)\s*$/.test(b)) return 'price';
    if (/\bon\s*$/.test(b) && !/\bcall\b/.test(b)) return 'visit_date';
    if (/\b(at|by)\s*$/.test(b) && (prevSource === 'visit_date' || /(am|pm)\b/.test(a))) return 'visit_time';
    if (/\b(in|area|locality|location)\s*$/.test(b)) return 'area';
    if (/\b(bhk|configuration)\b/.test(a)) return 'config';
    if (/(visit(ing)? to|visited|update on|about|brochure for|details of|for|of|at)\s*$/.test(b)) return 'property';
    if (/\b(call|reach|contact)\b[^…]*$/.test(b) && /\b(on|at)\s*$/.test(b)) return 'agent_phone';
    return '';
  }
  function autoMap(t, prev) {
    var C = CM(), vars = (t && t.vars) || [];
    var m = C.autoMapping(vars, prev || {});
    if (C.isPositional(vars)) {
      var last = '';
      vars.slice().sort(function (a, b) { return a - b; }).forEach(function (v) {
        if (prev && prev[v] && prev[v].source) { last = prev[v].source; return; }
        var g = guessFromWords(varContext(t, v), last);
        if (g) m[v] = { source: g, text: '' };
        last = m[v].source;
      });
    }
    return m;
  }
  // A template a journey can use as it is: its text is known and every variable has somewhere to
  // come from (nothing left to type by hand).
  function canFill(t) {
    if (!t || !Array.isArray(t.vars)) return false;
    var m = autoMap(t, {});
    return t.vars.every(function (v) { return m[v] && m[v].source !== 'fixed'; });
  }
  function templateFor(purpose) {
    var list = approved().filter(function (t) { return purposeOf(t) === purpose && canFill(t); });
    return list.sort(function (a, b) { return (b.lastUsedAt || 0) - (a.lastUsedAt || 0); })[0] || null;
  }
  // An approved template for the purpose that this cannot fill on its own (its text is unknown, or
  // a variable has no source) — the card says so instead of picking it.
  function stuckFor(purpose) { return approved().filter(function (t) { return purposeOf(t) === purpose && !canFill(t); })[0] || null; }
  // A template for this purpose that is not approved yet (in review, or a draft) — the journey
  // card says so rather than offering to write another.
  function pendingFor(purpose) { return (S.templates || []).find(function (t) { return t.status !== 'APPROVED' && !/REJECTED|PAUSED|DISABLED/.test(t.status) && purposeOf(t) === purpose; }) || null; }
  function starterTitle(purpose) { var st = CM().STARTERS.find(function (x) { return x.purpose === purpose; }); return st ? st.title : String(purpose || '').replace(/_/g, ' '); }
  function bubble(t, values, opts) {
    opts = opts || {};
    var C = CM();
    var fill = function (s) { return esc(C.fillText(s, values || {})).replace(/\{\{([a-z0-9_]+)\}\}/gi, '<mark>{{$1}}</mark>').replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>'); };
    var btns = (t.buttons || []).map(function (b) { return '<span class="cmp-bb">' + esc((b && b.text) || b) + '</span>'; }).join('');
    return '<div class="cmp-bubble' + (opts.small ? ' sm' : '') + '">'
      + (t.mediaHeader ? '<div class="cmp-bmedia"><i class="fa-regular fa-file-pdf" aria-hidden="true"></i> ' + esc(opts.mediaName || 'Brochure / image') + '</div>' : '')
      + (t.header ? '<div class="cmp-bh">' + fill(t.header) + '</div>' : '')
      + '<div class="cmp-bt">' + (t.body ? fill(t.body) : '<i class="cmp-muted">' + esc(opts.empty || 'The text of this template is not known here yet.') + '</i>') + '</div>'
      + (t.footer ? '<div class="cmp-bf">' + esc(t.footer) + '</div>' : '')
      + (btns ? '<div class="cmp-bbs">' + btns + '</div>' : '')
      + '</div>';
  }

  // ─── where the screen is: the address bar, Back, reload ───────────────
  // Every screen change a person makes adds a history entry (#campaigns, #cmp-templates,
  // #cmp-new/2, #cmp-history, #cmp/<id>); Back walks them, and a reload opens the same screen —
  // the wizard itself is kept in this tab's sessionStorage. A redraw that is not a move (a leads
  // snapshot, a load finishing) only rewrites the current entry.
  var nav = { push: false, restoring: false, backPending: 0, queued: null, timer: null };
  function hashFor() {
    if (S.view === 'cmp-new') return '#cmp-new/' + ((S.wiz && S.wiz.step) || 1);
    if (S.view === 'cmp-history') return S.detailId && (S.detail || S.detailLoading || S.detailError) ? '#cmp/' + encodeURIComponent(S.detailId) : '#cmp-history';
    if (S.view === 'cmp-templates') return '#cmp-templates';
    return '#campaigns';
  }
  function syncUrl() {
    var want = hashFor();
    if (location.hash === want) { nav.push = false; return; }
    var url = location.pathname + location.search + want;
    if (nav.push && !nav.restoring) {
      // A dialog's entry is still being taken out (history.back() lands later): the new entry
      // waits for it, else that back would take the new one away instead.
      if (nav.backPending) nav.queued = url;
      else try { history.pushState({ cmp: want }, '', url); } catch (e) { /* no history API */ }
    } else {
      try { history.replaceState(history.state, '', url); } catch (e) { /* no history API */ }
    }
    nav.push = false;
  }
  function flushQueued() {
    clearTimeout(nav.timer);
    nav.backPending = 0;
    if (nav.queued) { var u = nav.queued; nav.queued = null; try { history.pushState({ cmp: u.slice(u.indexOf('#')) }, '', u); } catch (e) { /* no history API */ } }
  }
  // AppNav may not go back at all (the entry was already gone): the queued entry goes in anyway.
  function armBackTimer() { clearTimeout(nav.timer); nav.timer = setTimeout(flushQueued, 1500); }
  // The step a wizard may stand on: a template first, someone ticked before the review.
  function allowedStep(n) {
    var w = S.wiz;
    if (!w) return 1;
    n = Math.max(1, Math.min(4, Number(n) || 1));
    if (n >= 2 && S.templates && !(wizTemplate() && wizTemplate().vars !== null)) return 1;
    if (n === 4 && S.templates && !wizRows().some(function (r) { return r.on; })) return 3;
    return n;
  }
  function parseHash(h) {
    var m = /^#(campaigns|cmp-templates|cmp-history|cmp-new(?:\/(\d))?|cmp\/(.+))$/.exec(h || '');
    if (!m) return null;
    if (m[3]) { var id = m[3]; try { id = decodeURIComponent(id); } catch (e) { /* as typed */ } return { view: 'cmp-history', id: id }; }
    if (/^cmp-new/.test(m[1])) return { view: 'cmp-new', step: Number(m[2]) || 1 };
    return { view: m[1] };
  }
  // The address names a screen: show it (Back / Forward, or a reload).
  function restoreHash() {
    var p = parseHash(location.hash);
    if (!p) return;
    var h = host(), shown = h && h.style.display !== 'none';
    nav.restoring = true;
    try {
      S.view = p.view;
      if (p.view === 'cmp-history' && p.id) {
        if (S.detailId !== p.id || !(S.detail || S.detailLoading || S.detailError)) loadCampaign(p.id);
      } else if (p.view === 'cmp-history') {
        S.detail = null; S.detailError = null; S.detailLoading = false; S.detailId = null;
      } else if (p.view === 'cmp-new') {
        if (!S.wiz) S.wiz = loadWiz() || newWizard();
        S.wiz.step = allowedStep(p.step);
      }
      if (!shown && typeof toggleView === 'function') toggleView(p.view);
      else render();
    } finally { nav.restoring = false; }
  }
  window.addEventListener('popstate', function () {
    // Our own dialog closing (closeLayer's history.back): not a move.
    if (nav.backPending) { nav.backPending--; if (!nav.backPending) flushQueued(); return; }
    if (parseHash(location.hash)) return restoreHash();
    // Back past the first Campaigns screen: to the board or list the person came from.
    var h = host();
    if (h && h.style.display !== 'none' && !S.modal && !S.editor && !S.sending && typeof toggleView === 'function') {
      toggleView(typeof lastBrowseView !== 'undefined' ? lastBrowseView : 'kanban');
    }
  });
  // Leaving Campaigns (the rail, a lead's link): the address stops naming a Campaigns screen, so a
  // reload does not bring it back.
  function watchLeave() {
    var h = host();
    if (!h || !window.MutationObserver) return;
    new MutationObserver(function () {
      if (h.style.display === 'none' && parseHash(location.hash)) {
        try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* no history API */ }
      }
    }).observe(h, { attributes: true, attributeFilter: ['style'] });
  }
  // Opened with an address that names a screen (a reload, a bookmark): open it. A ?nav= link wins —
  // nav-boot.js opens that one.
  setTimeout(function () {
    watchLeave();
    watchCloseLayer();
    if (/[?&]nav=/.test(location.search) || !parseHash(location.hash)) return;
    restoreHash();
  }, 0);
  // The wizard survives a reload in this tab.
  var WIZ_KEY = 'pinCmpWiz';
  function saveWiz() {
    if (!S.wiz) return;
    try { sessionStorage.setItem(WIZ_KEY, JSON.stringify(Object.assign({}, S.wiz, { aiBusy: false, req: null }))); } catch (e) { /* too big, or private mode */ }
  }
  function loadWiz() {
    try { var w = JSON.parse(sessionStorage.getItem(WIZ_KEY) || 'null'); return w && w.f ? Object.assign(newWizard(), w) : null; } catch (e) { return null; }
  }
  function dropWiz() { try { sessionStorage.removeItem(WIZ_KEY); } catch (e) { /* nothing stored */ } }

  // ─── dialogs: one history entry each, Back closes, focus kept inside and handed back ──
  var layerOn = { modal: false, editor: false };
  function syncLayers() {
    var N = window.AppNav;
    if (!N || !N.openLayer) return;
    watchCloseLayer();
    var want = { modal: !!S.modal, editor: !!S.editor };
    ['modal', 'editor'].forEach(function (k) {
      if (!want[k] && layerOn[k]) { layerOn[k] = false; N.closeLayer('cmp-' + k); }
    });
    ['modal', 'editor'].forEach(function (k) {
      if (want[k] && !layerOn[k]) { layerOn[k] = true; N.openLayer('cmp-' + k, function () { layerOn[k] = false; closedByBack(k); }); }
    });
  }
  // Any panel closed from the page (a dialog here, a lead on the CRM) takes its history entry out
  // with history.back(); that Back is not the person's, so it must not move the screen. Every
  // closeLayer is counted here, whoever calls it.
  function watchCloseLayer() {
    var N = window.AppNav;
    if (!N || !N.closeLayer || N.closeLayer.cmpCounted) return;
    var orig = N.closeLayer;
    N.closeLayer = function () { nav.backPending++; armBackTimer(); return orig.apply(this, arguments); };
    N.closeLayer.cmpCounted = true;
  }
  // The phone's Back (or the browser's) closed a dialog: the same as its Cancel.
  function closedByBack(k) {
    if (k === 'editor') {
      if (S.editor && editorDirty() && !confirm('Discard your changes to this template?')) return render();
      S.editor = null; return render();
    }
    if (!S.modal) return;
    if (S.busy.send) return render();              // sending has started: it stays until it is done
    if (S.modal.quiet) return A.quietCancel();
    if (S.modal.onClose) S.modal.onClose();
    S.modal = null; render();
  }
  function openModal(f) { S.modal = f; render(); }
  // The button that opened a dialog, found again after the redraw (the old one is gone).
  function describeEl(el) {
    if (!el || el === document.body || !el.getAttribute) return null;
    return { id: el.id || '', click: el.getAttribute('onclick') || '', text: (el.textContent || '').trim().slice(0, 80) };
  }
  function findEl(d) {
    if (!d) return null;
    if (d.id) { var byId = document.getElementById(d.id); if (byId) return byId; }
    if (!d.click) return null;
    var all = Array.prototype.filter.call(host().querySelectorAll('[onclick]'), function (e) { return e.getAttribute('onclick') === d.click; });
    return all.find(function (e) { return (e.textContent || '').trim().slice(0, 80) === d.text; }) || all[0] || null;
  }
  function focusables(box) {
    return Array.prototype.filter.call(box.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])'), function (e) { return !e.disabled && e.offsetParent !== null; });
  }

  // ─── shell ───────────────────────────────────────────────────────────
  function host() { return document.getElementById('campaignsView'); }
  // A box losing focus while the screen is replaced fires its change handler, which asks for
  // another redraw in the middle of this one — that one waits until this one is done.
  var rendering = false, renderAgain = false;
  function render() {
    var h = host();
    if (!h || h.style.display === 'none') return;
    // The shared rules are an ES module, run after this script: a redraw asked for before then
    // (a leads snapshot arriving early) waits for it rather than failing.
    if (!CM()) { clearTimeout(render.wait); render.wait = setTimeout(render, 60); return; }
    if (rendering) { renderAgain = true; return; }
    rendering = true;
    try { paint(h); } finally { rendering = false; }
    if (renderAgain) { renderAgain = false; setTimeout(render, 0); }
  }
  var lastModal = null;
  function paint(h) {
    // The rail shows which of the four screens this is, however it was reached.
    if (typeof currentView !== 'undefined' && currentView !== S.view) {
      currentView = S.view;
      if (window.AppNav) window.AppNav.setActive(S.view);
    }
    var a = document.activeElement;
    // A value typed into a row and not committed yet (no change event) survives a redraw that
    // arrives meanwhile — a leads snapshot, a load finishing.
    if (a && a.dataset && a.dataset.rk && S.wiz && h.contains(a) && a.value !== a.defaultValue) {
      var ed = S.wiz.edits[a.dataset.rk] = S.wiz.edits[a.dataset.rk] || {};
      ed[a.dataset.rv] = a.value;
    }
    var body = S.view === 'cmp-templates' ? templatesHtml() : S.view === 'cmp-new' ? wizardHtml() : S.view === 'cmp-history' ? historyHtml() : dashHtml();
    var keepScroll = window.scrollY;
    // A box being typed in keeps its caret through the redraw: found again by its id or handler.
    var focusKey = null, selA = 0, selB = 0;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && document.body.contains(a) && (h.contains(a) || a.closest('.cmp-modal'))) {
      focusKey = a.id ? '#' + a.id : a.getAttribute('oninput') || a.getAttribute('onchange');
      try { selA = a.selectionStart; selB = a.selectionEnd; } catch (e) { /* not a text box */ }
    }
    var hadModal = lastModal;
    // The four screens are places, not tabs of one panel: a nav of buttons, the current one marked.
    h.innerHTML = '<div class="cmp-wrap">'
      + '<nav class="cmp-tabs" aria-label="WhatsApp Campaigns">' + TABS.map(function (t) {
        return '<button type="button"' + (S.view === t[0] ? ' aria-current="page"' : '') + ' class="cmp-tab' + (S.view === t[0] ? ' on' : '') + '" onclick="PinCampaigns.go(' + js(t[0]) + ')"><i class="' + t[2] + '" aria-hidden="true"></i><span class="cmp-tl">' + t[1] + '</span><span class="cmp-ts" aria-hidden="true">' + t[3] + '</span></button>';
      }).join('') + '<button type="button" class="cmp-tab cmp-gear" onclick="PinCampaigns.openSettings()" aria-label="Campaign settings" title="Campaign settings"><i class="fa-solid fa-sliders" aria-hidden="true"></i><span class="cmp-tl">Settings</span></button></nav>'
      + body + '</div>' + (S.editor ? editorHtml() : '') + (S.modal ? S.modal() : '') + (S.sending ? sendingHtml() : '');
    window.scrollTo(0, keepScroll);
    if (focusKey) {
      var b = focusKey.charAt(0) === '#' ? document.getElementById(focusKey.slice(1))
        : Array.prototype.find.call(h.querySelectorAll('input,textarea,select'), function (el) { return el.getAttribute('oninput') === focusKey || el.getAttribute('onchange') === focusKey; });
      if (b) { b.focus(); try { b.setSelectionRange(selA, selB); } catch (e) { /* not a text box */ } } else focusKey = null;
    }
    // A dialog that has just opened takes the focus, so the keyboard is inside it (Esc closes it);
    // one that has just closed hands it back to the button that opened it.
    var box = h.querySelector('.cmp-modal .cmp-mbox');
    var modalId = S.sending ? 'sending' : S.editor ? 'editor' : S.modal ? S.modal : null;
    if (box && !hadModal && !S.opener) S.opener = describeEl(a);
    if (box && modalId !== lastModal && !focusKey) {
      var first = box.querySelector('input:not([type=hidden]):not([readonly]),textarea:not([readonly]),select') || box.querySelector('.cmp-mfoot .tsk-btn.primary:not([disabled])') || box.querySelector('textarea,button');
      if (first) try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
    }
    if (!box && hadModal) {
      var back = findEl(S.opener);
      S.opener = null;
      if (back && !focusKey) try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); }
    }
    lastModal = box ? modalId : null;
    // A new wizard step: the keyboard and a screen reader start at its heading.
    if (S.focusStep) {
      S.focusStep = false;
      var sh = document.getElementById('cmpStepH');
      if (sh && !box) try { sh.focus({ preventScroll: true }); } catch (e) { sh.focus(); }
    }
    afterRender();
    syncLayers();
    syncUrl();
    if (S.view === 'cmp-new') saveWiz();
  }
  function afterRender() {
    if (S.view === 'cmp-new' && S.wiz && S.wiz.step === 2) {
      var sel = document.getElementById('cmpPropSel');
      // attach() marks the select itself (data-ppk) and skips one already marked — marking it
      // here first meant the search box never appeared.
      if (sel && !sel.dataset.ppk && window.PinPropertyPicker) {
        try { window.PinPropertyPicker.attach(sel, { lookup: function (v) { return propById(v); }, placeholder: 'Type a code, name or area' }); } catch (e) { /* plain select */ }
      }
      // No properties to pick from: the inventory was asked for before it could be read (or the
      // read failed). Ask again, once per visit to this step, and redraw when it arrives.
      if (!inv().length && !S.invRetry && typeof loadInventory === 'function') {
        S.invRetry = true;
        whenFirestore().then(function () { return loadInventory(); }).then(function (list) {
          if (list && list.length) { S.jCache = null; render(); }
        }).finally(function () { setTimeout(function () { S.invRetry = false; }, 3000); });
      }
    }
  }
  function head(title, sub, actions) {
    return '<header class="tsk-head"><div class="tsk-hl"><h1 class="tsk-title">' + esc(title) + '</h1>' + (sub ? '<p class="tsk-sub">' + sub + '</p>' : '') + '</div>'
      + (actions ? '<div class="tsk-hacts">' + actions + '</div>' : '') + '</header>';
  }

  // ─── dashboard ───────────────────────────────────────────────────────
  function campaignsSince(ms) { return (S.campaigns || []).filter(function (c) { return (c.createdAt || 0) >= ms; }); }
  function sum(list, k) { return list.reduce(function (a, c) { return a + ((c.counts && c.counts[k]) || 0); }, 0); }
  function kpi(label, value, note, cls) {
    return '<div class="cmp-kpi' + (cls ? ' ' + cls : '') + '"><b>' + esc(value) + '</b><span>' + esc(label) + '</span>' + (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';
  }
  // How a set of campaigns landed: positive replies, visits booked, and what each cost. The rules
  // module's campaignStats when it has one; the same sums from the leads' campaign logs otherwise.
  function statsFor(list, opts) {
    opts = opts || {};
    var C = CM(), J = JM(), st = settings();
    // One campaign with its recipients: the rules module's scorecard (14-day visit window, the
    // cost of the ones it reached).
    if (opts.recipients && list.length === 1 && typeof C.campaignStats === 'function') {
      try {
        var s = C.campaignStats(list[0], leadsMap(), Date.now(), st);
        if (s && typeof s.positive === 'number') {
          return { sent: s.reached, replied: s.replied, positive: s.positive, positivePct: C.pct(s.positive, s.reached), visits: s.visitsBooked, cost: s.cost,
            costPerPositive: s.costPerPositive, costPerVisit: s.costPerVisit, optOuts: s.optOuts, counting: s.counting };
        }
      } catch (e) { /* the sums below */ }
    }
    var ids = {}, cost = 0, sent = 0, replied = 0, visits = 0, positive = 0;
    list.forEach(function (c) {
      ids[c.id] = 1;
      var k = c.counts || {};
      var n = c.mode === 'csv' ? 0 : (k.sent || 0);
      sent += n; replied += k.replied || 0;
      cost += C.estimateCost(n, c.category, st).total;
      if (J && c.mode !== 'csv') visits += J.outcomeFor(c.leadIds || [], c.createdAt || 0, allLeads(), crmStages()).visits;
    });
    if (opts.recipients) {
      Object.keys(opts.recipients).forEach(function (k) { if (sentiment(opts.recipients[k].reply) === 'positive') positive++; });
    } else {
      allLeads().forEach(function (l) {
        (l.campaignLog || []).forEach(function (e) { if (e && ids[e.id] && e.status === 'replied' && sentiment({ action: e.action, text: e.reply }) === 'positive') positive++; });
      });
    }
    if (opts.visits != null) visits = opts.visits;
    return { sent: sent, replied: replied, positive: positive, positivePct: C.pct(positive, sent), visits: visits, cost: cost,
      costPerPositive: positive ? cost / positive : null, costPerVisit: visits ? cost / visits : null };
  }
  // The 30-day headline: the scorecards of each campaign added up once they are all in; meanwhile
  // the same sums from the leads' campaign logs.
  function monthStats(month) {
    var C = CM(), sends = month.filter(function (c) { return c.mode !== 'csv'; });
    var full = fullCampaigns(sends);
    if (typeof C.campaignStats !== 'function' || full.length !== sends.length) return statsFor(month);
    var t = { sent: 0, replied: 0, positive: 0, visits: 0, cost: 0 }, map = leadsMap(), st = settings();
    full.forEach(function (c) {
      try { var s = C.campaignStats(c, map, Date.now(), st); t.sent += s.reached; t.replied += s.replied; t.positive += s.positive; t.visits += s.visitsBooked; t.cost += s.cost; } catch (e) { /* left out */ }
    });
    return { sent: t.sent, replied: t.replied, positive: t.positive, positivePct: C.pct(t.positive, t.sent), visits: t.visits, cost: t.cost,
      costPerPositive: t.positive ? t.cost / t.positive : null, costPerVisit: t.visits ? t.cost / t.visits : null };
  }
  var J_ICON = {
    visit_reminder: 'fa-regular fa-bell', visit_feedback: 'fa-regular fa-comment-dots', sold_out: 'fa-solid fa-tag', feedback_nudge: 'fa-regular fa-hand-point-right',
    options_followup: 'fa-regular fa-images', hold_revisit: 'fa-regular fa-calendar-check', new_listing: 'fa-solid fa-house-circle-check',
    lost_reengage: 'fa-solid fa-rotate-left', referral: 'fa-regular fa-star', call: 'fa-solid fa-phone', visit_today: 'fa-regular fa-calendar', no_show: 'fa-regular fa-calendar-xmark',
    search_checkin: 'fa-solid fa-magnifying-glass'
  };
  function waLink(l) { var n = contactOf(l); return n ? 'https://wa.me/' + n : ''; }
  // Leads a journey can reach for free: they wrote in the last 24 hours, so a reply in the chat
  // costs nothing and reads as a conversation, not a campaign.
  function freeLeadsOf(j) {
    if (!j.freeNow) return [];
    var ids = Array.isArray(j.freeNowIds) ? j.freeNowIds : Array.isArray(j.freeNow) ? j.freeNow : (j.leadIds || []);
    return ids.map(leadById).filter(Boolean);
  }
  function leadLinks(list, href, label) {
    var C = CM();
    return list.slice(0, 4).map(function (l) {
      var u = href(l);
      return u ? '<a class="cmp-link sm" href="' + esc(u) + '" target="_blank" rel="noopener" aria-label="' + esc(label + ' ' + (l.name || '')) + '">' + esc(C.greetingName(l.name) || C.prettyNumber(contactOf(l)) || '(no name)') + '</a>' : '';
    }).filter(Boolean).join(', ') + (list.length > 4 ? ' <span class="cmp-muted">and ' + (list.length - 4) + ' more</span>' : '');
  }
  // A call list: the journey says these people are better phoned than messaged.
  function callCardHtml(j) {
    var list = (j.leadIds || []).map(leadById).filter(Boolean);
    return '<div class="cmp-need k-call" data-journey="' + esc(j.key) + '"><i class="' + (J_ICON.call) + '" aria-hidden="true"></i>'
      + '<div><b>' + esc(j.label) + '</b><span>' + esc(j.why || 'Better a call than a message') + '</span>'
      + '<span class="cmp-jtpl"><span class="cmp-muted">Call:</span> ' + leadLinks(list, function (l) { var n = contactOf(l); return n ? 'tel:+' + n : ''; }, 'Call') + '</span></div>'
      + '<div class="cmp-need-acts"><button type="button" class="cmp-x" aria-label="Hide this suggestion" title="Hide for now" onclick="PinCampaigns.dismiss(' + js('j:' + j.key) + ')">×</button></div></div>';
  }
  // One suggested message: who, why, the template it would use — and one tap to review it.
  function journeyHtml(j) {
    if (j.action === 'call' || j.type === 'call') return callCardHtml(j);
    var t = templateFor(j.purpose), stuck = t ? null : stuckFor(j.purpose), pend = t || stuck ? null : pendingFor(j.purpose);
    var free = freeLeadsOf(j), allFree = free.length && free.length >= (j.leadIds || []).length;
    var tplLine = t ? 'Template: <span class="cmp-tn">' + esc(t.name) + '</span> ' + catPill(t.category)
      : stuck ? '<span class="cmp-warn">' + esc(stuck.name) + (Array.isArray(stuck.vars) ? ' has words this cannot fill by itself (' + esc(stuck.vars.filter(function (v) { return (autoMap(stuck, {})[v] || {}).source === 'fixed'; }).map(function (v) { return '{{' + v + '}}'; }).join(', ')) + ')' : '’s text is not known here — add it on Templates') + '</span>'
      : pend ? '<span class="cmp-warn">Its template ' + esc(pend.name) + ' is ' + esc(((STATUS_META[pend.status] || [pend.status])[0]).toLowerCase()) + ' — it can be sent once approved</span>'
      : '<span class="cmp-warn">No approved “' + esc(starterTitle(j.purpose)) + '” template yet</span>';
    var act = allFree ? ''
      : t ? '<button type="button" class="tsk-btn primary" onclick="PinCampaigns.journey(' + js(j.key) + ')" aria-label="Review and send: ' + esc(j.label) + '">Review &amp; send</button>'
      : stuck ? (Array.isArray(stuck.vars) ? '<button type="button" class="tsk-btn" onclick="PinCampaigns.journey(' + js(j.key) + ',true)">Fill it in</button>' : '<button type="button" class="tsk-btn" onclick="PinCampaigns.describe(' + js(stuck.name) + ')">Add its text</button>')
      : pend ? '<button type="button" class="tsk-btn" onclick="PinCampaigns.tplFilter(' + js(pend.status === 'DRAFT' ? 'draft' : 'review') + ');PinCampaigns.go(\'cmp-templates\')">Templates</button>'
      : '<button type="button" class="tsk-btn" onclick="PinCampaigns.createFor(' + js(j.purpose) + ')"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Create it</button>';
    // Leads a Marketing card left out, and why (the server's own words) — so the count is honest.
    var heldLine = Array.isArray(j.held) && j.held.length ? '<span class="cmp-muted cmp-jheld">' + j.held.length + ' left out: ' + esc(whySummary(j.held)) + '</span>' : '';
    var noteLine = j.note ? '<span class="cmp-muted cmp-jnote"><i class="fa-regular fa-clock" aria-hidden="true"></i> ' + esc(j.note) + '</span>' : '';
    var freeLine = free.length ? '<span class="cmp-jtpl cmp-free"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i> <b>Free now — reply in chat</b>' + (allFree ? '' : ' <span class="cmp-muted">(they wrote in the last 24 h)</span>') + ': ' + leadLinks(free, waLink, 'Reply in WhatsApp to') + '</span>' : '';
    return '<div class="cmp-need k-' + esc(j.type) + '" data-journey="' + esc(j.key) + '"><i class="' + (J_ICON[j.type] || 'fa-regular fa-paper-plane') + '" aria-hidden="true"></i>'
      + '<div><b>' + esc(j.label) + '</b><span>' + esc(j.why) + '</span>' + (allFree ? '' : '<span class="cmp-jtpl">' + tplLine + '</span>') + freeLine + noteLine + heldLine + '</div>'
      + '<div class="cmp-need-acts">' + act + '<button type="button" class="cmp-x" aria-label="Hide this suggestion" title="Hide for now" onclick="PinCampaigns.dismiss(' + js('j:' + j.key) + ')">×</button></div></div>';
  }
  // The campaign list carries counts, not recipients; the scorecards need the recipients, so the
  // recent ones are fetched once each in the background (and again when their counts move).
  S.full = {};
  function loadFull() {
    if (loadFull.busy || !S.campaigns) return;
    var want = S.campaigns.filter(function (c) { return c.mode !== 'csv' && Date.now() - (c.createdAt || 0) < 90 * DAY && !(c.id in S.full); }).slice(0, 25);
    if (!want.length) return;
    loadFull.busy = true;
    (async function () {
      for (var i = 0; i < want.length; i++) {
        try { var r = await api('get', { id: want[i].id }); S.full[want[i].id] = r.campaign || null; } catch (e) { S.full[want[i].id] = null; }
      }
      loadFull.busy = false;
      render();
    })();
  }
  function fullCampaigns(list) { return list.map(function (c) { return S.full[c.id]; }).filter(Boolean); }
  var JOURNEY_TITLE = function (k) { var J = JM(), d = J && J.JOURNEYS && J.JOURNEYS.find(function (x) { return x.journey === k || x.type === k; }); return d ? d.title : k ? String(k).replace(/_/g, ' ') : 'Picked by hand'; };
  // Which template, sent by which journey, earns its keep (campaignModel.templateJourneyTable).
  function journeyTableHtml() {
    var C = CM();
    if (typeof C.templateJourneyTable !== 'function' || !S.campaigns) return '';
    var rows;
    try { rows = C.templateJourneyTable(fullCampaigns(S.campaigns), leadsMap(), Date.now(), settings()); } catch (e) { return ''; }
    if (!Array.isArray(rows) || !rows.length) return '';
    var money = function (x) { return x == null ? '—' : '≈ ' + C.rupees(x); };
    return '<section class="cmp-card" aria-labelledby="cmpJtH"><h2 class="cmp-h2" id="cmpJtH">Which template works</h2><div class="cmp-tablewrap"><table class="cmp-table"><thead><tr><th scope="col">Template</th><th scope="col">Sent by</th><th scope="col">Sends</th><th scope="col">Positive</th><th scope="col">Opted out</th><th scope="col">Visits per 100</th><th scope="col">Cost per visit</th></tr></thead><tbody>'
      + rows.slice(0, 20).map(function (r) {
        return '<tr><th scope="row"><span class="cmp-tn">' + esc(r.template) + '</span></th><td>' + esc(JOURNEY_TITLE(r.journey)) + '</td><td>' + esc(r.sends) + '</td><td>' + esc(r.positivePct) + '%</td><td>' + esc(r.optOutPct) + '%</td><td>' + esc(r.visitsPer100) + '</td><td>' + esc(money(r.costPerVisit)) + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="cmp-note">The last 90 days of campaigns sent from here. Visits are those booked within 14 days of a message; costs are approximate.</p></section>';
  }
  function dashHtml() {
    var C = CM();
    var tpl = S.templates || [];
    var nApproved = tpl.filter(function (t) { return t.status === 'APPROVED'; }).length;
    var nReview = tpl.filter(function (t) { return /PENDING|IN_REVIEW|SUBMITTED/.test(t.status); }).length;
    var nDraft = tpl.filter(function (t) { return t.status === 'DRAFT'; }).length;
    var bad = tpl.filter(function (t) { return /REJECTED|PAUSED|DISABLED/.test(t.status); });
    var month = campaignsSince(Date.now() - 30 * DAY);
    var sent = sum(month, 'sent'), deliv = sum(month, 'delivered'), read = sum(month, 'read'), rep = sum(month, 'replied'), fail = sum(month, 'failed'), exp = sum(month, 'exported');
    var waiting = repliesWaiting();
    var stats = S.campaigns ? monthStats(month) : null;

    // Suggested messages: the stage journeys due now, minus the ones someone hid.
    var d = dismissed(), all = journeys();
    var shownJ = all.filter(function (j) { return !isHidden(j, d); }), hiddenN = all.length - shownJ.length;
    var suggest = !S.campaigns ? '<p class="cmp-empty" role="status">' + (S.cmpError ? esc(S.cmpError) + ' <button type="button" class="cmp-link" onclick="PinCampaigns.reload()">Try again</button>' : '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Working out who is due a message…') + '</p>'
      : shownJ.length ? shownJ.map(journeyHtml).join('')
      : '<p class="cmp-empty">Nobody is due a message right now. Tomorrow’s visits, this week’s feedback, sold-out properties, new listings with matching buyers and on-hold dates show up here as they come due.</p>';

    // Needs a person: replies, failures, template problems.
    var needs = [];
    if (waiting.length) needs.push('<div class="cmp-need k-reply"><i class="fa-regular fa-comments" aria-hidden="true"></i><div><b>' + waiting.length + ' repl' + (waiting.length === 1 ? 'y' : 'ies') + ' waiting for a person</b><span>' + esc(waiting.slice(0, 2).map(function (l) { return (C.greetingName(l.name) || 'A lead') + ': ' + C.replyMeaning(l.campaignReply.action).toLowerCase(); }).join(' · ')) + (waiting.length > 2 ? ' · …' : '') + '</span></div><div class="cmp-need-acts"><button type="button" class="tsk-btn primary" onclick="PinCampaigns.openReplies()">See them</button></div></div>');
    bad.forEach(function (t) { needs.push('<div class="cmp-need k-bad"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><div><b><span class="cmp-tn">' + esc(t.name) + '</span> is ' + esc((STATUS_META[t.status] || [t.status])[0].toLowerCase()) + '</b><span>Campaigns cannot use it — fix it in TailorTalk or write a new one</span></div><div class="cmp-need-acts"><button type="button" class="tsk-btn" onclick="PinCampaigns.tplFilter(\'problem\');PinCampaigns.go(\'cmp-templates\')">Templates</button></div></div>'); });
    var withFails = campaignsSince(Date.now() - 7 * DAY).filter(function (c) { return c.counts && (c.counts.failed || c.counts.sending); });
    withFails.slice(0, 3).forEach(function (c) {
      var k = c.counts;
      needs.push('<div class="cmp-need k-bad"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><div><b>' + [k.failed ? k.failed + ' failed' : '', k.sending ? k.sending + ' unknown' : ''].filter(Boolean).join(' · ') + ' in “' + esc(c.name) + '”</b><span>' + (k.sending ? 'Check them in TailorTalk and mark each one' : 'See why, and retry the ones that can be') + '</span></div><div class="cmp-need-acts"><button type="button" class="tsk-btn" onclick="PinCampaigns.openCampaign(' + js(c.id) + ')">Open</button></div></div>');
    });
    if (nDraft) needs.push('<div class="cmp-need k-draft"><i class="fa-regular fa-pen-to-square" aria-hidden="true"></i><div><b>' + nDraft + ' draft template' + (nDraft === 1 ? '' : 's') + ' not yet submitted</b><span>Submit for approval in TailorTalk' + (S.metaReady ? ' or straight to Meta' : '') + '</span></div><div class="cmp-need-acts"><button type="button" class="tsk-btn" onclick="PinCampaigns.tplFilter(\'draft\');PinCampaigns.go(\'cmp-templates\')">Drafts</button></div></div>');

    var funnel = [['Sent', sent], ['Delivered', deliv], ['Read', read], ['Replied', rep], ['Positive', stats ? stats.positive : 0]];
    var recent = (S.campaigns || []).slice(0, 5);
    var loading = function (v) { return S.campaigns ? v : (S.cmpError ? '—' : '…'); };
    return head('WhatsApp Campaigns', 'Templates, lead lists and campaigns, sent through TailorTalk from your number. Everything here goes only to the leads you pick.',
      '<button type="button" class="tsk-btn" onclick="PinCampaigns.newTemplate()"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Create template</button><button type="button" class="tsk-btn primary" onclick="PinCampaigns.startWizard()">+ New campaign</button>')
      + (S.tplError ? '<div class="cmp-alert" role="alert">TailorTalk could not be reached: ' + esc(S.tplError) + ' <button type="button" class="cmp-link" onclick="PinCampaigns.reload()">Try again</button></div>' : '')
      + '<section class="cmp-kpis" aria-label="At a glance">'
      + kpi('Approved templates', S.templates ? nApproved : (S.tplError ? '—' : '…'), nReview ? nReview + ' in review' : '')
      + kpi('Campaigns · 30 days', loading(month.length), exp ? exp + ' sent as CSV' : '')
      + kpi('Messages sent', loading(sent), fail ? fail + ' failed' : (read ? C.pct(read, sent) + '% read' : ''), fail ? 'has-bad' : '')
      + kpi('Positive replies', loading((stats ? stats.positivePct : 0) + '%'), stats ? stats.positive + ' positive · ' + rep + ' repl' + (rep === 1 ? 'y' : 'ies') : '')
      + kpi('Cost per positive reply', loading(stats && stats.costPerPositive != null ? '≈ ' + C.rupees(stats.costPerPositive) : '—'), stats ? (stats.costPerVisit != null ? '≈ ' + C.rupees(stats.costPerVisit) + ' per visit booked' : 'no visit booked yet') + ' · approximate' : '')
      + kpi('Replies waiting', waiting.length, waiting.length ? 'need a person' : 'none open', waiting.length ? 'has-wait' : '')
      + '</section>'
      + '<div class="cmp-grid2">'
      + '<section class="cmp-card" aria-labelledby="cmpSuggestH"><div class="cmp-h2row"><h2 class="cmp-h2" id="cmpSuggestH">Suggested messages</h2>'
      + (hiddenN ? '<button type="button" class="cmp-link" onclick="PinCampaigns.unhideAll()">Show ' + hiddenN + ' hidden</button>' : '') + '</div>'
      + '<p class="cmp-note cmp-lede">Who is due which message today, from their stage in the CRM. Nothing goes out until you review it and press Send.</p>' + suggest + '</section>'
      + '<div class="cmp-col">'
      + '<section class="cmp-card"><h2 class="cmp-h2">Needs a person</h2>' + (needs.length ? needs.join('') : '<p class="cmp-empty">Nothing waiting. Replies, failed messages and template problems show up here.</p>') + '</section>'
      + '<section class="cmp-card"><h2 class="cmp-h2">Last 30 days</h2>' + funnelHtml(funnel) + '<p class="cmp-note">Delivery, read and reply come from WhatsApp through TailorTalk. Positive: a reply asking for a call, a visit, options or details. Open a campaign to refresh them.</p></section>'
      + '</div></div>'
      + journeyTableHtml()
      + '<section class="cmp-card"><div class="cmp-h2row"><h2 class="cmp-h2">Recent campaigns</h2><button type="button" class="cmp-link" onclick="PinCampaigns.go(\'cmp-history\')">All campaigns →</button></div>'
      + (recent.length ? recent.map(function (c) { return campaignRow(c, true); }).join('') : '<p class="cmp-empty">' + (S.campaigns ? 'No campaigns yet. Start with a suggested message above.' : (S.cmpError ? esc(S.cmpError) + ' <button type="button" class="cmp-link" onclick="PinCampaigns.reload()">Try again</button>' : 'Loading…')) + '</p>') + '</section>'
      + '<section class="cmp-card"><div class="cmp-h2row"><h2 class="cmp-h2">Templates</h2><button type="button" class="cmp-link" onclick="PinCampaigns.go(\'cmp-templates\')">Library →</button></div>'
      + (S.templates ? (S.templates.length ? '<div class="cmp-tlist">' + S.templates.slice(0, 8).map(function (t) {
        return '<button type="button" class="cmp-trow" onclick="PinCampaigns.go(\'cmp-templates\')"><span class="cmp-tn">' + esc(t.name) + '</span>' + catPill(t.category) + statusPill(t.status) + '<span class="cmp-muted">' + (t.lastUsedAt ? 'used ' + ago(t.lastUsedAt) : 'not used yet') + '</span></button>';
      }).join('') + '</div>' : '<p class="cmp-empty">No templates yet. <button type="button" class="cmp-link" onclick="PinCampaigns.openStarters()">Start from the library</button></p>')
        : '<p class="cmp-empty" role="status">' + (S.tplLoading ? 'Loading from TailorTalk…' : S.tplError ? 'Templates could not be loaded. <button type="button" class="cmp-link" onclick="PinCampaigns.reload()">Try again</button>' : '—') + '</p>') + '</section>';
  }
  function funnelHtml(rows) {
    var max = Math.max(1, rows[0][1]);
    return '<div class="cmp-funnel" role="img" aria-label="' + esc(rows.map(function (r) { return r[0] + ' ' + r[1]; }).join(', ')) + '">' + rows.map(function (r) {
      return '<div class="cmp-frow" title="' + esc(r[0] + ': ' + r[1]) + '"><span class="cmp-fl">' + r[0] + '</span><span class="cmp-fbar"><i style="width:' + Math.max(r[1] ? 2 : 0, Math.round(r[1] / max * 100)) + '%"></i></span><b>' + r[1] + '</b></div>';
    }).join('') + '</div>';
  }
  function ago(t) {
    var d = Date.now() - t;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.round(d / 60000) + 'm ago';
    if (d < DAY) return Math.round(d / 3600000) + 'h ago';
    return Math.round(d / DAY) + 'd ago';
  }
  function when(t) { return t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''; }
  // One campaign in a list. `results`: also what it led to — replies, and visits booked after it
  // by the leads it reached (from the CRM's live leads).
  function campaignRow(c, results) {
    var k = c.counts || {}, C = CM(), J = JM();
    var base = k.sent || 0;
    var line = c.mode === 'csv' ? (k.exported || 0) + ' in the CSV for TailorTalk Broadcast'
      : base + ' sent · ' + C.pct(k.delivered, base) + '% delivered · ' + C.pct(k.read, base) + '% read · ' + (k.replied || 0) + ' replied' + (k.failed ? ' · ' + k.failed + ' failed' : '') + (k.ready ? ' · ' + k.ready + ' waiting' : '') + (k.sending ? ' · ' + k.sending + ' unknown' : '');
    var res = '';
    if (results && J && c.mode !== 'csv') {
      var o = J.outcomeFor(c.leadIds || [], c.createdAt || 0, allLeads(), crmStages());
      res = 'Results: ' + (k.replied || 0) + ' repl' + (k.replied === 1 ? 'y' : 'ies') + ' · ' + o.visits + ' visit' + (o.visits === 1 ? '' : 's') + ' booked' + (o.won ? ' · ' + o.won + ' won' : '');
    }
    return '<button type="button" class="cmp-crow" onclick="PinCampaigns.openCampaign(' + js(c.id) + ')">'
      + '<span class="cmp-cmain"><b>' + esc(c.name) + '</b><span class="cmp-muted">' + esc(c.template) + ' · ' + esc(when(c.createdAt)) + (c.createdBy ? ' · ' + esc(String(c.createdBy).split('@')[0]) : '') + '</span></span>'
      + '<span class="cmp-cstat"><span class="cmp-mini" aria-hidden="true">' + miniBar(k, c.mode) + '</span><span class="cmp-muted">' + esc(line) + '</span>' + (res ? '<span class="cmp-res">' + esc(res) + '</span>' : '') + '</span></button>';
  }
  function miniBar(k, mode) {
    var t = Math.max(1, k.total || 0);
    if (mode === 'csv') return '<i class="b-exp" style="width:100%"></i>';
    var seg = [['b-rep', k.replied || 0], ['b-read', (k.read || 0) - (k.replied || 0)], ['b-del', (k.delivered || 0) - (k.read || 0)], ['b-sent', (k.sent || 0) - (k.delivered || 0)], ['b-fail', k.failed || 0], ['b-wait', (k.ready || 0) + (k.sending || 0)]];
    return seg.filter(function (s) { return s[1] > 0; }).map(function (s) { return '<i class="' + s[0] + '" style="width:' + (s[1] / t * 100) + '%"></i>'; }).join('');
  }

  // ─── templates screen ─────────────────────────────────────────────────
  function templatesHtml() {
    var list = (S.templates || []).filter(function (t) {
      var f = S.tplFilter;
      if (f === 'approved' && t.status !== 'APPROVED') return false;
      if (f === 'review' && !/PENDING|IN_REVIEW|SUBMITTED/.test(t.status)) return false;
      if (f === 'draft' && t.status !== 'DRAFT') return false;
      if (f === 'problem' && !/REJECTED|PAUSED|DISABLED/.test(t.status)) return false;
      if (S.tplQ && (t.name + ' ' + (t.body || '') + ' ' + (t.header || '')).toLowerCase().indexOf(S.tplQ.toLowerCase()) < 0) return false;
      return true;
    });
    var chips = [['all', 'All'], ['approved', 'Approved'], ['review', 'In review'], ['draft', 'Drafts'], ['problem', 'Rejected / paused']];
    return head('Templates', 'Every WhatsApp template: what TailorTalk has approved, what is in review, and drafts written here. A template is approved by Meta before anything can be sent with it.',
      '<button type="button" class="tsk-btn" onclick="PinCampaigns.reload()"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Refresh</button>'
      + '<button type="button" class="tsk-btn" onclick="PinCampaigns.openStarters()"><i class="fa-regular fa-folder-open" aria-hidden="true"></i> Starter library</button>'
      + '<button type="button" class="tsk-btn primary" onclick="PinCampaigns.newTemplate()"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Create template</button>')
      + '<div class="cmp-steps-note"><b>How a template gets approved:</b> write it here (by hand, from the starter library or with AI) → <b>Copy &amp; open TailorTalk</b>, paste it under Campaign → Templates → Create, and submit' + (S.metaReady ? ' — or <b>Submit to Meta</b> straight from here' : '') + ' → Meta reviews it, usually within minutes → it shows <span class="cmp-pill s-ok">Approved</span> here by itself.</div>'
      + '<div class="cmp-fbar2"><div class="cmp-chips" role="group" aria-label="Show">' + chips.map(function (c) { return '<button type="button" class="cmp-chip' + (S.tplFilter === c[0] ? ' on' : '') + '" aria-pressed="' + (S.tplFilter === c[0]) + '" onclick="PinCampaigns.tplFilter(' + js(c[0]) + ')">' + c[1] + '</button>'; }).join('') + '</div>'
      + '<input class="cmp-search" id="cmpTplQ" type="search" placeholder="Search templates" value="' + esc(S.tplQ) + '" oninput="PinCampaigns.tplSearch(this.value)" aria-label="Search templates"></div>'
      + (S.tplError ? '<div class="cmp-alert">' + esc(S.tplError) + '</div>' : '')
      + (!S.templates ? '<p class="cmp-empty">' + (S.tplLoading ? 'Loading from TailorTalk…' : 'Templates could not be loaded.') + '</p>'
        : list.length ? '<div class="cmp-tgrid">' + list.map(templateCard).join('') + '</div>' : '<p class="cmp-empty">No template matches.</p>');
  }
  function templateCard(t) {
    var C = CM();
    var vars = t.vars || [];
    var acts = [];
    if (t.status === 'APPROVED') acts.push('<button type="button" class="tsk-btn primary sm" onclick="PinCampaigns.useTemplate(' + js(t.name) + ')">Use in a campaign</button>');
    if (!t.inTailorTalk) {
      acts.push('<button type="button" class="tsk-btn sm" onclick="PinCampaigns.editTemplate(' + js(t.name) + ')">Edit</button>');
      acts.push('<button type="button" class="tsk-btn sm' + (t.status === 'DRAFT' ? ' primary' : '') + '" onclick="PinCampaigns.copyToTailorTalk(' + js(t.name) + ')"><i class="fa-regular fa-copy" aria-hidden="true"></i> Copy &amp; open TailorTalk</button>');
      if (S.metaReady) acts.push('<button type="button" class="tsk-btn sm" onclick="PinCampaigns.metaSubmit(' + js(t.name) + ')">Submit to Meta</button>');
      acts.push('<button type="button" class="cmp-link danger" onclick="PinCampaigns.deleteDraft(' + js(t.name) + ')" aria-label="Delete the draft ' + esc(t.name) + '">Delete</button>');
    } else {
      acts.push('<button type="button" class="tsk-btn sm" onclick="PinCampaigns.copyAsNew(' + js(t.name) + ')">Copy as new</button>');
      if (!t.body) acts.push('<button type="button" class="tsk-btn sm" onclick="PinCampaigns.describe(' + js(t.name) + ')">Add its text</button>');
    }
    var lint = !t.inTailorTalk ? C.lintTemplate(t) : { errors: [], warnings: [] };
    return '<article class="cmp-tcard">'
      + '<div class="cmp-tchead"><span class="cmp-tn">' + esc(t.name) + '</span><span class="cmp-tpills">' + catPill(t.category) + statusPill(t.status) + '</span></div>'
      + bubble(t, null, { small: true })
      + '<div class="cmp-tmeta">' + (vars.length ? vars.map(function (v) { return '<code>{{' + esc(v) + '}}</code>'; }).join(' ') : (t.vars === null ? '<span class="cmp-warn">Variables unknown — add its text</span>' : '<span class="cmp-muted">No variables</span>'))
      + (t.lastUsedAt ? ' <span class="cmp-muted">· used ' + ago(t.lastUsedAt) + '</span>' : '')
      + (t.relabelled ? ' <span class="cmp-warn" title="Marketing messages cost more">· ' + esc(t.relabelled) + '</span>' : '') + '</div>'
      + (lint.errors.length ? '<div class="cmp-lint bad">' + esc(lint.errors[0]) + '</div>' : lint.warnings.length ? '<div class="cmp-lint">' + esc(lint.warnings[0]) + '</div>' : '')
      + '<div class="cmp-tacts">' + acts.join('') + '</div></article>';
  }

  // ─── the template editor (by hand, from a starter, or by AI) ──────────
  function blankTemplate() { return { name: '', category: 'UTILITY', language: 'en', header: '', body: '', footer: '- 3PIN Realty', buttons: [], examples: {}, mediaHeader: false, purpose: '' }; }
  function openEditor(t, mode) {
    S.editor = { mode: mode || 'new', t: JSON.parse(JSON.stringify(t)), ai: { purpose: (t && t.purpose) || 'visit_feedback', brief: '', tone: 'friendly', propertyId: '', busy: false, note: '' }, saving: false, showAi: mode === 'new' && !(t && t.body) };
    S.editor.t.buttons = (S.editor.t.buttons || []).map(function (b) { return (b && b.text) || b; });
    S.editor.orig = JSON.stringify(S.editor.t);
    render();
  }
  // Anything typed since the editor opened — closing asks first.
  function editorDirty() { return !!(S.editor && !S.editor.saving && JSON.stringify(S.editor.t) !== S.editor.orig); }
  function editorHtml() {
    var E = S.editor, t = E.t, C = CM();
    var lint = C.lintTemplate(Object.assign({}, t, { buttons: t.buttons }));
    var vars = C.varsIn(t.header, t.body);
    var samples = {};
    vars.forEach(function (v) { samples[v] = C.sampleFor(v, t.examples); });
    var describing = E.mode === 'describe';
    var purposes = C.PURPOSES.map(function (p) { return '<option value="' + esc(p[0]) + '"' + (E.ai.purpose === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('');
    var props = '<option value="">— none —</option>' + inv().filter(function (p) { return !p.soldOut || E.ai.purpose === 'sold_out'; }).slice(0, 400).map(function (p) { return '<option value="' + esc(p.id) + '"' + (E.ai.propertyId === p.id ? ' selected' : '') + '>' + esc((C.propertyCode(p) ? C.propertyCode(p) + ' · ' : '') + C.propertyLabel(p)) + '</option>'; }).join('');
    return '<div class="cmp-modal" role="dialog" aria-modal="true" aria-labelledby="cmpEdH"><div class="cmp-mbox wide">'
      + '<div class="cmp-mhead"><h2 id="cmpEdH">' + (describing ? 'Add the text of ' + esc(t.name) : E.mode === 'edit' ? 'Edit ' + esc(t.name) : 'Create a template') + '</h2><button type="button" class="cmp-x" aria-label="Close" onclick="PinCampaigns.closeEditor()">×</button></div>'
      + '<div class="cmp-ed">'
      + '<div class="cmp-edform">'
      + (describing ? '<p class="cmp-note">TailorTalk’s API gives a template’s name and status but not its words. Paste its header, body and buttons exactly as they are in TailorTalk, so campaigns can show it and fill its variables.</p>' : '')
      + (!describing ? '<details class="cmp-ai"' + (E.showAi ? ' open' : '') + '><summary><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Write it with AI</summary>'
        + '<div class="cmp-row2"><label class="tsk-f"><span>What is it for</span><select onchange="PinCampaigns.aiField(\'purpose\',this.value)">' + purposes + '</select></label>'
        + '<label class="tsk-f"><span>Tone</span><select onchange="PinCampaigns.aiField(\'tone\',this.value)"><option value="friendly"' + (E.ai.tone === 'friendly' ? ' selected' : '') + '>Friendly</option><option value="formal"' + (E.ai.tone === 'formal' ? ' selected' : '') + '>Formal</option></select></label></div>'
        + '<label class="tsk-f"><span>Example property (optional)</span><select onchange="PinCampaigns.aiField(\'propertyId\',this.value)">' + props + '</select></label>'
        + '<label class="tsk-f"><span>Anything it should say</span><textarea rows="2" placeholder="e.g. mention we have similar 3 BHKs in Anna Nagar; ask for their budget" oninput="PinCampaigns.aiField(\'brief\',this.value,1)">' + esc(E.ai.brief) + '</textarea></label>'
        + '<button type="button" class="tsk-btn primary" ' + (E.ai.busy ? 'disabled' : '') + ' onclick="PinCampaigns.aiWrite()">' + (E.ai.busy ? 'Writing…' : (t.body ? 'Write it again' : 'Write it')) + '</button>'
        + (E.ai.note ? '<p class="cmp-note">' + esc(E.ai.note) + '</p>' : '') + '</details>' : '')
        + '<div class="cmp-row2"><label class="tsk-f"><span>Name</span><input id="cmpEdName" ' + (E.mode !== 'new' ? 'readonly' : '') + ' value="' + esc(t.name) + '" placeholder="visit_feedback_v2" oninput="PinCampaigns.edField(\'name\',this.value,1)"></label>'
        + '<label class="tsk-f"><span>Category</span><select onchange="PinCampaigns.edField(\'category\',this.value)"><option value="UTILITY"' + (t.category === 'UTILITY' ? ' selected' : '') + '>Utility — about a visit or enquiry</option><option value="MARKETING"' + (t.category === 'MARKETING' ? ' selected' : '') + '>Marketing — new listings, offers</option></select></label></div>'
        // Asked whatever way the template is being written — by AI, by hand, or its text pasted in.
        + '<div class="cmp-row2"><label class="cmp-check"><input type="checkbox"' + (t.mediaHeader ? ' checked' : '') + ' onchange="PinCampaigns.edField(\'mediaHeader\',this.checked)"> Carries a brochure or photo</label>'
        + '<label class="tsk-f"><span>Language</span><select onchange="PinCampaigns.edField(\'language\',this.value)"><option value="en"' + (t.language !== 'ta' ? ' selected' : '') + '>English</option><option value="ta"' + (t.language === 'ta' ? ' selected' : '') + '>Tamil</option></select></label></div>'
        + (t.mediaHeader ? '<p class="cmp-note"><i class="fa-regular fa-file-pdf" aria-hidden="true"></i> Header: a brochure or photo — each lead’s own property’s brochure, or one file you pick when the campaign is sent.</p>' : '<label class="tsk-f"><span>Header <small>' + t.header.length + '/60</small></span><input id="cmpEdHeader" value="' + esc(t.header) + '" maxlength="60" oninput="PinCampaigns.edField(\'header\',this.value,1)"></label>')
        + '<label class="tsk-f"><span>Message <small>' + t.body.length + '/1024</small></span><textarea id="cmpBody" rows="7" oninput="PinCampaigns.edField(\'body\',this.value,1)">' + esc(t.body) + '</textarea></label>'
        + '<div class="cmp-insert"><span class="cmp-muted">Insert:</span>' + ['name', 'first_name', 'property', 'code', 'area', 'price', 'config', 'visit_date', 'visit_time', 'agent_name', 'agent_phone'].map(function (v) { return '<button type="button" class="cmp-chip sm" onclick="PinCampaigns.insertVar(' + js(v) + ')">{{' + v + '}}</button>'; }).join('') + '</div>'
        + '<label class="tsk-f"><span>Footer</span><input id="cmpEdFooter" value="' + esc(t.footer) + '" maxlength="60" oninput="PinCampaigns.edField(\'footer\',this.value,1)"></label>'
        + '<div class="tsk-f"><span>Quick reply buttons (up to 3)</span>' + [0, 1, 2].map(function (i) { return '<input class="cmp-btnin" id="cmpEdBtn' + i + '" aria-label="Button ' + (i + 1) + '" value="' + esc(t.buttons[i] || '') + '" maxlength="25" placeholder="Button ' + (i + 1) + '" oninput="PinCampaigns.edButton(' + i + ',this.value)">'; }).join('') + '</div>'
        + (vars.length && !describing ? '<div class="tsk-f"><span>Sample for each variable (Meta asks for one)</span>' + vars.map(function (v) { return '<label class="cmp-sample"><code>{{' + esc(v) + '}}</code><input value="' + esc(samples[v]) + '" oninput="PinCampaigns.edExample(' + js(v) + ',this.value)"></label>'; }).join('') + '</div>' : '')
      + '</div>'
      + '<div class="cmp-edprev"><div class="cmp-prevlabel">Preview with samples</div>' + bubble(Object.assign({}, t, { buttons: t.buttons.filter(Boolean) }), samples, { empty: 'Your message appears here as you write it.' })
      + '<div class="cmp-lintbox">' + (!t.body.trim() && !t.name ? '<div class="cmp-muted">Write it with AI, or type it — WhatsApp’s rules are checked as you go.</div>' : lint.errors.length ? lint.errors.map(function (e) { return '<div class="cmp-lint bad"><i class="fa-solid fa-xmark" aria-hidden="true"></i> ' + esc(e) + '</div>'; }).join('') : '<div class="cmp-lint ok"><i class="fa-solid fa-check" aria-hidden="true"></i> Meets WhatsApp’s template rules</div>')
      + lint.warnings.map(function (w) { return '<div class="cmp-lint"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ' + esc(w) + '</div>'; }).join('') + '</div></div>'
      + '</div>'
      + '<div class="cmp-mfoot"><button type="button" class="tsk-btn" onclick="PinCampaigns.closeEditor()">Cancel</button>'
      + '<button type="button" class="tsk-btn primary" ' + (E.saving || (!describing && !lint.ok) ? 'disabled' : '') + ' onclick="PinCampaigns.saveTemplate()">' + (E.saving ? 'Saving…' : describing ? 'Save text' : 'Save draft') + '</button></div>'
      + '</div></div>';
  }
  // Typing in the editor re-renders only the preview, so the caret stays where it is.
  function refreshEditorPreview() {
    var box = document.querySelector('.cmp-edprev');
    if (!box || !S.editor) return render();
    var tmp = document.createElement('div');
    tmp.innerHTML = editorHtml();
    var fresh = tmp.querySelector('.cmp-edprev');
    box.innerHTML = fresh.innerHTML;
    var save = document.querySelector('.cmp-mfoot .tsk-btn.primary'), fs = tmp.querySelector('.cmp-mfoot .tsk-btn.primary');
    if (save && fs) save.disabled = fs.disabled;
    document.querySelectorAll('.cmp-edform .tsk-f > span small').forEach(function (el, i) { var f = tmp.querySelectorAll('.cmp-edform .tsk-f > span small')[i]; if (f) el.textContent = f.textContent; });
  }

  // ─── the campaign wizard ──────────────────────────────────────────────
  function newWizard() {
    return { step: 1, name: '', template: '', mapping: {}, propertyMode: 'own', propertyId: '', headerMediaUrl: '', lockLead: false, purpose: '',
      quick: '', f: blankFilters(), journey: null, handLeads: {},
      ai: null, aiBusy: false, aiQ: '', unchecked: {}, edits: {}, manual: [], manualText: '', addNote: '', limit: 150, previewAt: 0, filtersOpen: false, req: null };
  }
  function blankFilters() { return { stages: [], tt: '', type: '', area: '', budget: '', visit: '', active: '', source: '', q: '', agent: '', lost: '', hold: '', ad: '' }; }
  // How many filters are narrowing the list (the quick list and the search are counted apart).
  function filtersOn(f) { return Object.keys(f).filter(function (k) { return k !== 'q' && (Array.isArray(f[k]) ? f[k].length : f[k]); }).length; }
  function wizTemplate() { return S.wiz && S.wiz.template ? tplByName(S.wiz.template) : null; }
  function wizVars() { var t = wizTemplate(); return (t && t.vars) || []; }
  var QUICK = [
    ['', 'Everyone'], ['visit_week', 'Visited in the last 7 days'], ['visited', 'Visited a property'], ['planned', 'Visit planned'], ['tomorrow', 'Visit tomorrow'],
    ['interested', 'Interested in the property'], ['soldout', 'Interested in a sold-out property'], ['quiet', 'Hot / Warm, quiet 14 days'], ['holddue', 'On hold, revisit due']
  ];
  // The chip for a suggested message (or a retry): its leads, exactly as they were found.
  function journeyLabel(j) { return j.type === 'retry' ? j.label : 'Suggested: ' + j.label; }
  function quickMatch(l, q, w) {
    var v = visitOfLead(l), now = Date.now();
    if (q === 'visit_week') return v.status === 'done' && v.at && v.at >= now - 7 * DAY && v.at <= now + DAY;
    if (q === 'visited') return v.status === 'done';
    if (q === 'planned') return !!(v.at && v.status !== 'done' && v.status !== 'cancelled' && v.at >= startOfDay(now));
    if (q === 'tomorrow') { var t0 = startOfDay(now) + DAY; return !!(v.at && v.at >= t0 && v.at < t0 + DAY && v.status !== 'cancelled'); }
    if (q === 'interested') return w.propertyId ? hasProp(l, w.propertyId) : linkedProps(l).length > 0;
    if (q === 'soldout') return w.propertyId ? hasProp(l, w.propertyId) : linkedProps(l).some(function (p) { return p.soldOut; });
    if (q === 'quiet') return l.tt && (l.tt.status === 'hot' || l.tt.status === 'warm') && now - lastActive(l) > 14 * DAY;
    if (q === 'holddue') return holdDue(l);
    // A suggested message: exactly the leads the journey found when it was opened.
    if (q === 'journey') return !!(w.journey && w.journey.leadIds.indexOf(l.id) >= 0);
    return true;
  }
  function holdDue(l) { return stageKind(l) === 'hold' && !!l.holdUntil && l.holdUntil <= Date.now(); }
  var BUDGETS = [['', 'Any budget'], ['0-5000000', 'Under ₹50 L'], ['5000000-10000000', '₹50 L – 1 Cr'], ['10000000-20000000', '₹1 – 2 Cr'], ['20000000-40000000', '₹2 – 4 Cr'], ['40000000-', '₹4 Cr +']];
  function filterMatch(l, w) {
    var f = w.f;
    if (!quickMatch(l, w.quick, w)) return false;
    // "Each lead's own property" with a property picked means the leads linked to that property.
    if (w.propertyMode === 'own' && w.propertyId && !hasProp(l, w.propertyId)) return false;
    if (f.stage && l.stageId !== f.stage) return false;
    if (f.stages && f.stages.length && f.stages.indexOf(l.stageId) < 0) return false;
    if (f.agent && (f.agent === 'none' ? !!l.assignedAgent : String(l.assignedAgent || '').toLowerCase() !== f.agent.toLowerCase())) return false;
    if (f.lost && !(stageKind(l) === 'lost' && (f.lost === 'any' || l.lostReason === f.lost))) return false;
    if (f.hold && !(f.hold === 'due' ? holdDue(l) : stageKind(l) === 'hold')) return false;
    if (f.ad && String((l.tt && l.tt.adTitle) || '') !== f.ad) return false;
    if (f.tt && !(l.tt && l.tt.status === f.tt)) return false;
    if (f.type && intentOf(l) !== f.type) return false;
    if (f.source && (f.source === 'tt' ? !(l.tt && l.tt.id) : l.channel !== f.source)) return false;
    if (f.area && areaText(l).indexOf(f.area.toLowerCase()) < 0) return false;
    if (f.budget) {
      var b = budgetOf(l), r = f.budget.split('-'), lo = Number(r[0]) || 0, hi = r[1] ? Number(r[1]) : Infinity;
      if (!b || b < lo || b >= hi) return false;
    }
    if (f.visit) { var v = visitOfLead(l); if (f.visit === 'done' ? v.status !== 'done' : f.visit === 'open' ? !(v.at && v.status !== 'done' && v.status !== 'cancelled') : !!v.at) return false; }
    if (f.active) { var d = Number(f.active); if (d > 0 ? Date.now() - lastActive(l) > d * DAY : Date.now() - lastActive(l) <= -d * DAY) return false; }
    if (f.q) {
      var s = (l.name + ' ' + (l.phone || '') + ' ' + ((l.tt && l.tt.contact) || '') + ' ' + (l.propertyCodes || []).join(' ') + ' ' + areaText(l)).toLowerCase();
      if (f.q.toLowerCase().split(/\s+/).some(function (word) { return word && s.indexOf(word) < 0; })) return false;
    }
    return true;
  }
  // Why a CRM lead (or a number) is not sent, the way the server will decide it at send time —
  // shown here first, so the count on the button is the count that goes. `ctx` adds marketing,
  // the Marketing list and the journey (a referral may reach a Won lead).
  // The page's own reading of a lead's opt-outs ({ all, marketing }) — includes a switch flipped on
  // the lead page a moment ago, before the leads snapshot says so (app.js, window.crmLeadOptOut).
  function optOutOf(lead) {
    if (!lead) return {};
    if (typeof window.crmLeadOptOut === 'function') { try { return window.crmLeadOptOut(lead.id) || {}; } catch (e) { /* the lead's own fields below */ } }
    return { all: lead.waOptOut === true, marketing: lead.waMarketingOptOut === true };
  }
  function holdFor(lead, contact, ctx) {
    var C = CM();
    var o = optOutOf(lead);
    // Asked not to be messaged (a STOP reply, or set on the lead) is the first reason, whatever else.
    if (lead && (lead.waOptOut === true || o.all === true)) return 'Asked not to be messaged';
    if (lead && ctx.marketing && o.marketing === true) return 'Asked to stop offers';
    // The rules module's reasons, in the server's order, when it has them.
    if (typeof C.holdWhy === 'function') {
      var w = C.holdWhy(lead, contact, Object.assign({}, ctx, { marketingOptOut: ctx.mktOut, stageKey: function (l) { return l ? stageKeyOfLead(l) : null; } }));
      return w ? (w.code === 'no offers' ? 'Asked to stop offers' : w.text) : '';
    }
    var hold = C.holdReason(lead, contact, ctx);
    if (hold || !ctx.marketing) return hold;
    if ((lead && lead.waMarketingOptOut === true) || (contact && ctx.mktOut.has(contact))) return 'Asked to stop offers';
    if (!lead) return '';
    // A Marketing message never goes to a lead whose deal a person is closing.
    var sk = stageKeyOfLead(lead);
    if ((sk === 'negotiation' || sk === 'won') && ctx.purpose !== 'referral') return (sk === 'won' ? 'Won' : 'Negotiating') + ' — no Marketing messages';
    var lastM = lead.lastMarketingAt || 0;
    if (ctx.gapDays > 0 && lastM && ctx.now - lastM < ctx.gapDays * DAY) return 'Sent an offer in the last ' + ctx.gapDays + ' days';
    if ((lead.marketingUnanswered || 0) >= 2 && lastM && ctx.now - lastM < 60 * DAY) return 'Two offers unanswered — give them a rest';
    var lastIn = lead.tt && lead.tt.lastMessageAt;
    if (lastIn && ctx.now - lastIn < DAY && ctx.now - lastIn >= 0) return 'Wrote in the last 24 h — reply in the chat, free';
    return '';
  }
  // Every row the campaign could hold: the matching leads (or the AI's picks among them), the
  // leads and contacts added by hand, each with its values, its brochure and whether — and why
  // not — it will be sent.
  function wizRows() {
    var w = S.wiz, C = CM(), t = wizTemplate();
    var vars = wizVars();
    var st = settings();
    var marketing = !!(t && t.category === 'MARKETING');
    var ctx = { optOut: new Set(st.optOut), mktOut: new Set(st.marketingOptOut), marketing: marketing, gapDays: st.marketingGapDays, now: Date.now(), sentNumbers: new Set(),
      purpose: w.purpose || (w.journey && w.journey.type) || purposeOf(t) };
    var one = w.propertyMode === 'one' ? propById(w.propertyId) : null;
    var media = !!(t && t.mediaHeader);
    var oneMedia = media && one ? C.mediaUrl(w.headerMediaUrl) : '';
    var hand = w.handLeads || {};
    var handPool = Object.keys(hand).map(leadById).filter(Boolean);
    var pool = w.onlyManual ? [] : allLeads().filter(function (l) { return !hand[l.id] && filterMatch(l, w); });
    if (w.ai) pool = pool.filter(function (l) { return w.ai.picks[l.id]; });
    pool.sort(function (a, b) { return lastActive(b) - lastActive(a); });
    var rows = [];
    var mapping = w.mapping || {};
    function add(key, lead, name, contact, prop, visit, byHand) {
      var values = C.valuesFor(vars, mapping, { lead: lead || { name: name }, prop: prop, visit: visit, agent: lead ? agentOf(lead) : agentOf(null), now: ctx.now });
      // {{first_name}} filled from "Lead's name" (a mapping saved before first names existed).
      vars.forEach(function (v) { var m = mapping[v]; if (/first/i.test(v) && m && m.source === 'lead_name' && values[v]) values[v] = String(values[v]).split(' ')[0]; });
      var ed = w.edits[key] || {};
      Object.keys(ed).forEach(function (v) { if (vars.indexOf(v) >= 0) values[v] = ed[v]; });
      var hold = holdFor(lead, contact, ctx);
      // The brochure: the campaign's one file, or each lead's own property's — a lead whose
      // property has none is held back rather than sent a blank header.
      var mUrl = '', mName = '';
      if (media) {
        if (one) { mUrl = oneMedia; mName = (C.propertyCode(one) || C.slugName(C.propertyLabel(one)) || 'Brochure') + '.pdf'; }
        else {
          mUrl = prop && prop.brochureLink ? C.mediaUrl(prop.brochureLink) : '';
          mName = prop ? (C.propertyCode(prop) || C.slugName(C.propertyLabel(prop)) || 'Brochure') + '.pdf' : '';
          if (!hold && !mUrl) hold = prop ? 'No brochure for this property' : 'No property linked — no brochure to send';
        }
      }
      var missing = C.missingVars(vars, values);
      var can = !hold && !missing.length;
      if (can) ctx.sentNumbers.add(contact);
      rows.push({ key: key, lead: lead, name: name, contact: contact, prop: prop, visit: visit, values: values, hold: hold, missing: missing, can: can, manual: !lead, hand: !!byHand,
        mediaUrl: mUrl, mediaName: mName, on: can && !w.unchecked[key],
        why: lead ? (w.ai ? w.ai.picks[lead.id] : (w.journey && w.journey.reasons && w.journey.reasons[lead.id]) || '') : '' });
    }
    // The CRM's leads claim their numbers first — they carry more (visit, property) than a number
    // typed in — and the ones added by hand are listed first, as the most recent thing done.
    var hint = w.quick === 'journey' && w.journey ? w.journey.type : w.quick;
    handPool.forEach(function (l) { var h = hand[l.id] || {}; add(l.id, l, l.name, contactOf(l), one || propById(h.code) || ownProp(l, hint), visitOfLead(l), true); });
    pool.forEach(function (l) { add(l.id, l, l.name, contactOf(l), one || ownProp(l, hint), visitOfLead(l), false); });
    w.manual.forEach(function (m) { add(m.key, null, m.name, m.contact, one || propById(m.code), null, true); });
    return rows.filter(function (r) { return r.hand; }).concat(rows.filter(function (r) { return !r.hand; }));
  }
  function stepAllowed(n, rows) {
    var w = S.wiz, t = wizTemplate(), C = CM();
    if (n === 1) return true;
    if (!(w.template && t && t.vars !== null)) return false;
    if (n < 4) return true;
    var on = (rows || wizRows()).filter(function (r) { return r.on; }).length;
    return on > 0 && on <= C.MAX_RECIPIENTS;
  }
  function stepper(rows) {
    var w = S.wiz;
    return '<ol class="cmp-stepper" id="cmpStepper" aria-label="Steps">' + STEPS.map(function (s, i) {
      var n = i + 1, can = stepAllowed(n, rows);
      return '<li class="' + (w.step === n ? 'on' : w.step > n ? 'done' : '') + '"><button type="button" ' + (can ? '' : 'disabled') + (w.step === n ? ' aria-current="step"' : '') + ' onclick="PinCampaigns.step(' + n + ')"><b>' + n + '</b><span>' + s + '</span></button></li>';
    }).join('') + '</ol>';
  }
  function wizardHtml() {
    if (!S.wiz) S.wiz = loadWiz() || newWizard();
    var w = S.wiz;
    // Back on a later step before the templates are in (a reload): wait for them; with them in and
    // the template gone, start again at step 1.
    if (w.step > 1 && !(wizTemplate() && wizTemplate().vars !== null)) {
      if (!S.templates) return head('New campaign', '', '') + '<p class="cmp-empty" role="status">' + (S.tplError ? esc(S.tplError) : 'Loading templates from TailorTalk…') + '</p>';
      w.step = 1;
    }
    var rows = w.step >= 2 ? wizRows() : null;
    var body = w.step === 1 ? wizStep1() : w.step === 2 ? wizStep2(rows) : w.step === 3 ? wizStep3(rows) : wizStep4(rows);
    return head('New campaign', 'Pick an approved template, the leads, and send it — or download the list for TailorTalk Broadcast.',
      '<button type="button" class="tsk-btn" onclick="PinCampaigns.resetWizard()">Start over</button>') + stepper(rows)
      + '<h2 class="cmp-steph" id="cmpStepH" tabindex="-1">Step ' + w.step + ' of 4 · ' + STEPS[w.step - 1] + '</h2>' + body;
  }
  function wizNav(back, nextLabel, nextOk, extra, cls) {
    return '<div class="cmp-wnav' + (cls ? ' ' + cls : '') + '" id="cmpWnav">' + (back ? '<button type="button" class="tsk-btn" onclick="PinCampaigns.step(' + (S.wiz.step - 1) + ')">← Back</button>' : '<span></span>')
      + (extra || '') + (nextLabel ? '<button type="button" class="tsk-btn primary" ' + (nextOk ? '' : 'disabled') + ' onclick="PinCampaigns.step(' + (S.wiz.step + 1) + ')">' + nextLabel + ' →</button>' : '') + '</div>';
  }
  function wizStep1() {
    var w = S.wiz;
    if (!S.templates) return '<p class="cmp-empty">' + (S.tplLoading ? 'Loading templates from TailorTalk…' : esc(S.tplError || 'Templates could not be loaded.')) + '</p>';
    var list = approved();
    var others = (S.templates || []).filter(function (t) { return t.status !== 'APPROVED'; });
    return '<section class="cmp-card"><label class="tsk-f"><span>Campaign name</span><input id="cmpName1" value="' + esc(w.name) + '" placeholder="e.g. Feedback — visits this week" oninput="PinCampaigns.setName(this.value)"></label></section>'
      + '<div class="cmp-tgrid">' + list.map(function (t) {
        return '<button type="button" class="cmp-tcard pick' + (w.template === t.name ? ' on' : '') + '" onclick="PinCampaigns.pickTemplate(' + js(t.name) + ')" aria-pressed="' + (w.template === t.name) + '">'
          + '<div class="cmp-tchead"><span class="cmp-tn">' + esc(t.name) + '</span><span class="cmp-tpills">' + catPill(t.category) + '</span></div>' + bubble(t, null, { small: true })
          + (t.vars === null ? '<div class="cmp-lint">Its text is not known here — add it on the Templates screen to fill its variables</div>' : '') + '</button>';
      }).join('') + '</div>'
      + (list.length ? '' : '<p class="cmp-empty">No approved template yet. Create one on the Templates screen and get it approved first.</p>')
      + (others.length ? '<p class="cmp-note">Not shown because they are not approved yet: ' + others.map(function (t) { return esc(t.name) + ' (' + esc(((STATUS_META[t.status] || [t.status])[0]).toLowerCase()) + ')'; }).join(', ') + '.</p>' : '')
      + wizNav(false, 'Property & values', !!(w.template && wizTemplate() && wizTemplate().vars !== null));
  }
  var PROP_SOURCES = /^(property|code|area|price|config)$/;
  // Whether the message is about a property at all: a variable filled from one, a brochure, or
  // words in its text that name one.
  function talksAboutProperty(t, mapping) {
    if (!t) return false;
    if (t.mediaHeader) return true;
    if ((t.vars || []).some(function (v) { return PROP_SOURCES.test((mapping[v] || {}).source || ''); })) return true;
    return /propert|flat|apartment|villa|home|house|project|listing|site visit|visit to|brochure/i.test((t.header || '') + ' ' + (t.body || ''));
  }
  function wizStep2(rows) {
    var w = S.wiz, t = wizTemplate(), C = CM(), vars = wizVars();
    var opts = '<option value="">— pick a property —</option>' + inv().map(function (p) { return '<option value="' + esc(p.id) + '"' + (w.propertyId === p.id ? ' selected' : '') + '>' + esc((C.propertyCode(p) ? C.propertyCode(p) + ' · ' : '') + C.propertyLabel(p) + (p.soldOut ? ' (sold)' : '')) + '</option>'; }).join('');
    var one = propById(w.propertyId);
    var help = rule('SOURCE_HELP') || {};
    var srcOpts = function (v) {
      var m = w.mapping[v] || {};
      return C.SOURCES.map(function (s) { return '<option value="' + esc(s[0]) + '"' + (m.source === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('');
    };
    var media = !!(t && t.mediaHeader);
    var sample = (rows || []).find(function (r) { return r.can; }) || (rows || [])[0] || null;
    var noBrochure = media && w.propertyMode === 'own' ? (rows || []).filter(function (r) { return /brochure/i.test(r.hold || ''); }).length : 0;
    return '<section class="cmp-card"><h2 class="cmp-h2">Which property does the message talk about?</h2>'
      + '<div class="cmp-radios"><label class="cmp-radio' + (w.propertyMode === 'own' ? ' on' : '') + '"><input type="radio" name="pm" ' + (w.propertyMode === 'own' ? 'checked' : '') + ' onchange="PinCampaigns.wiz(\'propertyMode\',\'own\')"><b>Each lead’s own property</b><span>The one they visited, or the one they enquired about</span></label>'
      + '<label class="cmp-radio' + (w.propertyMode === 'one' ? ' on' : '') + '"><input type="radio" name="pm" ' + (w.propertyMode === 'one' ? 'checked' : '') + ' onchange="PinCampaigns.wiz(\'propertyMode\',\'one\')"><b>One property for everyone</b><span>A new listing, a sold-out notice, a price change</span></label></div>'
      + '<label class="tsk-f"><span>' + (w.propertyMode === 'one' ? 'The property' : 'Property (optional — narrows the lead list to those linked to it)') + '</span><select id="cmpPropSel" onchange="PinCampaigns.wiz(\'propertyId\',this.value)">' + opts + '</select></label>'
      + (one ? '<p class="cmp-note">' + esc([C.propertyCode(one), C.propertyLabel(one), one.location, one.startingPrice, one.soldOut ? 'sold out' : ''].filter(Boolean).join(' · ')) + '</p>' : '')
      + (!talksAboutProperty(t, w.mapping) ? '<p class="cmp-note">This template does not mention a property, so this only narrows who gets it.</p>' : '') + '</section>'
      + '<section class="cmp-card"><h2 class="cmp-h2">Fill each variable from</h2>'
      + (vars.length ? '<div class="cmp-maps">' + vars.map(function (v) {
        // The words around a variable only where its name says nothing: {{2}}, or one with no source.
        var m = w.mapping[v] || {}, cx = /^\d+$/.test(v) || C.autoSource(v) === 'fixed' ? varContext(t, v) : null;
        // A numbered variable is named by the words around it: “visit to {{2}} on”.
        var label = '<span class="cmp-mapv"><code>{{' + esc(v) + '}}</code>' + (cx ? '<small class="cmp-varctx">' + esc((cx.before ? '…' + cx.before + ' ' : '') + '{{' + v + '}}' + (cx.after ? ' ' + cx.after + '…' : '')) + '</small>' : '') + '</span>';
        return '<div class="cmp-map">' + label + '<select id="cmpMap_' + esc(v) + '" onchange="PinCampaigns.mapVar(' + js(v) + ',\'source\',this.value)" aria-label="Value for {{' + esc(v) + '}}' + (cx ? ', ' + esc(cx.before + ' … ' + cx.after) : '') + '">' + srcOpts(v) + '</select>'
          + (m.source === 'fixed' ? '<input id="cmpMapT_' + esc(v) + '" value="' + esc(m.text || '') + '" placeholder="Text for everyone" aria-label="Text for {{' + esc(v) + '}}" oninput="PinCampaigns.mapVar(' + js(v) + ',\'text\',this.value,1)">' : (help[m.source] ? '<small class="cmp-muted cmp-srchelp">' + esc(help[m.source]) + '</small>' : '')) + '</div>';
      }).join('') + '</div>' : '<p class="cmp-muted">This template has no variables.</p>')
      + '<p class="cmp-note">Anyone left with an empty variable is held back — WhatsApp refuses those messages. Each value can be changed per lead in the next step.</p>'
      + (t ? '<div class="cmp-livebox"><div class="cmp-prevlabel">' + (sample ? 'As ' + esc(C.greetingName(sample.name) || sample.name || 'the first person') + ' will read it' : 'With the values filled in') + '</div>' + bubble(t, sample ? sample.values : {}, { mediaName: sample ? sample.mediaName : '' }) + '</div>' : '')
      + '</section>'
      + (media ? '<section class="cmp-card"><h2 class="cmp-h2">Brochure or photo</h2>'
        + (w.propertyMode === 'one'
          ? '<label class="tsk-f"><span>Link to the file (Drive links work)</span><input id="cmpMedia" value="' + esc(w.headerMediaUrl) + '" placeholder="https://drive.google.com/file/d/…" oninput="PinCampaigns.wiz(\'headerMediaUrl\',this.value,1)"></label>'
            + (one && one.brochureLink ? '<button type="button" class="cmp-link" onclick="PinCampaigns.wiz(\'headerMediaUrl\',' + js(String(one.brochureLink)) + ')">Use ' + esc(C.propertyCode(one) || 'this property') + '’s brochure</button>' : '')
          : '<p class="cmp-note">Each person gets the brochure of their own property, from the inventory — named by its code, like <b>' + esc(sample && sample.mediaName ? sample.mediaName : 'MADA0001.pdf') + '</b>.'
            + (noBrochure ? ' <span class="cmp-warn">' + noBrochure + ' in the list ' + (noBrochure === 1 ? 'has' : 'have') + ' no brochure on file and will be held back — add one in the inventory, or pick one property for everyone.</span>' : '') + '</p>')
        + '</section>' : '')
      + '<section class="cmp-card"><label class="cmp-check"><input type="checkbox" ' + (w.lockLead ? 'checked' : '') + ' onchange="PinCampaigns.wiz(\'lockLead\',this.checked)"> When they reply, pause the AI so the team answers (TailorTalk lock)</label></section>'
      + wizNav(true, 'Who gets it', !(w.propertyMode === 'one' && !w.propertyId) && !(media && w.propertyMode === 'one' && !w.headerMediaUrl));
  }
  function sel(name, value, opts, label) {
    return '<label class="tsk-f"><span>' + label + '</span><select id="cmpF_' + name + '" onchange="PinCampaigns.filter(' + js(name) + ',this.value)">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
  }
  // Values the leads actually have, most common first — for the agent and ad filters.
  function distinct(get, limit) {
    var n = {};
    allLeads().forEach(function (l) { var v = get(l); if (v) n[v] = (n[v] || 0) + 1; });
    return Object.keys(n).sort(function (a, b) { return n[b] - n[a] || a.localeCompare(b); }).slice(0, limit || 40);
  }
  function savedListsHtml() {
    var lists = settings().lists;
    return '<div class="cmp-saved"><span class="cmp-muted">Saved lists:</span>'
      + (lists.length ? lists.map(function (x) {
        return '<span class="cmp-schip"><button type="button" class="cmp-chip" onclick="PinCampaigns.loadList(' + js(x.id) + ')" title="Use this list">' + esc(x.name) + '</button>'
          + '<button type="button" class="cmp-x sm" aria-label="Delete the saved list ' + esc(x.name) + '" onclick="PinCampaigns.deleteList(' + js(x.id) + ')">×</button></span>';
      }).join('') : '<span class="cmp-muted">none yet</span>')
      + '<button type="button" class="cmp-link" onclick="PinCampaigns.saveListAsk()"><i class="fa-regular fa-bookmark" aria-hidden="true"></i> Save this list</button></div>';
  }
  function isPhone() { try { return window.matchMedia('(max-width: 620px)').matches; } catch (e) { return false; } }
  function countLine(rows) {
    var on = rows.filter(function (r) { return r.on; }).length, held = rows.filter(function (r) { return !r.can; }).length;
    return rows.length + ' in the list' + (held ? ' · ' + held + ' held back' : '');
  }
  function step3Nav(rows) {
    var C = CM(), on = rows.filter(function (r) { return r.on; }).length, over = on > C.MAX_RECIPIENTS;
    return wizNav(true, 'Review & send', on > 0 && !over,
      '<span class="cmp-wcount" aria-hidden="true"><b>' + on + '</b> will get it</span>'
      + (over ? '<span class="cmp-warn">At most ' + C.MAX_RECIPIENTS.toLocaleString('en-IN') + ' in one campaign <button type="button" class="cmp-link sm" onclick="PinCampaigns.firstN()">Send to the first ' + C.MAX_RECIPIENTS.toLocaleString('en-IN') + '</button></span>' : ''), 'sticky');
  }
  function wizStep3(rows) {
    var w = S.wiz, C = CM(), vars = wizVars(), P = window.crmPipeline;
    var on = rows.filter(function (r) { return r.on; }).length;
    var shown = rows.slice(0, w.limit);
    var quick = (w.journey ? [['journey', journeyLabel(w.journey)]] : []).concat(QUICK);
    var agents = distinct(function (l) { return l.assignedAgent; });
    var ads = distinct(function (l) { return l.tt && l.tt.adTitle; });
    var lostOpts = [['', 'Any'], ['any', 'Any lost lead']].concat(Object.keys((P && P.LOST_REASONS) || {}).map(function (k) { return [k, P.LOST_REASONS[k]]; }));
    var nf = filtersOn(w.f);
    var stageChips = crmStages().map(function (st) {
      var onS = (w.f.stages || []).indexOf(st.id) >= 0;
      return '<button type="button" class="cmp-chip' + (onS ? ' on' : '') + '" aria-pressed="' + onS + '" onclick="PinCampaigns.toggleStage(' + js(st.id) + ')">' + esc(st.name) + '</button>';
    }).join('');
    // On a phone the filters fold away behind one line, so the list is in reach.
    var filtersOpen = !isPhone() || w.filtersOpen || false;
    return '<section class="cmp-card"><div class="cmp-h2row"><h2 class="cmp-h2">Quick lists</h2>' + (nf ? '<button type="button" class="cmp-link" onclick="PinCampaigns.clearFilters()">Clear ' + nf + ' filter' + (nf === 1 ? '' : 's') + '</button>' : '') + '</div>'
      + '<div class="cmp-chips wrap" role="group" aria-label="Quick lists">' + quick.map(function (q) {
        return '<button type="button" class="cmp-chip' + (w.quick === q[0] ? ' on' : '') + (q[0] === 'journey' ? ' j' : '') + '" aria-pressed="' + (w.quick === q[0]) + '" onclick="PinCampaigns.quick(' + js(q[0]) + ')">' + esc(q[1]) + '</button>';
      }).join('') + '</div>'
      + ((w.quick === 'interested' || w.quick === 'soldout') && !w.propertyId ? '<p class="cmp-note">Pick the property in step 2 to narrow this to one property.</p>' : '')
      + savedListsHtml()
      + '<label class="tsk-f grow cmp-qsearch"><span>Search</span><input type="search" id="cmpF_q" value="' + esc(w.f.q) + '" placeholder="Name, number or property code" oninput="PinCampaigns.filter(\'q\',this.value,1)"></label>'
      + '<details class="cmp-fdet"' + (filtersOpen ? ' open' : '') + ' ontoggle="PinCampaigns.setFlag(\'filtersOpen\',this.open)"><summary>Filters' + (nf ? ' <b>(' + nf + ')</b>' : '') + '</summary>'
      + '<div class="tsk-f cmp-stagef"><span id="cmpStagesL">Stage — tick several</span><div class="cmp-chips wrap" role="group" aria-labelledby="cmpStagesL">' + stageChips + '</div></div>'
      + '<div class="cmp-filters">'
      + sel('agent', w.f.agent, [['', 'Anyone']].concat(agents.map(function (a) { return [a, agentLabel(a)]; })).concat([['none', 'No agent yet']]), 'Lead agent')
      + sel('tt', w.f.tt, [['', 'Any'], ['hot', 'Hot'], ['warm', 'Warm'], ['cold', 'Cold'], ['converted', 'Converted']], 'TailorTalk')
      + sel('type', w.f.type, [['', 'Anyone'], ['buyer', 'Buyers'], ['tenant', 'Tenants'], ['owner', 'Owners / sellers']], 'Looking to')
      + sel('budget', w.f.budget, BUDGETS, 'Budget')
      + sel('visit', w.f.visit, [['', 'Any'], ['done', 'Visited'], ['open', 'Visit planned'], ['none', 'No visit yet']], 'Site visit')
      + sel('active', w.f.active, [['', 'Any time'], ['7', 'Active in 7 days'], ['30', 'Active in 30 days'], ['-30', 'Quiet 30+ days'], ['-90', 'Quiet 90+ days']], 'Last active')
      + sel('hold', w.f.hold, [['', 'Any'], ['due', 'On hold — revisit due'], ['on', 'On hold']], 'On hold')
      + sel('lost', w.f.lost, lostOpts, 'Lost reason')
      + sel('source', w.f.source, [['', 'Any'], ['tt', 'TailorTalk'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['website', 'Website']], 'Came from')
      + (ads.length ? sel('ad', w.f.ad, [['', 'Any ad or post']].concat(ads.map(function (a) { return [a, a.length > 48 ? a.slice(0, 46) + '…' : a]; })), 'Ad or post') : '')
      + '<label class="tsk-f"><span>Area</span><input id="cmpF_area" value="' + esc(w.f.area) + '" placeholder="e.g. Anna Nagar" oninput="PinCampaigns.filter(\'area\',this.value,1)"></label>'
      + '</div></details></section>'
      + '<section class="cmp-card"><h2 class="cmp-h2"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Ask AI who should get it</h2>'
      + '<div class="cmp-aiq"><input id="cmpAiQ" value="' + esc(w.aiQ) + '" aria-label="Who should get it, in your words" placeholder="e.g. buyers who visited Anna Nagar 3 BHKs and found the price too high" oninput="PinCampaigns.setWiz(\'aiQ\',this.value)" onkeydown="if(event.key===\'Enter\')PinCampaigns.askAi()">'
      + '<button type="button" class="tsk-btn primary" ' + (w.aiBusy ? 'disabled' : '') + ' onclick="PinCampaigns.askAi()">' + (w.aiBusy ? 'Choosing…' : 'Choose') + '</button>'
      + (w.ai ? '<button type="button" class="tsk-btn" onclick="PinCampaigns.clearAi()">Clear AI picks</button>' : '') + '</div>'
      + (w.ai ? '<p class="cmp-note">AI picked ' + Object.keys(w.ai.picks).length + ' of ' + w.ai.considered + ' leads for “' + esc(w.ai.q) + '”. Each reason is shown on the row.</p>' : '<p class="cmp-note">AI reads the leads the filters above leave (up to 400) and picks the ones that fit, with a reason for each.</p>')
      + '</section>'
      + '<section class="cmp-card"><h2 class="cmp-h2">Add contacts by hand</h2>'
      + '<p class="cmp-note">One per line: number, name, property code (optional) — e.g. <code>98765 43210, Ravi, ANR003</code>. Or upload a CSV: a phone / mobile / contact column, and name and code if you have them. A number that is already a lead in the CRM is added as that lead.</p>'
      + '<textarea class="cmp-manual" id="cmpManual" rows="3" aria-label="Contacts to add, one per line" placeholder="98765 43210, Ravi, ANR003" oninput="PinCampaigns.setWiz(\'manualText\',this.value)">' + esc(w.manualText) + '</textarea>'
      + '<div class="cmp-row2 tight"><button type="button" class="tsk-btn" onclick="PinCampaigns.addManual()">Add to the list</button>'
      + '<label class="tsk-btn" role="button" tabindex="0" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.querySelector(\'input\').click()}"><i class="fa-solid fa-upload" aria-hidden="true"></i> Upload CSV<input type="file" accept=".csv,text/csv,.txt" hidden onchange="PinCampaigns.uploadCsv(this)"></label>'
      + (w.manual.length || Object.keys(w.handLeads || {}).length ? '<span class="cmp-muted">' + (w.manual.length + Object.keys(w.handLeads || {}).length) + ' added by hand · <button type="button" class="cmp-link" onclick="PinCampaigns.clearManual()">remove all</button></span>' : '') + '</div>'
      + '<p class="cmp-note cmp-addnote" role="status">' + esc(w.addNote || '') + '</p></section>'
      + (w.onlyManual ? '<div class="cmp-alert soft">Only the contacts below are in this campaign. <button type="button" class="cmp-link" onclick="PinCampaigns.wiz(\'onlyManual\',false)">Add CRM leads too</button></div>' : '')
      + '<section class="cmp-card"><div class="cmp-h2row"><h2 class="cmp-h2" id="cmpWillGet" aria-live="polite">' + on + ' will get it</h2><span class="cmp-muted" id="cmpListN">' + countLine(rows) + '</span></div>'
      + '<div class="cmp-bulk"><button type="button" class="cmp-link" onclick="PinCampaigns.checkAll(true)">Tick all</button><button type="button" class="cmp-link" onclick="PinCampaigns.checkAll(false)">Untick all</button></div>'
      + '<div class="cmp-rows" role="list" aria-labelledby="cmpWillGet">' + shown.map(function (r) { return rowHtml(r, vars); }).join('') + '</div>'
      + (rows.length > w.limit ? '<button type="button" class="tsk-btn" onclick="PinCampaigns.more()">Show ' + Math.min(150, rows.length - w.limit) + ' more <span class="cmp-muted">(' + w.limit + ' of ' + rows.length + ' shown)</span></button>' : '')
      + (!rows.length ? '<p class="cmp-empty">No one matches. ' + (nf || w.quick ? '<button type="button" class="cmp-link" onclick="PinCampaigns.clearFilters(1)">Clear the filters</button>, or add contacts by hand.' : 'Add contacts by hand above.') + '</p>' : '')
      + '</section>'
      + step3Nav(rows);
  }
  // Ids for one row's controls — found again after a redraw, so the caret and Tab stay put.
  function rowId(kind, key, v) { return 'cmp' + kind + '_' + String(key).replace(/[^A-Za-z0-9_-]/g, '_') + (v ? '__' + v : ''); }
  function rowHtml(r, vars) {
    var C = CM();
    var v = r.visit && r.visit.at ? (r.visit.status === 'done' ? 'visited ' : 'visit ') + C.visitDate(r.visit.at) : '';
    var meta = [r.contact ? C.prettyNumber(r.contact) : '', r.lead && r.lead.tt && r.lead.tt.status ? r.lead.tt.status : '', r.prop ? (C.propertyCode(r.prop) || C.propertyLabel(r.prop)) : '', v, r.hand ? 'added by hand' : '', r.lead && r.lead.lastCampaignAt ? 'last messaged ' + ago(r.lead.lastCampaignAt) : ''].filter(Boolean);
    return '<div class="cmp-r' + (r.on ? ' on' : '') + (r.can ? '' : ' held') + '" role="listitem" data-key="' + esc(r.key) + '">'
      + '<input type="checkbox" id="' + esc(rowId('C', r.key)) + '" ' + (r.on ? 'checked' : '') + (r.can ? '' : ' disabled') + ' aria-label="Send to ' + esc(r.name || r.contact) + '" onchange="PinCampaigns.tick(' + js(r.key) + ',this.checked)">'
      + '<div class="cmp-rmain"><div class="cmp-rname">' + (r.lead ? '<button type="button" class="cmp-link" onclick="openDetail(' + js(r.lead.id) + ')">' + esc(r.name || '(no name)') + '</button>' : esc(r.name || '(no name)'))
      + (r.hand ? ' <button type="button" class="cmp-x sm" aria-label="Remove ' + esc(r.name || r.contact) + '" onclick="PinCampaigns.removeManual(' + js(r.key) + ')">×</button>' : '') + '</div>'
      + '<div class="cmp-muted">' + esc(meta.join(' · ')) + '</div>'
      + (r.why ? '<div class="cmp-why">' + (S.wiz && S.wiz.ai ? '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ' : '') + esc(r.why) + '</div>' : '')
      + (r.hold ? '<div class="cmp-hold">' + esc(r.hold) + '</div>' : r.missing.length ? '<div class="cmp-hold">Missing ' + r.missing.map(function (m) { return '{{' + esc(m) + '}}'; }).join(', ') + ' — fill it in</div>' : '')
      + '</div>'
      + (vars.length && r.contact && !r.hold ? '<div class="cmp-rvals">' + vars.map(function (vv) {
        // A numbered variable is named by what fills it: "2 · Property name".
        var src = /^\d+$/.test(vv) && S.wiz && S.wiz.mapping[vv] ? (C.SOURCES.find(function (x) { return x[0] === S.wiz.mapping[vv].source; }) || [])[1] : '';
        return '<label><code>' + esc(vv) + (src ? ' · ' + esc(src) : '') + '</code><input id="' + esc(rowId('V', r.key, vv)) + '" data-rk="' + esc(r.key) + '" data-rv="' + esc(vv) + '" value="' + esc(r.values[vv] || '') + '" onchange="PinCampaigns.edit(' + js(r.key) + ',' + js(vv) + ',this.value)"' + (r.missing.indexOf(vv) >= 0 ? ' class="miss" aria-invalid="true"' : '') + '></label>';
      }).join('') + '</div>' : '')
      + '</div>';
  }
  // One row changed (a tick, a value): that row and the counts are redrawn, nothing else — the
  // focus stays where Tab or the click put it.
  function refreshRows(keys) {
    var h = host();
    if (S.view !== 'cmp-new' || !S.wiz || S.wiz.step !== 3 || !h) return render();
    var rows = wizRows(), vars = wizVars();
    var a = document.activeElement, aid = a && a.id, selA = null, selB = null;
    try { selA = a.selectionStart; selB = a.selectionEnd; } catch (e) { /* not a text box */ }
    keys.forEach(function (k) {
      var r = rows.find(function (x) { return x.key === k; });
      var el = Array.prototype.find.call(h.querySelectorAll('.cmp-r[data-key]'), function (x) { return x.getAttribute('data-key') === k; });
      if (!r || !el) return;
      var tmp = document.createElement('div');
      tmp.innerHTML = rowHtml(r, vars);
      el.parentNode.replaceChild(tmp.firstChild, el);
    });
    var will = document.getElementById('cmpWillGet'), on = rows.filter(function (r) { return r.on; }).length;
    if (will) will.textContent = on + ' will get it';
    var ln = document.getElementById('cmpListN'); if (ln) ln.textContent = countLine(rows);
    var swap = function (id, html) { var el = document.getElementById(id); if (!el) return; var tmp = document.createElement('div'); tmp.innerHTML = html; el.parentNode.replaceChild(tmp.firstChild, el); };
    swap('cmpWnav', step3Nav(rows));
    swap('cmpStepper', stepper(rows));
    if (aid && (!document.activeElement || document.activeElement === document.body || document.activeElement.id !== aid)) {
      var b = document.getElementById(aid);
      if (b) { b.focus({ preventScroll: true }); try { if (selA != null) b.setSelectionRange(selA, selB); } catch (e) { /* not a text box */ } }
    }
    saveWiz();
  }
  function wizStep4(rows) {
    var w = S.wiz, t = wizTemplate(), C = CM(), vars = wizVars();
    rows = rows.filter(function (r) { return r.on; });
    var i = Math.min(w.previewAt, Math.max(0, rows.length - 1));
    var r = rows[i];
    var media = !!t.mediaHeader, one = w.propertyMode === 'one' ? propById(w.propertyId) : null;
    var testTo = C.prettyNumber(settings().testNumber);
    var est = C.estimateCost(rows.length, t.category, settings());
    var cost = t.category === 'MARKETING' ? 'Marketing — WhatsApp charges more per message, and these can be blocked or reported, which lowers your number’s quality rating. Offers go out only 10 AM – 8 PM.' : 'Utility — the lower WhatsApp rate. Meta can re-label it Marketing if the words read as promotion.';
    var quiet = quietNow();
    // A template that says "today" / "thank you for visiting today" read on another day is wrong.
    var notToday = t.saySameDay ? rows.filter(function (x) { return !(x.visit && x.visit.at && startOfDay(x.visit.at) === startOfDay(Date.now())); }).length : 0;
    var who = r ? (C.greetingName(r.name) || r.name || C.prettyNumber(r.contact)) : 'they';
    var files = media && !one ? rows.reduce(function (n, x) { n[x.mediaName] = 1; return n; }, {}) : {};
    var busyT = !!S.busy.test, busyC = !!S.busy.csv;
    return (est.warn ? '<div class="cmp-alert warn" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> This is a big send: <b>' + rows.length + ' people</b>, about <b>' + esc(C.rupees(est.total)) + '</b>. Worth a test and a second look at the list first.</div>' : '')
      + (notToday ? '<div class="cmp-alert warn" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> “' + esc(t.name) + '” is written to be sent on the day of the visit — ' + notToday + ' of ' + rows.length + ' did not visit today, and would read “today” wrongly. Send them a template without “today”.</div>' : '')
      + (quiet ? '<div class="cmp-alert soft" role="status"><i class="fa-regular fa-moon" aria-hidden="true"></i> It is quiet hours in India (' + esc(quietSpan()) + ') — messages now land at night. Sending will ask you first; the CSV is not affected.</div>' : '')
      + '<div class="cmp-grid2">'
      + '<section class="cmp-card"><h2 class="cmp-h2">Summary</h2><dl class="cmp-dl">'
      + '<dt><label for="cmpName4">Campaign</label></dt><dd><input id="cmpName4" class="cmp-name4" value="' + esc(w.name || t.name) + '" maxlength="100" oninput="PinCampaigns.setName(this.value)"></dd>'
      + '<dt>Template</dt><dd>' + esc(t.name) + ' ' + catPill(t.category) + '</dd>'
      + '<dt>Recipients</dt><dd><b>' + rows.length + '</b>' + (rows.filter(function (x) { return x.hand; }).length ? ' (' + rows.filter(function (x) { return x.hand; }).length + ' added by hand)' : '') + '</dd>'
      + '<dt>Property</dt><dd>' + esc(one ? C.propertyLabel(one) + ' ' + C.propertyCode(one) : 'Each lead’s own') + '</dd>'
      + (media ? '<dt>Attachment</dt><dd' + (one ? ' class="cmp-ell"' : '') + '>' + (one ? esc(C.mediaUrl(w.headerMediaUrl)) : 'Each person’s own property brochure — ' + Object.keys(files).length + ' file' + (Object.keys(files).length === 1 ? '' : 's') + ' (' + esc(Object.keys(files).slice(0, 4).join(', ')) + (Object.keys(files).length > 4 ? ', …' : '') + ')') + '</dd>' : '')
      + '<dt>On reply</dt><dd>' + (w.lockLead ? 'AI pauses, the team answers' : 'AIRA answers as usual') + '</dd>'
      + '<dt>Estimated cost</dt><dd><b class="cmp-cost">≈ ' + esc(C.rupees(est.total)) + '</b> <span class="cmp-muted">approximate — ' + rows.length + ' × ' + esc(C.rupees(est.rate)) + ' ' + (est.marketing ? 'Marketing' : 'Utility') + ' rate (change it in Settings)</span></dd>'
      + '<dt>Category</dt><dd>' + esc(cost) + '</dd></dl></section>'
      + '<section class="cmp-card"><div class="cmp-h2row"><h2 class="cmp-h2" id="cmpPrevH">What ' + esc(who) + ' will get</h2>'
      + (rows.length > 1 ? '<span class="cmp-pager"><button type="button" class="cmp-x" aria-label="Previous person" onclick="PinCampaigns.preview(-1)">‹</button>' + (i + 1) + ' / ' + rows.length + '<button type="button" class="cmp-x" aria-label="Next person" onclick="PinCampaigns.preview(1)">›</button></span>' : '') + '</div>'
      + (r ? bubble(t, r.values, { mediaName: r.mediaName }) : '') + '</section></div>'
      + '<section class="cmp-card cmp-sendbox"><h2 class="cmp-h2">Send it</h2>'
      + '<div class="cmp-sendopts">'
      + '<div class="cmp-sopt"><b>1. Test it first</b><span>Sends ' + esc(who) + '’s message — the one shown above — to ' + esc(testTo) + ' only.</span><button type="button" class="tsk-btn" ' + (busyT || !r ? 'disabled' : '') + ' onclick="PinCampaigns.testSend()"><i class="fa-regular fa-paper-plane" aria-hidden="true"></i> ' + (busyT ? 'Sending the test…' : 'Send a test to ' + esc(testTo)) + '</button></div>'
      + '<div class="cmp-sopt"><b>2. Or use TailorTalk Broadcast</b><span>Download the list as TailorTalk wants it (contact, ' + esc(vars.join(', ') || 'no variables') + '), then upload it under Campaign → Broadcast — that is also where to schedule it.' + (media && !one ? ' Broadcast sends one file to everyone — for each person’s own brochure, send from here.' : '') + '</span><div class="cmp-row2 tight"><button type="button" class="tsk-btn" ' + (busyC ? 'disabled' : '') + ' onclick="PinCampaigns.downloadCsv()"><i class="fa-solid fa-download" aria-hidden="true"></i> ' + (busyC ? 'Recording…' : 'Download CSV') + '</button><a class="tsk-btn" href="' + esc(C.TAILORTALK_URL) + '" target="_blank" rel="noopener">Open TailorTalk ↗</a></div></div>'
      + '<div class="cmp-sopt main"><b>3. Or send from here now</b><span>Goes out through TailorTalk a few a second; each person’s delivery, read and reply is tracked here and the message shows in their chat.</span><button type="button" class="tsk-btn primary" ' + (S.busy.send || !rows.length ? 'disabled' : '') + ' onclick="PinCampaigns.confirmSend()"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i> Send to ' + rows.length + ' ' + (rows.length === 1 ? 'person' : 'people') + '</button></div>'
      + '</div></section>'
      + wizNav(true, '', false);
  }

  // ─── sending ──────────────────────────────────────────────────────────
  function payload(mode) {
    var w = S.wiz, t = wizTemplate(), C = CM();
    var rows = wizRows().filter(function (r) { return r.on; });
    var one = w.propertyMode === 'one' ? propById(w.propertyId) : null;
    var media = !!t.mediaHeader;
    var j = w.journey && w.journey.type !== 'retry' ? w.journey : null;
    return {
      name: w.name || t.name, template: t.name, vars: t.vars || [], mode: mode, purpose: w.purpose || purposeOf(t),
      mapping: w.mapping, propertyMode: w.propertyMode, propertyId: w.propertyId || null,
      // One file for everyone, named by its property's code; or each person's own (below).
      headerMediaUrl: media && one ? (w.headerMediaUrl || null) : null,
      headerMediaName: media && one ? (C.propertyCode(one) || C.slugName(C.propertyLabel(one)) || 'Brochure') + '.pdf' : null,
      lockLead: !!w.lockLead, journey: j ? (j.journey || j.type) : null, journeyKey: j ? j.key : null,
      audience: [w.quick === 'journey' && w.journey ? journeyLabel(w.journey) : QUICK.filter(function (q) { return q[0] === w.quick; }).map(function (q) { return q[1]; })[0], w.ai ? 'AI: ' + w.ai.q : ''].filter(Boolean).join(' · '),
      recipients: rows.map(function (r) {
        var o = { leadId: r.lead ? r.lead.id : null, contact: r.contact, name: r.name || '', values: r.values };
        if (media && !one && r.mediaUrl) { o.mediaUrl = r.mediaUrl; o.headerMediaName = r.mediaName; }
        return o;
      })
    };
  }
  // The same campaign pressed again (a double click, a retry after a timeout) keeps its request
  // id; anything changed gets a new one.
  function requestIdFor(kind, p) {
    var w = S.wiz;
    var sig = fingerprint(JSON.stringify([kind, p.template, p.name, p.mapping, p.propertyMode, p.propertyId, p.headerMediaUrl, p.recipients]));
    w.req = w.req || {};
    if (!w.req[kind] || w.req[kind].sig !== sig) w.req[kind] = { sig: sig, id: newRequestId() };
    return w.req[kind].id;
  }
  function sendingHtml() {
    var s = S.sending, k = s.counts || {};
    var done = (k.sent || 0) + (k.failed || 0) + (k.cancelled || 0), total = k.total || s.total || 1;
    return '<div class="cmp-modal" role="dialog" aria-modal="true" aria-labelledby="cmpSendH"><div class="cmp-mbox">'
      + '<div class="cmp-mhead"><h2 id="cmpSendH">' + (s.done ? (s.stopped ? 'Stopped' : 'Sent') : s.stop ? 'Stopping…' : 'Sending…') + '</h2></div>'
      + '<div class="cmp-prog" role="progressbar" aria-label="Sent so far" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + done + '"><i style="width:' + Math.round(done / total * 100) + '%"></i></div>'
      + '<p class="cmp-note" role="status" aria-live="polite">' + (k.sent || 0) + ' sent · ' + (k.failed || 0) + ' failed' + (k.ready ? ' · ' + k.ready + ' to go' : '') + (k.cancelled ? ' · ' + k.cancelled + ' not sent' : '') + (k.sending ? ' · ' + k.sending + ' unknown' : '') + '</p>'
      + (s.stop && !s.done ? '<p class="cmp-note">Stopping after the current few… the ones already handed to WhatsApp go out.</p>' : '')
      + (s.skipped && s.skipped.length ? '<p class="cmp-note">Held back by the server: ' + esc(whySummary(s.skipped)) + '.</p>' : '')
      + (s.uncertain ? '<p class="cmp-warn">' + s.uncertain + ' — TailorTalk did not answer. Check them in the campaign before sending again; nothing is resent by itself.</p>' : '')
      + (s.note && !s.error ? '<p class="cmp-note">' + esc(s.note) + '</p>' : '')
      + (s.error ? '<div class="cmp-alert">' + esc(s.error) + '</div>' : '')
      + '<div class="cmp-mfoot">' + (s.done ? '<button type="button" class="tsk-btn primary" onclick="PinCampaigns.finishSending()">See the campaign</button>'
        : '<button type="button" class="tsk-btn" ' + (s.stop ? 'disabled' : '') + ' onclick="PinCampaigns.stopSending()">' + (s.stop ? 'Stopping…' : 'Stop') + '</button>') + '</div></div></div>';
  }
  // `allowQuiet`: the person was told it is quiet hours and chose to send anyway.
  async function runSend(id, total, allowQuiet, skipped) {
    S.sending = { id: id, total: total, counts: { total: total, ready: total }, done: false, skipped: skipped || [] };
    render();
    var guard = 0;
    try {
      while (guard++ < 400 && !S.sending.stop) {
        var r = await api('send', allowQuiet ? { id: id, allowQuietHours: true } : { id: id });
        if (!r || !r.counts) throw new Error('The server did not say what went — open the campaign to see');
        S.sending.counts = r.counts;
        // Held at send time (opted out since, a Marketing rule) — with the server's reason.
        var held = [].concat(Array.isArray(r.held) ? r.held : [], Array.isArray(r.skipped) ? r.skipped : []);
        if (held.length) S.sending.skipped = S.sending.skipped.concat(held);
        if (r.uncertain) S.sending.uncertain = (S.sending.uncertain || 0) + Number(r.uncertain);
        if (r.error) S.sending.note = r.error;
        render();
        if (!r.left) break;
      }
      if (S.sending.stop) { var c = await api('cancel', { id: id }); S.sending.counts = c.counts || S.sending.counts; S.sending.stopped = true; }
    } catch (e) {
      // Refused for the hour: ask (or, for an offer outside 10 AM – 8 PM, say when), with the real
      // count of what has gone and what is waiting.
      if (isQuietRefusal(e)) {
        var k = S.sending.counts || {};
        S.sending = null;
        openModal(quietModal('send', { id: id, total: total, sent: k.sent || 0, failed: k.failed || 0, waiting: k.ready != null ? k.ready : total, canOverride: !(e.data && e.data.canOverride === false), data: e.data || {} }, e.message));
        return;
      }
      var ts = e.data && e.data.templateStatus;
      S.sending.error = e.timeout ? 'The server took too long — open the campaign to see what went. Nothing is sent twice.'
        : ts ? 'The template is ' + (ts === 'MISSING' ? 'no longer in TailorTalk' : String(ts).toLowerCase().replace(/_/g, ' ') + ' now') + ', so the rest were not sent — what was sent stays sent.'
        : e.message + ' — what was sent stays sent; open the campaign to continue.';
    }
    S.sending.done = true;
    loadCampaigns();
    render();
  }

  // ─── campaigns screen ─────────────────────────────────────────────────
  function historyHtml() {
    if (S.detail || S.detailLoading || S.detailError) return detailHtml();
    var list = S.campaigns || [];
    return head('Campaigns', 'Every campaign sent from here or downloaded for TailorTalk Broadcast, newest first — with the replies and visits each one brought.', '<button type="button" class="tsk-btn primary" onclick="PinCampaigns.startWizard()">+ New campaign</button>')
      + '<section class="cmp-card">' + (list.length ? list.map(function (c) { return campaignRow(c, true); }).join('')
        : '<p class="cmp-empty"' + (S.campaigns ? '' : ' role="status"') + '>' + (S.campaigns ? 'No campaigns yet. <button type="button" class="cmp-link" onclick="PinCampaigns.go(\'campaigns\')">See who is due a message</button>' : S.cmpError ? esc(S.cmpError) + ' <button type="button" class="cmp-link" onclick="PinCampaigns.reload()">Try again</button>' : 'Loading…') + '</p>') + '</section>';
  }
  var RSTATUS = { ready: 'Waiting', sending: 'Unknown — check TailorTalk', unknown: 'Unknown', sent: 'Sent', delivered: 'Delivered', read: 'Read', replied: 'Replied', failed: 'Failed', cancelled: 'Not sent', exported: 'In the CSV' };
  // A send that timed out: TailorTalk may or may not have sent it, so it is neither sent nor failed
  // until a person checks.
  function isUnknown(r) { return r.status === 'sending' || (r.uncertain && !/^(failed|cancelled)$/.test(r.status)); }
  // What the campaign led to, from the CRM's live leads: of the people it reached, who moved on.
  function outcomeOf(c) {
    var J = JM();
    if (!J) return null;
    var o = J.campaignOutcome(c, allLeads(), crmStages());
    if (c.mode === 'csv') o = J.outcomeFor(Object.keys(c.recipients || {}).filter(function (k) { return !(c.recipients[k] || {}).manual; }), c.createdAt || 0, allLeads(), crmStages());
    return o;
  }
  function outcomeHtml(c, o) {
    var C = CM();
    if (!o) return '';
    var rows = [['Replied', o.replied, 'r'], ['Site visit booked', o.visits, 'v'], ['Visited', o.visit_done, 'v'], ['Negotiating', o.negotiation, 'n'], ['Won', o.won, 'w']];
    if (o.optedOut) rows.push(['Asked not to be messaged', o.optedOut, 'x']);
    var max = Math.max(1, o.reached);
    var movers = Object.keys(o.leads).map(function (id) { return [leadById(id), o.leads[id]]; }).filter(function (x) { return x[0]; });
    var stepName = function (k) { var d = window.crmPipeline && window.crmPipeline.stageDef(k); return d ? d.name : k; };
    return '<section class="cmp-card cmp-outcome" aria-labelledby="cmpOutH"><div class="cmp-h2row"><h2 class="cmp-h2" id="cmpOutH">What it led to</h2><span class="cmp-muted">of the ' + o.reached + ' CRM lead' + (o.reached === 1 ? '' : 's') + ' it ' + (c.mode === 'csv' ? 'went to' : 'reached') + '</span></div>'
      + (o.reached ? '<div class="cmp-funnel">' + rows.map(function (r) {
        return '<div class="cmp-frow o-' + r[2] + '"><span class="cmp-fl">' + esc(r[0]) + '</span><span class="cmp-fbar" aria-hidden="true"><i style="width:' + Math.max(r[1] ? 2 : 0, Math.round(r[1] / max * 100)) + '%"></i></span><b>' + r[1] + '</b></div>';
      }).join('') + '</div>'
        + (movers.length ? '<p class="cmp-note">Moved on since: ' + movers.slice(0, 8).map(function (x) { return '<button type="button" class="cmp-link sm" onclick="openDetail(' + js(x[0].id) + ')">' + esc(C.greetingName(x[0].name) || '(no name)') + '</button> <span class="cmp-muted">(' + esc(stepName(x[1])) + ')</span>'; }).join(', ') + (movers.length > 8 ? ' and ' + (movers.length - 8) + ' more' : '') + '</p>' : '')
        + '<p class="cmp-note">Counted from each lead’s stage and visit after ' + esc(when(c.createdAt)) + '. A move can have other causes too — read it as a signal, not proof.</p>'
        : '<p class="cmp-empty">' + (c.mode === 'csv' ? 'Nobody from the CRM in this CSV.' : 'Nobody from the CRM has been reached yet.') + '</p>')
      + '</section>';
  }
  function detailHtml() {
    if (S.detailError) return '<button type="button" class="cmp-link" onclick="PinCampaigns.closeCampaign()">← All campaigns</button><div class="cmp-alert" role="alert">The campaign could not be opened: ' + esc(S.detailError) + ' <button type="button" class="cmp-link" onclick="PinCampaigns.openCampaign(' + js(S.detailId || '') + ')">Try again</button></div>';
    if (S.detailLoading || !S.detail) return '<p class="cmp-empty" role="status"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading the campaign…</p>';
    var c = S.detail, k = c.counts || {}, C = CM();
    var rec = Object.entries(c.recipients || {}).map(function (e) { return Object.assign({ key: e[0] }, e[1]); });
    var order = { failed: 0, sending: 1, ready: 2, replied: 3, read: 4, delivered: 5, sent: 6, exported: 7, cancelled: 8 };
    rec.sort(function (a, b) { return ((order[a.status] == null ? 9 : order[a.status]) - (order[b.status] == null ? 9 : order[b.status])) || ((b.reply && b.reply.at) || 0) - ((a.reply && a.reply.at) || 0) || String(a.name).localeCompare(String(b.name)); });
    var f = S.detailFilter || '';
    var match = function (r) { return f === 'unknown' ? isUnknown(r) : f === 'positive' ? sentiment(r.reply) === 'positive' : r.status === f; };
    var shown = f ? rec.filter(match) : rec;
    var unknownN = rec.filter(isUnknown).length;
    // "Replied" is always offered — it is the one people look for — the rest only when someone is in it.
    var tabs = [['', 'All', rec.length]].concat(['replied', 'positive', 'read', 'delivered', 'sent', 'failed', 'unknown', 'ready', 'cancelled', 'exported'].map(function (s) {
      return [s, s === 'positive' ? 'Positive' : RSTATUS[s], s === 'unknown' ? unknownN : s === 'positive' ? rec.filter(function (r) { return sentiment(r.reply) === 'positive'; }).length : rec.filter(function (r) { return r.status === s && !(s === 'sending'); }).length];
    }).filter(function (x) { return x[2] || (x[0] === 'replied' && c.mode !== 'csv'); }));
    var base = k.sent || 0;
    var est = C.estimateCost(c.mode === 'csv' ? (k.exported || 0) : base, c.category, settings());
    var o = outcomeOf(c);
    var stats = statsFor([Object.assign({}, c, { leadIds: [] })], { recipients: c.recipients, visits: o ? o.visits : 0 });
    var leadIds = new Set(allLeads().map(function (l) { return l.id; }));
    var limit = S.detailLimit || 500;
    return '<button type="button" class="cmp-link" onclick="PinCampaigns.closeCampaign()">← All campaigns</button>'
      + head(c.name, esc(c.template) + ' · ' + esc(when(c.createdAt)) + (c.createdBy ? ' · by ' + esc(c.createdBy) : '') + (c.audience ? ' · ' + esc(c.audience) : ''),
        (c.mode !== 'csv' ? '<button type="button" class="tsk-btn" ' + (S.refreshing ? 'disabled' : '') + ' onclick="PinCampaigns.refreshStatus()"><i class="fa-solid fa-rotate" aria-hidden="true"></i> ' + (S.refreshing ? 'Checking…' : 'Refresh delivery') + '</button>' : '')
        + (k.ready ? '<button type="button" class="tsk-btn primary" onclick="PinCampaigns.resume()">Send the ' + k.ready + ' waiting</button><button type="button" class="tsk-btn" onclick="PinCampaigns.cancel()">Don’t send them</button>' : '')
        + (k.failed ? '<button type="button" class="tsk-btn" onclick="PinCampaigns.retryFailed()">Retry the failed</button>' : '')
        + '<button type="button" class="tsk-btn" onclick="PinCampaigns.detailCsv()"><i class="fa-solid fa-download" aria-hidden="true"></i> Results CSV</button>'
        + '<button type="button" class="tsk-btn" onclick="PinCampaigns.ttCsv()" title="contact and the variables, as TailorTalk Broadcast takes it"><i class="fa-solid fa-file-csv" aria-hidden="true"></i> TailorTalk upload CSV</button>')
      + '<section class="cmp-kpis" aria-label="Delivery">' + (c.mode === 'csv' ? kpi('In the CSV', k.exported || 0, 'sent through TailorTalk Broadcast — results are in TailorTalk') + kpi('Estimated cost', '≈ ' + C.rupees(est.total), 'if all were sent')
        : kpi('Sent', base, k.total + ' in the campaign') + kpi('Delivered', C.pct(k.delivered, base) + '%', (k.delivered || 0) + ' · ' + C.pct(k.read, base) + '% read')
          + kpi('Positive replies', stats.positivePct + '%', stats.positive + ' positive · ' + (k.replied || 0) + ' replied')
          + kpi('Failed', k.failed || 0, unknownN ? unknownN + ' unknown — check them' : '', k.failed || unknownN ? 'has-bad' : '')
          + kpi('Estimated cost', '≈ ' + C.rupees(est.total), base + ' × ' + C.rupees(est.rate) + ', approximate')
          + kpi('Cost per positive reply', stats.costPerPositive != null ? '≈ ' + C.rupees(stats.costPerPositive) : '—', stats.costPerVisit != null ? '≈ ' + C.rupees(stats.costPerVisit) + ' per visit booked' : 'no visit booked yet')) + '</section>'
      + (c.statusCheckedAt ? '<p class="cmp-note cmp-checked">Delivery last checked ' + esc(ago(c.statusCheckedAt)) + '.</p>' : '')
      + outcomeHtml(c, o)
      + '<section class="cmp-card" aria-label="Who it went to"><div class="cmp-chips wrap" role="group" aria-label="Show">' + tabs.map(function (t) { return '<button type="button" class="cmp-chip' + (f === t[0] ? ' on' : '') + '" aria-pressed="' + (f === t[0]) + '" onclick="PinCampaigns.detailFilter(' + js(t[0]) + ')">' + esc(t[1]) + ' <b>' + t[2] + '</b></button>'; }).join('') + '</div>'
      + (f === 'unknown' && unknownN ? '<p class="cmp-note">TailorTalk did not answer when these were sent, so nobody knows yet whether they went. Look each one up in TailorTalk’s chat, then mark it — nothing is sent twice.</p>' : '')
      + (shown.length ? '<div class="cmp-rows">' + shown.slice(0, limit).map(function (r) {
        var rp = r.reply && (r.reply.text || r.reply.action) ? r.reply : null;
        var unk = isUnknown(r);
        return '<div class="cmp-r st-' + esc(unk ? 'sending' : r.status) + '"><span class="cmp-dot" aria-hidden="true"></span><div class="cmp-rmain"><div class="cmp-rname">' + (!r.manual && leadIds.has(r.key) ? '<button type="button" class="cmp-link" onclick="openDetail(' + js(r.key) + ')">' + esc(r.name || '(no name)') + '</button>' : esc(r.name || '(no name)')) + '</div>'
          + '<div class="cmp-muted">' + esc([C.prettyNumber(r.contact), Object.values(r.values || {}).slice(1).join(' · ')].filter(Boolean).join(' · ')) + '</div>'
          + (rp ? '<div class="cmp-reply">' + (rp.text ? '<span class="cmp-quote">“' + esc(rp.text) + '”</span>' : '') + '<span class="cmp-act a-' + esc(rp.action || 'other') + '">' + esc(C.replyMeaning(rp.action)) + '</span>' + (rp.at ? '<small class="cmp-muted">' + esc(when(rp.at)) + '</small>' : '') + '</div>' : '')
          + (r.status === 'cancelled' && r.why ? '<div class="cmp-hold">Not sent — ' + esc(r.why) + '</div>' : '')
          + (r.error ? '<div class="cmp-hold">' + esc(r.error) + (r.errorCode ? ' <span class="cmp-muted">(' + esc(r.errorCode) + ')</span>' : '') + '</div>' : '')
          + (unk ? '<div class="cmp-resolve"><span class="cmp-muted">Did it go?</span><button type="button" class="tsk-btn sm" ' + (S.busy['r:' + r.key] ? 'disabled' : '') + ' onclick="PinCampaigns.resolve(' + js(r.key) + ',\'sent\')">Mark as sent</button><button type="button" class="tsk-btn sm" ' + (S.busy['r:' + r.key] ? 'disabled' : '') + ' onclick="PinCampaigns.resolve(' + js(r.key) + ',\'failed\')">Mark as failed</button></div>' : '')
          + '</div>'
          + '<span class="cmp-rst">' + esc(unk ? RSTATUS.unknown : (RSTATUS[r.status] || r.status)) + (r.sentAt ? '<small>' + esc(when(r.sentAt)) + '</small>' : '') + '</span></div>';
      }).join('') + '</div>'
        + (shown.length > limit ? '<div class="cmp-more"><span class="cmp-muted">' + limit.toLocaleString('en-IN') + ' of ' + shown.length.toLocaleString('en-IN') + ' shown</span><button type="button" class="tsk-btn" onclick="PinCampaigns.detailMore()">Show ' + Math.min(500, shown.length - limit) + ' more</button></div>' : '')
        : '<p class="cmp-empty">' + (f === 'replied' ? 'No replies yet. They show here — with what each one means — as they come in.' : 'No one here.') + '</p>') + '</section>';
  }

  // ─── settings ─────────────────────────────────────────────────────────
  // What is typed in the settings dialog is kept as it is typed, so a redraw (a campaign list
  // arriving) never wipes it, and a field the server refuses is marked where it is.
  var SET_FIELDS = { testNumber: 'test', marketingGapDays: 'gap', marketingRate: 'mkt', utilityRate: 'util', quietStart: 'qs', quietEnd: 'qe', optOut: 'optOut' };
  function settingsDraft() {
    var st = settings(), C = CM();
    return { test: C.prettyNumber(st.testNumber), gap: String(st.marketingGapDays), mkt: String(st.marketingRate), util: String(st.utilityRate), qs: String(st.quietStart), qe: String(st.quietEnd), optOut: (st.optOut || []).map(C.prettyNumber).join('\n') };
  }
  function settingsModal() {
    var d = S.setDraft || settingsDraft(), C = CM(), err = S.setErr || {};
    var bad = function (k) { return err.field === k; };
    var errFor = function (k) { return bad(k) ? '<em class="cmp-ferr" id="cmpErr_' + k + '">' + esc(err.error) + '</em>' : ''; };
    var inv = function (k) { return bad(k) ? ' aria-invalid="true" aria-describedby="cmpErr_' + k + '"' : ''; };
    var hours = function (id, k, v) { var o = ''; for (var h = 0; h < 24; h++) o += '<option value="' + h + '"' + (Number(v) === h ? ' selected' : '') + '>' + esc(C.hourLabel(h)) + '</option>'; return '<select id="' + id + '"' + inv(k) + ' onchange="PinCampaigns.setField(' + js(k) + ',this.value,1)">' + o + '</select>'; };
    return '<div class="cmp-modal" role="dialog" aria-modal="true" aria-labelledby="cmpSetH"><div class="cmp-mbox">'
      + '<div class="cmp-mhead"><h2 id="cmpSetH">Campaign settings</h2><button type="button" class="cmp-x" aria-label="Close" onclick="PinCampaigns.closeModal()">×</button></div>'
      + (err.error && !SET_FIELDS[err.field] && !/^(test|gap|mkt|util|qs|qe|optOut)$/.test(err.field || '') ? '<div class="cmp-alert" role="alert">' + esc(err.error) + '</div>' : '')
      + '<label class="tsk-f"><span>Test number — every “Send a test” goes here and nowhere else</span><input id="cmpSetTest" inputmode="tel" value="' + esc(d.test) + '"' + inv('test') + ' oninput="PinCampaigns.setField(\'test\',this.value)">' + errFor('test') + '</label>'
      + '<label class="tsk-f"><span>Days between Marketing messages to the same lead</span><input id="cmpSetGap" type="number" min="0" max="90" value="' + esc(d.gap) + '"' + inv('gap') + ' oninput="PinCampaigns.setField(\'gap\',this.value)">' + errFor('gap') + '</label>'
      + '<fieldset class="cmp-fs"><legend>Cost per message, ₹ (approximate — for the estimate before sending)</legend><div class="cmp-row2">'
      + '<label class="tsk-f"><span>Marketing</span><input id="cmpSetMkt" type="number" min="0" max="50" step="0.01" inputmode="decimal" value="' + esc(d.mkt) + '"' + inv('mkt') + ' oninput="PinCampaigns.setField(\'mkt\',this.value)">' + errFor('mkt') + '</label>'
      + '<label class="tsk-f"><span>Utility</span><input id="cmpSetUtil" type="number" min="0" max="50" step="0.01" inputmode="decimal" value="' + esc(d.util) + '"' + inv('util') + ' oninput="PinCampaigns.setField(\'util\',this.value)">' + errFor('util') + '</label></div></fieldset>'
      + '<fieldset class="cmp-fs"><legend>Quiet hours, India time — sending asks first</legend><div class="cmp-row2">'
      + '<label class="tsk-f"><span>From</span>' + hours('cmpSetQs', 'qs', d.qs) + errFor('qs') + '</label>'
      + '<label class="tsk-f"><span>Until</span>' + hours('cmpSetQe', 'qe', d.qe) + errFor('qe') + '</label></div>'
      + (String(d.qs) === String(d.qe) ? '<p class="cmp-warn" role="status">From and Until are the same hour — that would switch quiet hours off, so campaigns could go out at midnight. Pick two different hours.</p>' : '')
      + '<p class="cmp-note">Marketing messages (offers) go out only 10 AM – 8 PM whatever this says.</p></fieldset>'
      + '<label class="tsk-f"><span>Never message these numbers (one per line) — people who asked to stop</span><textarea id="cmpSetOpt" rows="5"' + inv('optOut') + ' oninput="PinCampaigns.setField(\'optOut\',this.value)">' + esc(d.optOut) + '</textarea>' + errFor('optOut') + '</label>'
      + (S.setDropped && S.setDropped.length ? '<p class="cmp-warn" role="status">Saved. These lines are not phone numbers, so they were left out: ' + esc(S.setDropped.slice(0, 8).join(', ')) + (S.setDropped.length > 8 ? ' and ' + (S.setDropped.length - 8) + ' more' : '') + '.</p>' : '')
      + '<p class="cmp-note">Submitting templates straight to Meta: ' + (S.metaReady ? '<b>on</b>.' : 'off — it needs META_WABA_ID and META_WABA_TOKEN (a system-user token for the WhatsApp account TailorTalk uses) in Vercel. Templates are submitted through TailorTalk meanwhile.') + '</p>'
      + '<div class="cmp-mfoot"><button type="button" class="tsk-btn" onclick="PinCampaigns.closeModal()">' + (S.setDropped ? 'Close' : 'Cancel') + '</button><button type="button" class="tsk-btn primary" ' + (S.busy.settings ? 'disabled' : '') + ' onclick="PinCampaigns.saveSettings()">' + (S.busy.settings ? 'Saving…' : 'Save') + '</button></div></div></div>';
  }
  function startersModal() {
    var C = CM();
    var have = new Set((S.templates || []).map(function (t) { return t.name; }));
    return '<div class="cmp-modal" role="dialog" aria-modal="true" aria-labelledby="cmpStH"><div class="cmp-mbox wide">'
      + '<div class="cmp-mhead"><h2 id="cmpStH">Starter library</h2><button type="button" class="cmp-x" aria-label="Close" onclick="PinCampaigns.closeModal()">×</button></div>'
      + '<p class="cmp-note">Written to pass Meta’s review. Pick one to open it as a draft — change anything, then submit it.</p>'
      + '<div class="cmp-tgrid">' + C.STARTERS.map(function (s, i) {
        return '<article class="cmp-tcard"><div class="cmp-tchead"><span class="cmp-tn">' + esc(s.title) + '</span><span class="cmp-tpills">' + catPill(s.category) + '</span></div>' + bubble(Object.assign({}, s, { buttons: s.buttons }), null, { small: true })
          + '<div class="cmp-tacts">' + (have.has(s.name) ? '<span class="cmp-muted">Already in your library</span>' : '<button type="button" class="tsk-btn primary sm" onclick="PinCampaigns.useStarter(' + i + ')" aria-label="Use this: ' + esc(s.title) + '">Use this</button>') + '</div></article>';
      }).join('') + '</div></div></div>';
  }

  // The server will not send between quietStart and quietEnd (India time) unless told to — and a
  // Marketing message not outside 10 AM – 8 PM at all (the refusal says canOverride: false).
  function quietModal(kind, ctx, msg) {
    ctx = ctx || {};
    var f = function () {
      var test = kind === 'test', C = CM(), can = ctx.canOverride !== false, d = ctx.data || {};
      var from = d.sendFrom != null ? C.hourLabel(d.sendFrom) : '10 AM', until = d.sendUntil != null ? C.hourLabel(d.sendUntil) : '8 PM';
      var where = test ? 'This is only the test, to your own number.'
        : ctx.sent ? ctx.sent + ' sent, ' + ctx.waiting + ' waiting.' + (ctx.failed ? ' ' + ctx.failed + ' failed.' : '')
        : 'Nothing has been sent; ' + (ctx.waiting != null ? ctx.waiting : ctx.total || 0) + ' ' + ((ctx.waiting != null ? ctx.waiting : ctx.total) === 1 ? 'person is' : 'people are') + ' waiting.';
      return '<div class="cmp-modal" role="dialog" aria-modal="true" aria-labelledby="cmpQuietH"><div class="cmp-mbox">'
        + '<div class="cmp-mhead"><h2 id="cmpQuietH"><i class="fa-regular fa-moon" aria-hidden="true"></i> ' + (can ? 'It is quiet hours' : 'Offers go out only ' + esc(from) + '–' + esc(until)) + '</h2><button type="button" class="cmp-x" aria-label="Close" onclick="PinCampaigns.quietCancel()">×</button></div>'
        + (can ? '<p class="cmp-note">Between ' + esc(quietSpan()) + ' India time, campaigns are held so nobody is woken by a property message. ' + esc(where) + '</p>'
          : '<p class="cmp-note">Marketing messages — offers, new listings, price drops — go out only between ' + esc(from) + ' and ' + esc(until) + ' India time. This one cannot be sent anyway: an offer at night is what gets a number reported. ' + esc(where) + '</p>')
        + (msg && !/quiet hours|only between|10 ?AM/i.test(msg) ? '<p class="cmp-note">' + esc(msg) + '</p>' : '')
        + (test ? '' : '<p class="cmp-note">' + (can ? 'Cancel keeps the campaign with everyone waiting — send it in the morning from Campaigns with “Send the waiting”.' : 'The campaign is kept with everyone waiting — open it after ' + esc(from) + ' and press “Send the waiting”.') + '</p>')
        + '<div class="cmp-mfoot">' + (can ? '<button type="button" class="tsk-btn" onclick="PinCampaigns.quietCancel()">Cancel</button><button type="button" class="tsk-btn primary" onclick="PinCampaigns.quietSend()">Send anyway</button>'
          : '<button type="button" class="tsk-btn primary" onclick="PinCampaigns.quietCancel()">' + (test ? 'OK' : 'Keep them waiting') + '</button>') + '</div></div></div>';
    };
    f.quiet = { kind: kind, ctx: ctx };
    return f;
  }
  // The campaign replies nobody has acted on yet, each with its lead and what it meant.
  function repliesModal() {
    var C = CM(), list = repliesWaiting();
    return '<div class="cmp-modal" role="dialog" aria-modal="true" aria-labelledby="cmpRepH"><div class="cmp-mbox wide">'
      + '<div class="cmp-mhead"><h2 id="cmpRepH">Replies waiting for a person</h2><button type="button" class="cmp-x" aria-label="Close" onclick="PinCampaigns.closeModal()">×</button></div>'
      + '<p class="cmp-note">Each one is cleared when somebody acts on the lead — a note, a call logged, a follow-up, a stage move. A follow-up has already been set from the reply.</p>'
      + (list.length ? '<div class="cmp-rows">' + list.slice(0, 200).map(function (l) {
        var r = l.campaignReply;
        return '<div class="cmp-r cmp-rrep"><span class="cmp-dot r-' + esc(r.action || 'other') + '" aria-hidden="true"></span><div class="cmp-rmain">'
          + '<div class="cmp-rname"><button type="button" class="cmp-link" onclick="PinCampaigns.closeModal();openDetail(' + js(l.id) + ')">' + esc(l.name || '(no name)') + '</button></div>'
          + (r.text ? '<div class="cmp-quote">“' + esc(r.text) + '”</div>' : '')
          + '<div class="cmp-muted">' + esc([r.campaignName || r.template, ago(r.at)].filter(Boolean).join(' · ')) + '</div></div>'
          + '<span class="cmp-act a-' + esc(r.action || 'other') + '">' + esc(C.replyMeaning(r.action)) + '</span></div>';
      }).join('') + '</div>' : '<p class="cmp-empty">No replies waiting — every one has been picked up.</p>')
      + '</div></div>';
  }
  function saveListModal() {
    return '<div class="cmp-modal" role="dialog" aria-modal="true" aria-labelledby="cmpSlH"><div class="cmp-mbox">'
      + '<div class="cmp-mhead"><h2 id="cmpSlH">Save this list</h2><button type="button" class="cmp-x" aria-label="Close" onclick="PinCampaigns.closeModal()">×</button></div>'
      + '<p class="cmp-note">Saves the quick list, the filters and the property — not the ticks or contacts typed in — so next time the same kind of lead is one tap away, with whoever fits by then.</p>'
      + '<label class="tsk-f"><span>Name</span><input id="cmpListName" maxlength="60" placeholder="e.g. Anna Nagar buyers, quiet 30 days" onkeydown="if(event.key===\'Enter\')PinCampaigns.saveList()"></label>'
      + '<div class="cmp-mfoot"><button type="button" class="tsk-btn" onclick="PinCampaigns.closeModal()">Cancel</button><button type="button" class="tsk-btn primary" onclick="PinCampaigns.saveList()">Save</button></div></div></div>';
  }
  // The clipboard was refused: the text to copy by hand, and the person says when it is in
  // TailorTalk — only then is the draft marked submitted.
  function copyModal(name, text) {
    var f = function () {
      return '<div class="cmp-modal" role="dialog" aria-modal="true" aria-labelledby="cmpCopyH"><div class="cmp-mbox">'
        + '<div class="cmp-mhead"><h2 id="cmpCopyH">Copy this into TailorTalk</h2><button type="button" class="cmp-x" aria-label="Close" onclick="PinCampaigns.closeModal()">×</button></div>'
        + '<p class="cmp-note">The browser would not copy it by itself. Select it all, copy, and paste each part under Campaign → Templates → Create → Manual.</p>'
        + '<textarea class="cmp-copybox" id="cmpCopyBox" rows="14" readonly aria-label="Template text to copy" onfocus="this.select()">' + esc(text) + '</textarea>'
        + '<div class="cmp-mfoot"><button type="button" class="tsk-btn" onclick="PinCampaigns.closeModal()">Close</button><button type="button" class="tsk-btn primary" onclick="PinCampaigns.copiedByHand(' + js(name) + ')">I’ve submitted it in TailorTalk</button></div></div></div>';
    };
    f.id = 'copy';
    return f;
  }

  // ─── CSV ──────────────────────────────────────────────────────────────
  function download(name, text) {
    var blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    // A cell starting with = + - @ is a formula to a spreadsheet; a leading apostrophe defuses it.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // A CSV (or lines typed in) as rows of cells: quotes, commas inside quotes, doubled quotes and
  // line breaks inside quotes all read the way a spreadsheet wrote them. The separator is whichever
  // of , ; or tab the first line uses most.
  function splitCsv(text) {
    var s = String(text || '').replace(/^﻿/, '');
    var firstLine = (s.split(/\r?\n/).find(function (l) { return l.trim(); }) || '').replace(/"[^"]*"/g, '');
    var counts = { ',': (firstLine.match(/,/g) || []).length, ';': (firstLine.match(/;/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length };
    var sep = counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ',';
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"' && !cell.trim()) { q = true; cell = ''; }
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map(function (r) { return r.map(function (c) { return c.trim(); }); });
  }
  // A number as people and spreadsheets write it: "+91 98400 11111", "0091…", "098400…",
  // "+91 098400…". Scientific notation ("9.18E+11") is Excel having eaten the digits — not a number.
  function cleanNumber(raw) {
    var s = String(raw || '').trim();
    if (!s || /\d[.,]?\d*e[+-]?\d+/i.test(s)) return '';
    var d = s.replace(/\D/g, '');
    if (d.indexOf('00') === 0) d = d.slice(2);
    if (d.length === 13 && d.indexOf('910') === 0) d = '91' + d.slice(3);
    return CM().waNumber(d);
  }
  var HEAD_PHONE = /^(contact|phone|mobile|number|whatsapp|wa|cell|tel)\b|\b(phone|mobile|number|whatsapp|contact)\b/i;
  var HEAD_NAME = /^(name|full ?name|customer ?name|customer_name|lead ?name|lead_name|client ?name|first ?name|first_name)$/i;
  var HEAD_CODE = /^(code|property ?code|property_code|property|project ?code|listing ?code|ref)$/i;
  function looksLikeHeader(cells) {
    return cells.some(function (c) { return HEAD_PHONE.test(c) || HEAD_NAME.test(c) || HEAD_CODE.test(c) || /name|code/i.test(c); }) && !cells.some(function (c) { return cleanNumber(c); });
  }
  // Contacts from a CSV or lines typed in: { list: [{ contact, name, code }], bad, dupes }.
  // A header row (after any blank lines) says which column is which; without one, the cell that
  // is a number is the number, the first other text the name, a code-like cell the property.
  function parseContacts(text, have) {
    var rows = splitCsv(text), out = [], bad = 0, dupes = 0, seen = new Set(have || []);
    var cols = null;
    rows.forEach(function (cells) {
      if (!cells.join('').trim()) return;
      if (looksLikeHeader(cells)) {
        var find = function (re) { for (var i = 0; i < cells.length; i++) if (re.test(cells[i])) return i; return -1; };
        var name = find(HEAD_NAME); if (name < 0) name = find(/name/i);
        if (name >= 0 && /property|project/i.test(cells[name]) && find(HEAD_NAME) < 0) name = -1;
        var code = find(HEAD_CODE); if (code < 0) code = find(/code/i);
        cols = { phone: find(HEAD_PHONE), name: name, code: code };
        return;
      }
      var n = '', nm = '', cd = '';
      if (cols && cols.phone >= 0) {
        n = cleanNumber(cells[cols.phone]);
        nm = cols.name >= 0 ? cells[cols.name] || '' : '';
        cd = cols.code >= 0 ? cells[cols.code] || '' : '';
      } else if (cells.length === 1) {
        // "98400 11111 Ravi", "Ravi 98400 11111": the run of digits is the number, the rest the name.
        var m = /(\+?\d[\d\s().-]{8,}\d)/.exec(cells[0]);
        n = m ? cleanNumber(m[1]) : '';
        nm = m ? cells[0].replace(m[1], ' ').replace(/[,;]+/g, ' ').trim() : '';
      } else {
        var at = -1;
        for (var i = 0; i < cells.length; i++) if (cleanNumber(cells[i])) { at = i; break; }
        n = at >= 0 ? cleanNumber(cells[at]) : '';
        var rest = cells.filter(function (c, j) { return j !== at && c; });
        cd = rest.find(function (c) { return /^[A-Za-z]{2,6}\d{2,6}$/.test(c); }) || '';
        nm = rest.find(function (c) { return c !== cd; }) || '';
      }
      if (!n) { bad++; return; }
      if (seen.has(n)) { dupes++; return; }
      seen.add(n);
      out.push({ key: 'm_' + n, contact: n, name: nm.replace(/\s+/g, ' ').trim().slice(0, 80), code: String(cd || '').trim().toUpperCase() });
    });
    return { list: out, bad: bad, dupes: dupes };
  }

  // ─── actions ──────────────────────────────────────────────────────────
  function rerenderSoon(typing) { if (typing) { clearTimeout(rerenderSoon.t); rerenderSoon.t = setTimeout(render, 350); } else render(); }
  // A campaign opened from the list, a link or Back.
  async function loadCampaign(id) {
    S.view = 'cmp-history'; S.detail = null; S.detailLoading = true; S.detailFilter = ''; S.detailError = null; S.detailId = id; S.detailLimit = 500;
    render();
    try { var r = await api('get', { id: id }); if (S.detailId !== id) return; S.detail = r.campaign; } catch (e) { if (S.detailId !== id) return; S.detailError = e.message; }
    S.detailLoading = false; render();
    if (S.detail && S.detail.mode !== 'csv' && (!S.detail.statusCheckedAt || Date.now() - S.detail.statusCheckedAt > 5 * 60000) && Date.now() - S.detail.createdAt < 14 * DAY) A.refreshStatus(true);
  }
  function startFresh(view) { S.wiz = newWizard(); S.view = view || 'cmp-new'; S.detail = null; S.detailId = null; nav.push = true; }
  var A = {
    go: function (view) { nav.push = true; S.view = view; if (view !== 'cmp-history') { S.detail = null; S.detailError = null; S.detailId = null; } else { S.detail = null; S.detailError = null; S.detailLoading = false; S.detailId = null; } if (view === 'cmp-new' && !S.wiz) S.wiz = loadWiz() || newWizard(); render(); },
    reload: function () { loadTemplates(true); loadCampaigns(); loadSettings(); render(); },
    tplFilter: function (f) { S.tplFilter = f; render(); },
    tplSearch: function (q) { S.tplQ = q; rerenderSoon(true); },
    dismiss: function (key) { try { var d = dismissed(); d[key] = Date.now(); localStorage.setItem('pinCmpDismiss', JSON.stringify(d)); } catch (e) { /* this session only */ } toast('Hidden — “Show hidden” brings it back'); render(); },
    unhideAll: function () { try { localStorage.removeItem('pinCmpDismiss'); } catch (e) { /* nothing stored */ } render(); },
    // A suggested message, opened at "Who gets it" with its leads, its template and its property.
    // `anyway`: its template has a variable to type by hand — open it at step 2 to fill it.
    journey: function (key, anyway) {
      var j = journeys().find(function (x) { return x.key === key; });
      if (!j) { toast('That suggestion has changed — here is the latest'); return render(); }
      var t = templateFor(j.purpose) || (anyway ? stuckFor(j.purpose) : null);
      if (!t) { toast('No approved template for this yet'); return A.createFor(j.purpose); }
      startFresh();
      var w = S.wiz, C = CM(), p = propById(j.propertyId);
      w.purpose = j.purpose; w.quick = 'journey'; w.journey = { key: j.key, type: j.type, journey: j.journey || j.type, label: j.label, leadIds: j.leadIds.slice(), reasons: j.reasons || null };
      if (p && (j.type === 'sold_out' || j.type === 'new_listing')) { w.propertyMode = 'one'; w.propertyId = p.id; if (t.mediaHeader && p.brochureLink) w.headerMediaUrl = String(p.brochureLink); }
      w.name = starterTitle(j.purpose) + ' — ' + (p ? (C.propertyCode(p) || C.propertyLabel(p)) + ' · ' : '') + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      A.pickTemplate(t.name, true);
      // One brochure for everyone needs its file, and a variable to type needs typing: stop at step 2.
      var needsFile = t.mediaHeader && w.propertyMode === 'one' && !w.headerMediaUrl;
      var toType = (t.vars || []).some(function (v) { return (w.mapping[v] || {}).source === 'fixed'; });
      w.step = needsFile || toType ? 2 : 3;
      S.focusStep = true;
      window.scrollTo(0, 0);
      render();
    },
    // No approved template for a purpose: open the editor on the starter written for it.
    createFor: function (purpose) {
      var C = CM(), st = C.STARTERS.find(function (x) { return x.purpose === purpose; });
      var t = Object.assign(blankTemplate(), st ? JSON.parse(JSON.stringify(st)) : {}, { purpose: purpose });
      while ((S.templates || []).some(function (x) { return x.name === t.name; })) t.name = t.name.replace(/_v(\d+)$/, function (m, n) { return '_v' + (Number(n) + 1); });
      openEditor(t, 'new');
      S.editor.ai.purpose = purpose; S.editor.showAi = !st; render();
    },
    openReplies: function () { openModal(repliesModal); },

    newTemplate: function () { openEditor(blankTemplate(), 'new'); },
    editTemplate: function (name) { var t = tplByName(name); if (t) openEditor(t, 'edit'); },
    copyAsNew: function (name) { var t = tplByName(name); if (!t) return; var c = JSON.parse(JSON.stringify(t)); c.name = name.replace(/_v\d+$/, '') + '_v2'; openEditor(c, 'new'); },
    describe: function (name) { var t = tplByName(name); if (t) openEditor(Object.assign(blankTemplate(), t, { footer: t.footer || '' }), 'describe'); },
    // Cancel, ×, Esc: anything typed is asked about first.
    closeEditor: function () {
      if (editorDirty() && !confirm('Discard your changes to this template?')) return;
      S.editor = null; render();
    },
    edField: function (k, v, typing) {
      var t = S.editor.t;
      // A name is typed the way WhatsApp will take it: lower case, _ for anything else.
      t[k] = k === 'name' ? String(v).toLowerCase().replace(/[^a-z0-9_]/g, '_') : v;
      if (typing) refreshEditorPreview(); else render();
    },
    edButton: function (i, v) { var b = S.editor.t.buttons; b[i] = v; S.editor.t.buttons = [b[0] || '', b[1] || '', b[2] || ''].filter(function (x, j, all) { return x || all.slice(j + 1).some(Boolean); }); refreshEditorPreview(); },
    edExample: function (v, val) { S.editor.t.examples = S.editor.t.examples || {}; S.editor.t.examples[v] = val; refreshEditorPreview(); },
    insertVar: function (v) {
      var ta = document.getElementById('cmpBody'), t = S.editor.t, tok = '{{' + v + '}}';
      var at = ta ? ta.selectionStart : t.body.length, end = ta ? ta.selectionEnd : at;
      t.body = t.body.slice(0, at) + tok + t.body.slice(end);
      render();
      var nt = document.getElementById('cmpBody'); if (nt) { nt.focus(); nt.setSelectionRange(at + tok.length, at + tok.length); }
    },
    aiField: function (k, v, typing) { S.editor.ai[k] = v; if (!typing) render(); },
    aiWrite: async function () {
      var E = S.editor; if (E.ai.busy) return;
      E.ai.busy = true; E.ai.note = ''; render();
      try {
        var p = propById(E.ai.propertyId);
        var r = await api('ai-template', { purpose: E.ai.purpose, brief: E.ai.brief, tone: E.ai.tone, language: E.t.language, mediaHeader: E.t.mediaHeader,
          property: p ? { name: p.name, propertyCode: p.propertyCode, location: p.location, config: p.config, startingPrice: p.startingPrice } : null });
        var nt = r.template;
        if (!nt || typeof nt !== 'object') throw new Error('The AI did not write a template — try again');
        nt.buttons = (nt.buttons || []).map(function (b) { return (b && b.text) || b; });
        if (E.mode !== 'new') nt.name = E.t.name;
        else if ((S.templates || []).some(function (t) { return t.name === nt.name; })) nt.name = nt.name.replace(/_v(\d+)$/, function (m, n) { return '_v' + (Number(n) + 1); });
        if (S.editor !== E) return;
        E.t = Object.assign(blankTemplate(), nt, { mediaHeader: nt.mediaHeader != null ? nt.mediaHeader : E.t.mediaHeader, language: nt.language || E.t.language }); E.ai.note = r.note || ''; E.showAi = false;
      } catch (e) { E.ai.note = e.message; }
      E.ai.busy = false; render();
    },
    saveTemplate: async function () {
      var E = S.editor; if (E.saving) return;
      E.saving = true; render();
      try {
        var t = E.t;
        await api('save-template', { name: t.name, header: t.mediaHeader ? '' : t.header, body: t.body, footer: t.footer, buttons: t.buttons.filter(Boolean), category: t.category, language: t.language, mediaHeader: !!t.mediaHeader, examples: t.examples, purpose: t.purpose || E.ai.purpose, describeOnly: E.mode === 'describe' });
        toast(E.mode === 'describe' ? '✓ Text saved — campaigns can fill its variables now' : '✓ Draft saved. Next: Copy & open TailorTalk to submit it');
        S.editor = null; loadTemplates(true); render();
      } catch (e) { E.saving = false; toast(e.message); render(); }
    },
    // Marked submitted only once the text is really on the clipboard — or the person says it is in.
    copyToTailorTalk: async function (name) {
      var t = tplByName(name); if (!t) return;
      var text = CM().templateAsText(Object.assign({}, t, { buttons: (t.buttons || []).map(function (b) { return (b && b.text) || b; }) }));
      var copied = false;
      try { if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard'); await navigator.clipboard.writeText(text); copied = true; } catch (e) { copied = false; }
      window.open(CM().TAILORTALK_URL, '_blank', 'noopener');
      if (copied) { toast('✓ Copied. In TailorTalk: Campaign → Templates → Create → Manual, then paste each part'); A.markSubmitted(name); }
      else openModal(copyModal(name, text));
    },
    copiedByHand: function (name) { S.modal = null; render(); A.markSubmitted(name); toast('✓ Marked as submitted — it shows Approved here once Meta approves it'); },
    markSubmitted: function (name) { api('mark-submitted', { name: name }).then(function () { loadTemplates(true); }).catch(function (e) { toast('Not marked as submitted: ' + e.message); }); },
    metaSubmit: async function (name) {
      if (S.busy['meta:' + name] || !confirm('Submit ' + name + ' to Meta for approval now?')) return;
      S.busy['meta:' + name] = true;
      try { var r = await api('meta-submit', { name: name }); toast(r.notConfigured ? r.error : '✓ Submitted to Meta — status: ' + (r.status || 'pending')); loadTemplates(true); }
      catch (e) { toast(e.message); }
      S.busy['meta:' + name] = false;
    },
    deleteDraft: async function (name) {
      if (!confirm('Delete the draft ' + name + '? This does not touch TailorTalk.')) return;
      try { await api('delete-draft', { name: name }); toast('Draft deleted'); loadTemplates(true); } catch (e) { toast(e.message); }
    },
    openStarters: function () { openModal(startersModal); },
    useStarter: function (i) { var s = CM().STARTERS[i]; S.modal = null; openEditor(Object.assign(blankTemplate(), JSON.parse(JSON.stringify(s))), 'new'); },
    openSettings: function () {
      S.setDraft = settingsDraft(); S.setErr = null; S.setDropped = null;
      // The list as it was loaded: the server keeps any number added meanwhile (a STOP reply).
      S.setOptOutWas = ((S.settings && S.settings.optOut) || []).slice();
      openModal(settingsModal);
    },
    setField: function (k, v, redraw) {
      if (!S.setDraft) return;
      S.setDraft[k] = v;
      if (S.setErr && S.setErr.field === k) { S.setErr = null; redraw = true; }
      if (redraw) render();
    },
    closeModal: function () {
      if (S.busy.send && S.modal && S.modal.id === 'confirm') return;
      if (S.modal && S.modal.quiet) return A.quietCancel();
      S.modal = null; render();
    },
    saveSettings: async function () {
      var d = S.setDraft, C = CM();
      if (!d || S.busy.settings) return;
      // Checked here first, so the field that is wrong is marked before anything is sent.
      var num = function (s) { return String(s).trim() === '' ? NaN : Number(s); };
      var fail = function (field, error) { S.setErr = { field: field, error: error }; render(); var el = document.querySelector('.cmp-mbox [aria-invalid="true"]'); if (el) el.focus(); };
      if (!cleanNumber(d.test)) return fail('test', 'That is not a WhatsApp number — 10 digits, or with the country code');
      var gap = num(d.gap);
      if (!Number.isInteger(gap) || gap < 0 || gap > 90) return fail('gap', 'Whole days, 0 to 90 (0 = no gap)');
      var mkt = num(d.mkt), util = num(d.util);
      if (!(mkt >= 0 && mkt <= 50)) return fail('mkt', 'Rupees per message, 0 to 50 — e.g. 0.79');
      if (!(util >= 0 && util <= 50)) return fail('util', 'Rupees per message, 0 to 50 — e.g. 0.12');
      var lines = String(d.optOut || '').split(/[\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      var dropped = lines.filter(function (s) { return !cleanNumber(s); });
      S.busy.settings = true; S.setErr = null; render();
      try {
        var r = await api('settings', { save: true, testNumber: cleanNumber(d.test), marketingGapDays: gap, marketingRate: mkt, utilityRate: util,
          quietStart: Number(d.qs), quietEnd: Number(d.qe),
          optOut: lines.map(function (s) { return cleanNumber(s) || s; }), optOutWas: S.setOptOutWas || [] });
        S.settings = Object.assign({}, S.settings, r.settings || {}); S.jCache = null;
        var gone = Array.isArray(r.droppedOptOut) ? r.droppedOptOut : dropped;
        S.busy.settings = false;
        if (gone.length) {
          S.setDropped = gone; S.setDraft = settingsDraft(); S.setOptOutWas = ((S.settings && S.settings.optOut) || []).slice();
          toast('✓ Settings saved — ' + gone.length + ' line' + (gone.length === 1 ? ' was' : 's were') + ' not a number'); render();
        } else { S.modal = null; toast('✓ Settings saved'); render(); }
      } catch (e) {
        S.busy.settings = false;
        var dd = e.data || {}, field = SET_FIELDS[dd.field] || dd.field || null;
        S.setErr = { field: field, error: e.message };
        render();
        var el = document.querySelector('.cmp-mbox [aria-invalid="true"]'); if (el) el.focus();
        if (!field) toast(e.message);
      }
    },

    startWizard: function () { startFresh(); S.focusStep = true; render(); },
    resetWizard: function () { S.wiz = newWizard(); dropWiz(); nav.push = true; S.focusStep = true; render(); },
    useTemplate: function (name) { startFresh(); A.pickTemplate(name); },
    preset: function (purpose, propertyId) {
      startFresh();
      var w = S.wiz, t = templateFor(purpose);
      w.purpose = purpose;
      if (purpose === 'sold_out') { w.quick = 'soldout'; if (propertyId) { w.propertyMode = 'one'; w.propertyId = propertyId; } var p = propById(propertyId); w.name = 'Sold out — ' + (p ? (CM().propertyCode(p) || CM().propertyLabel(p)) : ''); }
      if (purpose === 'visit_feedback') { w.quick = 'visit_week'; w.name = 'Feedback — visits this week'; }
      if (purpose === 'visit_reminder') { w.quick = 'tomorrow'; w.name = 'Reminder — visits tomorrow'; }
      if (t) { A.pickTemplate(t.name, true); w.step = 3; }
      else toast('No approved ' + purpose.replace(/_/g, ' ') + ' template yet — create one on the Templates screen');
      render();
    },
    pickTemplate: function (name, quiet) {
      var w = S.wiz, t = tplByName(name);
      if (!t) return;
      w.template = name; w.mapping = autoMap(t, {}); w.edits = {}; w.req = null;
      if (!w.purpose) w.purpose = purposeOf(t);
      if (!w.name) w.name = name.replace(/_v\d+$/, '').replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }) + ' — ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      if (!quiet) render();
    },
    step: function (n) {
      if (!S.wiz || !stepAllowed(n)) return;
      S.wiz.step = n; nav.push = true; S.focusStep = true; window.scrollTo(0, 0); render();
    },
    // A value typed: kept at once; `typing` redraws a moment after the last key, 2 never.
    wiz: function (k, v, typing) {
      S.wiz[k] = v;
      if (k === 'propertyId' || k === 'propertyMode') S.wiz.edits = {};
      // Picking the one property fills its brochure, unless a file is already there.
      if (k === 'propertyId' && S.wiz.propertyMode === 'one') { var p = propById(v), t = wizTemplate(); if (p && p.brochureLink && t && t.mediaHeader && !S.wiz.headerMediaUrl) S.wiz.headerMediaUrl = String(p.brochureLink); }
      if (typing === 2) return saveWiz();
      rerenderSoon(typing);
    },
    setWiz: function (k, v) { if (S.wiz) { S.wiz[k] = v; saveWiz(); } },
    setName: function (v) { if (S.wiz) { S.wiz.name = v; saveWiz(); } },
    setFlag: function (k, v) { if (S.wiz) { S.wiz[k] = !!v; saveWiz(); } },
    mapVar: function (v, k, val, typing) { var m = S.wiz.mapping[v] = S.wiz.mapping[v] || { source: 'fixed', text: '' }; m[k] = val; rerenderSoon(typing); },
    quick: function (q) { S.wiz.quick = q; S.wiz.limit = 150; render(); },
    filter: function (k, v, typing) { S.wiz.f[k] = v; S.wiz.limit = 150; rerenderSoon(typing); },
    toggleStage: function (id) { var f = S.wiz.f, list = f.stages || (f.stages = []), i = list.indexOf(id); if (i >= 0) list.splice(i, 1); else list.push(id); S.wiz.limit = 150; render(); },
    clearFilters: function (andQuick) { var q = S.wiz.f.q; S.wiz.f = blankFilters(); if (andQuick) { S.wiz.quick = ''; } else S.wiz.f.q = q; S.wiz.limit = 150; render(); },
    // Saved lists: the quick list, filters and property under a name, kept in the campaign settings.
    saveListAsk: function () { openModal(saveListModal); },
    saveList: async function () {
      var w = S.wiz, el = document.getElementById('cmpListName'), name = el ? el.value.trim() : '';
      if (!name) { if (el) el.focus(); return toast('Give the list a name'); }
      if (S.busy.list) return;
      var def = { quick: w.quick === 'journey' ? '' : w.quick, f: JSON.parse(JSON.stringify(w.f)), propertyMode: w.propertyMode, propertyId: w.propertyId || '' };
      S.busy.list = true;
      try {
        var r = await api('save-list', { name: name, def: def });
        var lists = r.lists || (r.settings && r.settings.lists);
        if (lists) S.settings = Object.assign({}, S.settings, { lists: lists }); else loadSettings();
        S.modal = null; toast('✓ Saved “' + name + '”' + (w.quick === 'journey' ? ' (the suggestion itself is not saved — only the filters)' : '')); render();
      } catch (e) { toast(e.message); }
      S.busy.list = false;
    },
    loadList: function (id) {
      var x = settings().lists.find(function (l) { return l.id === id; }); if (!x) return;
      var w = S.wiz, def = x.def || x;
      w.quick = def.quick || ''; w.f = Object.assign(blankFilters(), def.f || {}); w.journey = null; w.ai = null; w.limit = 150; w.unchecked = {};
      if (def.propertyId || def.propertyMode) { w.propertyMode = def.propertyMode === 'one' ? 'one' : 'own'; w.propertyId = def.propertyId || ''; w.edits = {}; }
      toast('Using “' + x.name + '”'); render();
    },
    deleteList: async function (id) {
      var x = settings().lists.find(function (l) { return l.id === id; }); if (!x || !confirm('Delete the saved list “' + x.name + '”?')) return;
      try {
        var r = await api('delete-list', { id: id });
        var lists = r.lists || (r.settings && r.settings.lists);
        if (lists) S.settings = Object.assign({}, S.settings, { lists: lists }); else loadSettings();
        toast('List deleted'); render();
      } catch (e) { toast(e.message); }
    },
    tick: function (key, on) { if (on) delete S.wiz.unchecked[key]; else S.wiz.unchecked[key] = 1; refreshRows([key]); },
    checkAll: function (on) { wizRows().forEach(function (r) { if (on) delete S.wiz.unchecked[r.key]; else S.wiz.unchecked[r.key] = 1; }); render(); },
    // More than a campaign holds: the first 1,000 (as listed) stay ticked, the rest are unticked.
    firstN: function () {
      var max = CM().MAX_RECIPIENTS, n = 0;
      wizRows().forEach(function (r) { if (!r.on) return; n++; if (n > max) S.wiz.unchecked[r.key] = 1; });
      toast('The first ' + max.toLocaleString('en-IN') + ' are ticked — send the rest in a second campaign');
      render();
    },
    // A value changed on one row: that row is redrawn after the focus has moved on, so Tab lands
    // on the next box as it would anywhere else.
    edit: function (key, v, val) {
      var e = S.wiz.edits[key] = S.wiz.edits[key] || {}; e[v] = val;
      setTimeout(function () { refreshRows([key]); }, 0);
    },
    more: function () { S.wiz.limit += 150; render(); },
    addManual: function () {
      var w = S.wiz, byNum = leadsByNumber();
      w.handLeads = w.handLeads || {};
      var have = w.manual.map(function (m) { return m.contact; }).concat(Object.keys(w.handLeads).map(function (id) { var l = leadById(id); return l ? contactOf(l) : ''; }).filter(Boolean));
      var p = parseContacts(w.manualText, have);
      var asLeads = 0;
      p.list.forEach(function (m) {
        var lead = byNum[m.contact];
        if (lead) { w.handLeads[lead.id] = { code: m.code || '' }; asLeads++; }
        else w.manual.push(m);
      });
      w.manualText = '';
      w.addNote = p.list.length + ' added' + (asLeads ? ' (' + asLeads + ' already in the CRM, added as ' + (asLeads === 1 ? 'that lead' : 'those leads') + ')' : '')
        + (p.dupes ? ' · ' + p.dupes + ' duplicate' + (p.dupes === 1 ? '' : 's') + ' skipped' : '')
        + (p.bad ? ' · ' + p.bad + ' without a valid number' : '');
      toast(w.addNote);
      render();
    },
    uploadCsv: function (input) {
      var f = input.files && input.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { S.wiz.manualText = String(rd.result || ''); A.addManual(); };
      rd.readAsText(f);
      // The same file picked again still loads.
      try { input.value = ''; } catch (e) { /* read-only in old browsers */ }
    },
    removeManual: function (key) { var w = S.wiz; w.manual = w.manual.filter(function (m) { return m.key !== key; }); if (w.handLeads) delete w.handLeads[key]; render(); },
    clearManual: function () { S.wiz.manual = []; S.wiz.handLeads = {}; S.wiz.addNote = ''; render(); },
    askAi: async function () {
      var w = S.wiz; if (!w.aiQ.trim()) return toast('Say who you want to reach');
      if (w.aiBusy) return;
      var saveAi = w.ai; w.ai = null;
      var pool = allLeads().filter(function (l) { return filterMatch(l, w); }).sort(function (a, b) { return lastActive(b) - lastActive(a); }).slice(0, 400);
      w.ai = saveAi;
      if (!pool.length) return toast('No leads to choose from — loosen the filters');
      w.aiBusy = true; render();
      try {
        var C = CM();
        var r = await api('ai-audience', { question: w.aiQ, leads: pool.map(function (l) {
          var v = visitOfLead(l), st = stageOf(l);
          var props = linkedProps(l).map(function (p) { return (C.propertyCode(p) || '') + ' ' + C.propertyLabel(p) + (p.soldOut ? ' (sold)' : ''); }).join(', ');
          return { id: l.id, text: [l.name, st ? 'stage ' + st.name : '', l.tt && l.tt.status ? 'TailorTalk ' + l.tt.status : '', intentOf(l), l.propertyInterest || (l.tt && l.tt.values && l.tt.values.propertyInterest) || '', l.budget ? 'budget ' + l.budget : '', props ? 'properties ' + props : '', v.at ? 'visit ' + v.status + ' ' + C.visitDate(v.at) + (v.property ? ' ' + v.property : '') : '', l.ai && l.ai.line, l.lostReason ? 'lost: ' + l.lostReason : '', l.aiSummary ? String(l.aiSummary).slice(0, 220) : ''].filter(Boolean).join('; ') };
        }) });
        var picks = {}; (r.picks || []).forEach(function (p) { picks[p.id] = p.reason || 'picked'; });
        w.ai = { q: w.aiQ, picks: picks, considered: r.considered || pool.length };
        toast('AI picked ' + Object.keys(picks).length + ' of ' + w.ai.considered);
      } catch (e) { toast(e.message); }
      w.aiBusy = false; render();
    },
    clearAi: function () { S.wiz.ai = null; render(); },
    preview: function (d) { var n = wizRows().filter(function (r) { return r.on; }).length; S.wiz.previewAt = (S.wiz.previewAt + d + n) % Math.max(1, n); render(); },
    // The test is the message shown in the preview — that person's values, that person's file.
    testSend: async function (allowQuiet) {
      if (S.busy.test) return;
      var w = S.wiz, t = wizTemplate(), rows = wizRows().filter(function (x) { return x.on; });
      var r = rows[Math.min(w.previewAt, Math.max(0, rows.length - 1))];
      if (!r || !t) return;
      S.busy.test = true; render();
      try {
        var body = { template: t.name, vars: t.vars || [], values: r.values, requestId: newRequestId(),
          headerMediaUrl: t.mediaHeader ? (r.mediaUrl || null) : null, headerMediaName: t.mediaHeader ? (r.mediaName || null) : null };
        if (allowQuiet === true) body.allowQuietHours = true;
        var res = await api('test-send', body);
        if (res.uncertain) toast('TailorTalk did not answer — look at WhatsApp on ' + CM().prettyNumber(res.to || settings().testNumber) + ' before testing again');
        else if (res.duplicate) toast('That test has just gone — check WhatsApp on ' + CM().prettyNumber(res.to || settings().testNumber));
        else toast('✓ Test of ' + (CM().greetingName(r.name) || 'this') + '’s message sent to ' + CM().prettyNumber(res.to || settings().testNumber) + ' — check WhatsApp');
      } catch (e) {
        if (isQuietRefusal(e) && allowQuiet !== true) { S.busy.test = false; return openModal(quietModal('test', { canOverride: !(e.data && e.data.canOverride === false), data: e.data || {} }, e.message)); }
        toast(e.message);
      }
      S.busy.test = false; render();
    },
    quietSend: function () {
      var q = S.modal && S.modal.quiet; S.modal = null; render();
      if (!q || q.ctx.canOverride === false) return;
      if (q.kind === 'test') A.testSend(true);
      else runSend(q.ctx.id, q.ctx.total, true);
    },
    quietCancel: function () {
      var q = S.modal && S.modal.quiet; S.modal = null;
      if (q && q.kind === 'send') { S.wiz = null; dropWiz(); toast('Kept — ' + (q.ctx.waiting || 0) + ' waiting. Send them from this campaign ' + (q.ctx.canOverride === false ? 'after 10 AM.' : 'in the morning.')); loadCampaigns(); A.openCampaign(q.ctx.id); }
      else render();
    },
    downloadCsv: async function () {
      if (S.busy.csv) return;
      var p = payload('csv'), C = CM();
      p.requestId = requestIdFor('csv', p);
      S.busy.csv = true; render();
      download(C.slugName(p.name || p.template) + '.csv', C.toCsv(p.recipients, p.vars));
      try {
        var r = await api('create', p);
        loadCampaigns();
        toast(r.duplicate ? '✓ CSV downloaded again — it was already recorded under Campaigns' : '✓ CSV downloaded and recorded under Campaigns. Upload it in TailorTalk → Campaign → Broadcast');
      } catch (e) { toast('CSV downloaded (not recorded: ' + e.message + ')'); }
      S.busy.csv = false; render();
    },
    confirmSend: function () {
      var n = wizRows().filter(function (r) { return r.on; }).length, t = wizTemplate();
      if (!n || S.busy.send) return;
      S.confirmN = '';
      var f = function () {
        var ok = String(S.confirmN || '').trim() === String(n);
        return '<div class="cmp-modal" role="dialog" aria-modal="true" aria-labelledby="cmpConfH"><div class="cmp-mbox">'
          + '<div class="cmp-mhead"><h2 id="cmpConfH">Send to ' + n + ' ' + (n === 1 ? 'person' : 'people') + '?</h2><button type="button" class="cmp-x" aria-label="Close" ' + (S.busy.send ? 'disabled' : '') + ' onclick="PinCampaigns.closeModal()">×</button></div>'
          + '<p class="cmp-note">“' + esc(t.name) + '” goes out now from your WhatsApp number through TailorTalk. A message once sent cannot be taken back. ' + (t.category === 'MARKETING' ? 'This is a Marketing template — WhatsApp charges for each.' : '') + '</p>'
          + '<label class="tsk-f"><span>Type ' + n + ' to confirm</span><input id="cmpConfirmN" inputmode="numeric" autocomplete="off" value="' + esc(S.confirmN || '') + '" ' + (S.busy.send ? 'readonly' : '') + ' oninput="PinCampaigns.confirmTyped(this.value)" onkeydown="if(event.key===\'Enter\'){event.preventDefault();PinCampaigns.send()}"></label>'
          + '<div class="cmp-mfoot"><button type="button" class="tsk-btn" ' + (S.busy.send ? 'disabled' : '') + ' onclick="PinCampaigns.closeModal()">Cancel</button><button type="button" id="cmpGo" class="tsk-btn primary" ' + (ok && !S.busy.send ? '' : 'disabled') + ' onclick="PinCampaigns.send()">' + (S.busy.send ? 'Starting…' : 'Send now') + '</button></div></div></div>';
      };
      f.id = 'confirm'; f.n = n;
      openModal(f);
    },
    confirmTyped: function (v) {
      S.confirmN = v;
      var go = document.getElementById('cmpGo');
      if (go) go.disabled = !!S.busy.send || String(v).trim() !== String(S.modal && S.modal.n);
    },
    // Once: the first press turns the button off before anything else happens, and the request
    // carries an id the server remembers — a second press, or a retry after a timeout, can never
    // make a second campaign.
    send: async function () {
      if (S.busy.send || !S.modal || S.modal.id !== 'confirm') return;
      if (String(S.confirmN || '').trim() !== String(S.modal.n)) return;
      S.busy.send = true;
      var go = document.getElementById('cmpGo'); if (go) { go.disabled = true; go.textContent = 'Starting…'; }
      render();
      var p = payload('send');
      p.requestId = requestIdFor('send', p);
      try {
        var r = await api('create', p);
        if (!r.id) throw new Error('The campaign was not created — try again');
        S.modal = null; S.busy.send = false; S.lastSentId = r.id;
        if (r.duplicate) toast('Already started — carrying on with the same campaign');
        await runSend(r.id, (r.counts && r.counts.total) || p.recipients.length, false, r.skipped || []);
      } catch (e) {
        S.busy.send = false; S.modal = null;
        var sk = e.data && Array.isArray(e.data.skipped) && e.data.skipped.length ? ' (' + whySummary(e.data.skipped) + ')' : '';
        toast(e.message + sk);
        if (e.timeout) { loadCampaigns(); A.go('cmp-history'); } else render();
      }
    },
    stopSending: function () { if (S.sending && !S.sending.stop) { S.sending.stop = true; render(); } },
    finishSending: function () { var id = S.sending && S.sending.id; S.sending = null; S.wiz = null; dropWiz(); if (id) A.openCampaign(id); else A.go('cmp-history'); },

    openCampaign: function (id) { nav.push = true; return loadCampaign(id); },
    closeCampaign: function () { nav.push = true; S.detail = null; S.detailError = null; S.detailLoading = false; S.detailId = null; render(); },
    detailFilter: function (f) { S.detailFilter = f; S.detailLimit = 500; render(); },
    detailMore: function () { S.detailLimit = (S.detailLimit || 500) + 500; render(); },
    refreshStatus: async function (quiet) {
      if (!S.detail || S.refreshing) return;
      var id = S.detail.id;
      S.refreshing = true; render();
      try { await api('status', { id: id }); var g = await api('get', { id: id }); if (S.detailId === id) S.detail = g.campaign; if (!quiet) toast('✓ Delivery updated'); loadCampaigns(); }
      catch (e) { if (!quiet) toast(e.message); }
      S.refreshing = false; render();
    },
    resume: async function () { var d = S.detail; if (!d || S.sending) return; await runSend(d.id, d.counts.total); },
    cancel: async function () { if (!S.detail || !confirm('Leave the waiting ones unsent?')) return; try { await api('cancel', { id: S.detail.id }); loadCampaign(S.detail.id); } catch (e) { toast(e.message); } },
    // A send TailorTalk never answered: the person checks in TailorTalk and says whether it went.
    resolve: async function (key, status) {
      var d = S.detail; if (!d || S.busy['r:' + key]) return;
      S.busy['r:' + key] = true; render();
      try {
        await api('resolve', { id: d.id, key: key, status: status });
        var g = await api('get', { id: d.id }); if (S.detailId === d.id) S.detail = g.campaign;
        toast(status === 'sent' ? '✓ Marked as sent' : '✓ Marked as failed — “Retry the failed” can send it again');
        loadCampaigns();
      } catch (e) { toast(e.message); }
      S.busy['r:' + key] = false; render();
    },
    // The failed ones again: CRM leads as leads (every rule that holds them back still applies),
    // numbers typed in as numbers. Not the ones WhatsApp says must not be tried again: a person who
    // stopped Marketing messages (131050), or one tried too often this week (131049).
    retryFailed: function () {
      var d = S.detail; if (!d) return;
      var C = CM(), byNum = leadsByNumber();
      var NO_RETRY = { '131050': 'stopped Marketing messages', '131049': 'WhatsApp asks to wait a week' };
      var leadIds = [], manual = [], edits = {}, skipped = {};
      Object.keys(d.recipients || {}).forEach(function (k) {
        var r = d.recipients[k]; if (r.status !== 'failed') return;
        var code = String(r.errorCode || ((/\(#?(13\d{4})\)|#(13\d{4})|\b(13\d{4})\b/.exec(String(r.error || '')) || []).slice(1).find(Boolean)) || '');
        if (NO_RETRY[code]) { skipped[NO_RETRY[code]] = (skipped[NO_RETRY[code]] || 0) + 1; return; }
        var lead = (!r.manual && leadById(k)) || byNum[C.waNumber(r.contact)] || null;
        if (lead) { if (leadIds.indexOf(lead.id) < 0) { leadIds.push(lead.id); edits[lead.id] = r.values; } }
        else { manual.push({ key: 'm_' + r.contact, contact: r.contact, name: r.name, code: '' }); edits['m_' + r.contact] = r.values; }
      });
      startFresh();
      A.pickTemplate(d.template, true);
      var w = S.wiz;
      w.name = d.name + ' — retry'; w.mapping = d.mapping && Object.keys(d.mapping).length ? d.mapping : w.mapping; w.propertyMode = d.propertyMode || 'own'; w.propertyId = d.propertyId || ''; w.headerMediaUrl = d.headerMediaUrl || ''; w.lockLead = !!d.lockLead;
      w.purpose = d.purpose || w.purpose;
      w.manual = manual; w.edits = edits;
      if (leadIds.length) { w.quick = 'journey'; w.journey = { key: 'retry:' + d.id, type: 'retry', label: 'Failed in “' + d.name + '”', leadIds: leadIds }; w.onlyManual = false; }
      else { w.quick = ''; w.onlyManual = true; }
      w.step = 3; S.focusStep = true; S.detail = null;
      var left = Object.keys(skipped).map(function (k) { return skipped[k] + ' ' + k; }).join(' · ');
      toast((leadIds.length + manual.length) + ' to retry — check them, then send' + (left ? '. Not retried: ' + left : ''));
      render();
    },
    // What happened to each person, for a spreadsheet.
    detailCsv: function () {
      var d = S.detail; if (!d) return;
      var C = CM();
      var lines = [['contact', 'name', 'status', 'reply', 'meaning', 'error', 'sent at'].map(csvCell).join(',')];
      Object.keys(d.recipients || {}).forEach(function (k) {
        var r = d.recipients[k], rp = r.reply || {};
        lines.push([r.contact, r.name || '', isUnknown(r) ? 'unknown' : r.status === 'cancelled' && r.why ? 'not sent — ' + r.why : r.status, rp.text || '', rp.action ? C.replyMeaning(rp.action) : '', r.error || '', r.sentAt ? new Date(r.sentAt).toLocaleString('en-IN') : ''].map(csvCell).join(','));
      });
      download(C.slugName(d.name) + '-results.csv', lines.join('\r\n') + '\r\n');
    },
    // The same people, as TailorTalk Broadcast takes them (contact + the variables) — everyone the
    // campaign still may message.
    ttCsv: function () {
      var d = S.detail; if (!d) return;
      var rows = Object.keys(d.recipients || {}).map(function (k) { return d.recipients[k]; }).filter(function (r) { return r.status !== 'cancelled'; });
      download(CM().slugName(d.name) + '-tailortalk.csv', CM().toCsv(rows, d.vars || []));
    }
  };
  window.PinCampaigns = A;

  // Esc closes the open dialog (never the sending one — Stop is the way out of that); Tab stays
  // inside it.
  document.addEventListener('keydown', function (e) {
    var h = host();
    if (!h || h.style.display === 'none') return;
    if (e.key === 'Tab') {
      var box = h.querySelector('.cmp-modal:last-of-type .cmp-mbox') || h.querySelector('.cmp-modal .cmp-mbox');
      if (!box) return;
      var list = focusables(box);
      if (!list.length) return;
      var i = list.indexOf(document.activeElement);
      if (i < 0) { e.preventDefault(); list[0].focus(); }
      else if (e.shiftKey && i === 0) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
      return;
    }
    if (e.key !== 'Escape' || S.sending) return;
    if (S.modal) { e.preventDefault(); A.closeModal(); }
    else if (S.editor) { e.preventDefault(); A.closeEditor(); }
  });

  // toggleView hands every campaigns view here. Picked from the rail (not a reload or Back), it is
  // a move: it gets its own history entry.
  window.renderCampaignsView = function (view) {
    if (view && view !== S.view) {
      S.view = view;
      if (view !== 'cmp-history') { S.detail = null; S.detailError = null; S.detailId = null; }
    }
    if (S.booted && !nav.restoring && !parseHash(location.hash)) nav.push = true;
    if (!S.booted) { S.booted = true; boot(); }
    render();
  };
  // The leads are live: a change redraws the screen that lists them.
  window.campaignsLeadsChanged = function () {
    S.jCache = null;
    var h = host();
    if (!h || h.style.display === 'none' || S.editor || S.modal || S.sending) return;
    if (S.view === 'campaigns' || (S.view === 'cmp-new' && S.wiz && S.wiz.step >= 3)) rerenderSoon(true);
  };
})();
