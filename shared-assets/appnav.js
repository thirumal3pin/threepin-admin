/* ═══════════════════════════════════════════════════════════════════════
   APP RAIL — the map, and the one behaviour that drives it
   ═══════════════════════════════════════════════════════════════════════

   Every console used to carry its own idea of what the rest of the app was:
   the dashboard offered "Lead CRM", the CRM offered "Property Intelligence"
   and "Finance", Finance offered nothing at all. Five buttons across three
   headers, none of them saying where you already were.

   This file holds the whole map once, and every page renders the same rail
   from it. Adding a console is an entry in MAP, not an edit to three headers.

   ── The one rule the rail follows ──
   A section header OPENS that section. It never navigates. An item inside it
   navigates. Only one section is open at a time, so clicking Finance is what
   puts the finance pages on screen, and clicking CRM is what takes them away
   again. Two clicks to change console, and never a wrong guess about which of
   the two a click was going to be.

   Sections with nothing inside them (Daily task, Create brochure) have no
   chevron and go straight there — there is no second level to open, so there
   is nothing for the first click to mean.

   ── Same page vs. another page ──
   An item whose `page` is the console we are running on calls the host back
   through cfg.select(nav) and nothing reloads. Otherwise it is a link, and
   the target page picks the view up from ?nav= (or, for Finance, the hash it
   already routes on). AppNav.takeNav() hands that to the host on boot.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ═══════ THE MAP ═══════
  //
  // Finance keys and group names are duplicated from finance-assets/app.js on
  // purpose — that file owns routing, this one owns the menu, and neither
  // should have to import the other at runtime. tests/appnav.test.mjs fails
  // the build if the two ever drift apart.

  var FIN_GROUPS = [
    ['Daily', 'What you touch most days', [
      ['overview', 'Overview', 'fa-solid fa-gauge-high'],
      ['record', 'Record', 'fa-solid fa-plus'],
      ['month', 'This month', 'fa-regular fa-calendar-check'],
      ['txns', 'Transactions', 'fa-solid fa-list'],
      ['owed', 'Owed', 'fa-solid fa-right-left'],
    ]],
    ['Business', 'Deals, commitments and what you expect', [
      ['deals', 'Deals & invoices', 'fa-regular fa-handshake'],
      ['services', 'Recurring', 'fa-solid fa-rotate'],
      ['budget', 'Budget', 'fa-regular fa-calendar'],
    ]],
    ['Money', 'Where the cash actually is', [
      ['bank', 'Bank & card statements', 'fa-solid fa-building-columns'],
      ['petty', 'Petty cash', 'fa-solid fa-coins'],
      ['loans', 'Loans', 'fa-solid fa-percent'],
      ['assets', 'Assets', 'fa-regular fa-square'],
    ]],
    ['Tax & reports', 'What you file and what you read', [
      ['gst', 'GST', 'fa-solid fa-stamp'],
      ['reports', 'Reports', 'fa-regular fa-chart-bar'],
      ['analytics', 'Analytics', 'fa-solid fa-chart-column'],
      ['books', 'Books', 'fa-solid fa-book'],
    ]],
    ['Setup', 'Company details and how the app behaves', [
      ['profile', 'Profile', 'fa-regular fa-id-badge'],
      ['settings', 'Settings', 'fa-solid fa-sliders'],
      ['guide', 'Guide', 'fa-regular fa-circle-question'],
    ]],
  ];

  var MAP = [
    {
      // The agent layer: everyone's day in one place (myday.html) — an agent's home page.
      id: 'myday', label: 'My Day', icon: 'fa-solid fa-house', page: 'myday', nav: 'myday', tab: 'myday', badge: 'myday',
      note: 'Approvals, site visits and follow-ups for today',
    },
    {
      // An agent's Properties: their own in full, the rest as a summary (listings.html). Everyone
      // else has the Property dashboard below.
      id: 'myprops', label: 'Properties', icon: 'fa-regular fa-building', page: 'myprops', nav: 'myprops', tab: 'properties',
      note: 'Your properties, and the rest as a summary', agentOnly: true,
    },
    {
      id: 'messages', label: 'Messages', icon: 'fa-regular fa-message', page: 'messages', nav: 'messages', tab: 'messages', badge: 'messages',
      note: 'Team chat, and a thread for every request',
    },
    {
      id: 'today', label: 'Daily task', icon: 'fa-regular fa-sun', page: 'crm', nav: 'today', tab: 'tasks',
      note: 'Your visits and tasks for today',
    },
    {
      id: 'tasks', label: 'Tasks', icon: 'fa-solid fa-list-check', page: 'crm', nav: 'tasks', badge: 'tasks', tab: 'tasks',
      note: 'Work assigned to the team, and to you',
    },
    {
      id: 'calendar', label: 'Team calendar', icon: 'fa-regular fa-calendar-days', page: 'crm', nav: 'calendar', tab: 'calendar',
      note: 'Who is where, and when everyone is free',
    },
    {
      id: 'property', label: 'Properties', icon: 'fa-regular fa-building', page: 'property', tab: 'properties', notForAgents: true,
      note: 'The inventory, and everything that keeps it right',
      items: [
        { id: 'all', label: 'Property Intelligence Dashboard', icon: 'fa-solid fa-list', page: 'property', nav: 'all' },
        { id: 'missing', label: 'Missing data', icon: 'fa-solid fa-triangle-exclamation', page: 'property', nav: 'missing', badge: 'missing', staffOnly: true },
        { id: 'changes', label: 'Changes to apply', icon: 'fa-regular fa-clock', page: 'property', nav: 'changes', staffOnly: true },
        { id: 'areamap', label: 'Area map', icon: 'fa-solid fa-map-location-dot', page: 'property', nav: 'areamap', staffOnly: true },
        { id: 'sync', label: 'Sync from sheet', icon: 'fa-solid fa-rotate', page: 'property', nav: 'sync', staffOnly: true },
      ],
    },
    {
      id: 'crm', label: 'CRM', icon: 'fa-regular fa-comments', page: 'crm', tab: 'crm',
      note: 'Leads, the board and what is owed a reply',
      items: [
        { id: 'kanban', label: 'Board', icon: 'fa-solid fa-table-columns', page: 'crm', nav: 'kanban' },
        { id: 'list', label: 'List', icon: 'fa-solid fa-bars', page: 'crm', nav: 'list' },
        { id: 'followups', label: 'Follow-ups', icon: 'fa-regular fa-calendar-check', page: 'crm', nav: 'followups', badge: 'followups' },
        { id: 'dashboard', label: 'Analytics', icon: 'fa-solid fa-chart-column', page: 'crm', nav: 'dashboard', staffOnly: true },
      ],
    },
    {
      id: 'wa', label: 'WhatsApp Campaigns', icon: 'fa-brands fa-whatsapp', page: 'crm', tab: 'campaigns',
      note: 'Templates, lead lists and campaigns through TailorTalk',
      items: [
        { id: 'campaigns', label: 'Dashboard', icon: 'fa-solid fa-gauge-high', page: 'crm', nav: 'campaigns' },
        { id: 'cmp-templates', label: 'Templates', icon: 'fa-regular fa-file-lines', page: 'crm', nav: 'cmp-templates', staffOnly: true },
        { id: 'cmp-new', label: 'New campaign', icon: 'fa-regular fa-paper-plane', page: 'crm', nav: 'cmp-new', needs: 'sendCampaigns' },
        { id: 'cmp-history', label: 'Campaigns', icon: 'fa-solid fa-clock-rotate-left', page: 'crm', nav: 'cmp-history' },
      ],
    },
    {
      id: 'metaads', label: 'Meta Ads Leads', icon: 'fa-brands fa-meta', page: 'crm', tab: 'ads',
      note: 'Leads from the Google Sheets your Meta ads fill — test mode',
      items: [
        { id: 'meta-leads', label: 'Leads', icon: 'fa-solid fa-users', page: 'crm', nav: 'meta-leads' },
        { id: 'ml-dupes', label: 'Duplicates', icon: 'fa-regular fa-clone', page: 'crm', nav: 'ml-dupes' },
        { id: 'ml-analysis', label: 'Analysis', icon: 'fa-solid fa-chart-column', page: 'crm', nav: 'ml-analysis', staffOnly: true },
        { id: 'ml-setup', label: 'Setup', icon: 'fa-solid fa-sliders', page: 'crm', nav: 'ml-setup', staffOnly: true },
      ],
    },
    {
      id: 'finance', label: 'Finance', icon: 'fa-solid fa-indian-rupee-sign', page: 'finance', tab: 'finance',
      note: 'Deals, bills, invoices and the books',
      groups: FIN_GROUPS.map(function (g) {
        return {
          id: g[0], label: g[0], note: g[1],
          items: g[2].map(function (it) {
            return { id: it[0], label: it[1], icon: it[2], page: 'finance', nav: it[0] };
          }),
        };
      }),
    },
    {
      id: 'track', label: 'Shoot & Media', icon: 'fa-solid fa-camera-retro', page: 'track', tab: 'shoots',
      note: 'Listings from owner yes to brochure out, the shoots, and where each is posted',
      items: [
        { id: 'board', label: 'Board', icon: 'fa-solid fa-table-columns', page: 'track', nav: 'board' },
        { id: 'shoots', label: 'Shoots', icon: 'fa-regular fa-calendar-check', page: 'track', nav: 'shoots' },
        { id: 'editor', label: 'Editor', icon: 'fa-solid fa-scissors', page: 'track', nav: 'editor' },
        { id: 'mediaCalendar', label: 'Calendar', icon: 'fa-regular fa-calendar-days', page: 'track', nav: 'calendar' },
        { id: 'posting', label: 'Posting', icon: 'fa-solid fa-bullhorn', page: 'track', nav: 'posting', badge: 'posting' },
        { id: 'sellers', label: 'Sellers', icon: 'fa-solid fa-tag', page: 'track', nav: 'sellers', badge: 'sellers' },
        { id: 'settings', label: 'Settings', icon: 'fa-solid fa-sliders', page: 'track', nav: 'settings' },
      ],
    },
    {
      id: 'brochure', label: 'Create brochure', icon: 'fa-regular fa-file-lines', page: 'property', nav: 'brochure',
      note: 'New listing intake — Claude builds the brochure',
      apart: true,
    },
    {
      // Admins only (role claim 'admin'): logins, roles and what agents may see. team.html.
      id: 'team', label: 'Team & access', icon: 'fa-solid fa-user-shield', page: 'team', nav: 'team', badge: 'team',
      note: 'Who can sign in, their role, and what agents see',
      adminOnly: true,
    },
  ];

  // Where each console lives, and what a bare visit to it should open.
  var PAGES = {
    myday: { href: 'myday.html', home: 'myday' },
    myprops: { href: 'listings.html', home: 'myprops' },
    messages: { href: 'messages.html', home: 'messages' },
    property: { href: 'dashboard.html', home: 'all' },
    crm: { href: 'crm.html', home: 'kanban' },
    finance: { href: '3pinfinance', home: 'overview' },
    track: { href: 'propertytrack.html', home: 'board' },
    team: { href: 'team.html', home: 'team' },
  };

  var K_SECTION = 'appnav.section';
  var K_MIN = 'appnav.min';
  var K_GROUPS = 'appnav.finance.groups';
  var DESKTOP = '(min-width: 900px)';

  var cfg = null;          // set by AppNav.boot()
  var openSection = null;  // exactly one, or null when every section is shut
  var openGroups = null;   // Set of finance group names
  var active = null;       // id of the item the host says is showing
  var badges = {};
  var root = null;
  // Who is looking (shared-assets/access.js): { role: 'admin' | 'agent' | 'none', tabs: [...] }.
  // From the first paint it is this device's last answer (access.js keeps it, and every sign-out
  // forgets it), so an agent's menu never flashes the full one. A device that has never been told
  // waits for the answer with the sections hidden — never a timed fallback to the full menu;
  // access.js always answers, from the server, the token, or signed out (access null).
  var access = (typeof window !== 'undefined' && window.__pinAccess) || (function () {
    try {
      var last = JSON.parse(localStorage.getItem('pin.access.last') || 'null');
      return last && last.role ? { role: last.role, tabs: last.tabs || null, actions: (last.config && last.config.actions) || null } : { pending: true };
    } catch (e) { return null; }
  })();

  // ── Small helpers ──
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function read(key, fallback) {
    try { var v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private window */ }
  }
  function isDesktop() { return window.matchMedia(DESKTOP).matches; }
  function sectionById(id) {
    for (var i = 0; i < MAP.length; i++) if (MAP[i].id === id) return MAP[i];
    return null;
  }
  function itemsOf(sec) {
    if (sec.items) return sec.items;
    if (!sec.groups) return [];
    return sec.groups.reduce(function (all, g) { return all.concat(g.items); }, []);
  }
  function groupHolding(sec, itemId) {
    if (!sec.groups) return null;
    for (var i = 0; i < sec.groups.length; i++) {
      var g = sec.groups[i];
      for (var j = 0; j < g.items.length; j++) if (g.items[j].id === itemId) return g.id;
    }
    return null;
  }

  // Everything is open until the owner closes it. A Finance group that hides
  // itself on first sight is indistinguishable from one that is broken.
  function groupsOpen() {
    if (openGroups) return openGroups;
    var saved = null;
    try { saved = JSON.parse(read(K_GROUPS, 'null')); } catch (e) { saved = null; }
    openGroups = new Set(Array.isArray(saved) ? saved : FIN_GROUPS.map(function (g) { return g[0]; }));
    return openGroups;
  }

  // ── What this person may see ──
  // An agent sees only the sections whose `tab` the admin gave them (agentConfigs, team.html), and
  // never a `staffOnly` entry. `adminOnly` entries are for admins. This only tidies the menu: what
  // an agent can actually read is decided by the database rules and the server.
  function allowed(entry, parent) {
    if (access && access.pending) return false;
    if (entry.adminOnly) return !!(access && access.role === 'admin');
    if (entry.agentOnly) return !!(access && access.role === 'agent');
    if (access && access.role === 'agent') {
      if (entry.notForAgents) return false;
      if (entry.staffOnly) return false;
      // An entry for something the admin may switch off for agents (agent settings → actions).
      if (entry.needs && !(access.actions && access.actions[entry.needs])) return false;
      var tab = entry.tab || (parent && parent.tab);
      return !!tab && (access.tabs || []).indexOf(tab) >= 0;
    }
    return true;
  }
  // A ?nav= deep link to a view the menu would not offer this person (an agent following an old
  // link to Setup or Analytics) is ignored; the page opens on its home view instead.
  function navAllowed(nav) {
    for (var i = 0; i < MAP.length; i++) {
      var sec = MAP[i];
      if (sec.page !== (cfg && cfg.console)) continue;
      if (sec.nav === nav) return allowed(sec);
      var list = itemsOf(sec);
      for (var j = 0; j < list.length; j++) if (list[j].nav === nav) return allowed(sec) && allowed(list[j], sec);
    }
    return true;
  }
  function navAllowedId(id) {
    for (var i = 0; i < MAP.length; i++) {
      var sec = MAP[i];
      if (sec.page !== (cfg && cfg.console)) continue;
      if (sec.id === id && !sec.items && !sec.groups) return allowed(sec);
      var list = itemsOf(sec);
      for (var j = 0; j < list.length; j++) if (list[j].id === id) return allowed(sec) && allowed(list[j], sec);
    }
    return true;
  }
  function visibleMap() {
    return MAP.filter(function (sec) { return allowed(sec); }).map(function (sec) {
      if (sec.items) return Object.assign({}, sec, { items: sec.items.filter(function (it) { return allowed(it, sec); }) });
      if (sec.groups) return Object.assign({}, sec, { groups: sec.groups.map(function (g) {
        return Object.assign({}, g, { items: g.items.filter(function (it) { return allowed(it, sec); }) });
      }) });
      return sec;
    });
  }

  // ── Where a click goes ──
  //
  // Same console: hand it back to the page, which switches view without a
  // reload. Another console: a real URL, so the browser does what a link does
  // — new tab on middle-click, back button, the lot.
  function hrefFor(item) {
    var page = PAGES[item.page];
    if (!page) return '#';
    if (item.page === 'finance') return page.href + '#' + item.nav;
    return page.href + (item.nav && item.nav !== page.home ? '?nav=' + encodeURIComponent(item.nav) : '');
  }

  function goto(item) {
    closeDrawer();
    if (item.page === cfg.console) {
      // Marked first, then handed over: an entry that opens a dialog rather
      // than a page (Sync, Create brochure) puts the highlight back on the
      // page underneath, and it has to get the last word.
      setActive(item.id);
      if (cfg.select) cfg.select(item.nav, item);
      return;
    }
    location.href = hrefFor(item);
  }

  // ═══════ RENDER ═══════

  function badgeHtml(item) {
    var n = item.badge ? badges[item.badge] : 0;
    if (!n) return '';
    // A seller with no listing card is revenue sitting untouched — it earns
    // the same red treatment as an overdue follow-up or a property missing data.
    var alert = item.badge === 'followups' || item.badge === 'missing' || item.badge === 'sellers' || item.badge === 'posting' || item.badge === 'tasks' || item.badge === 'myday' || item.badge === 'messages' || item.badge === 'team';
    return '<span class="rl-badge' + (alert ? ' alert' : '') + '" aria-hidden="true">' + (n > 99 ? '99+' : n) + '</span>'
      + '<span class="sr-only"> (' + n + ')</span>';
  }

  function itemHtml(item) {
    var on = item.id === active && item.page === cfg.console;
    return '<a class="rl-item' + (on ? ' on' : '') + '" href="' + esc(hrefFor(item)) + '"'
      + ' data-item="' + esc(item.id) + '" data-page="' + esc(item.page) + '"'
      + (on ? ' aria-current="page"' : '') + ' title="' + esc(item.label) + '">'
      + '<i class="rl-ico ' + esc(item.icon) + '" aria-hidden="true"></i>'
      + '<span class="rl-nm">' + esc(item.label) + '</span>' + badgeHtml(item) + '</a>';
  }

  function groupHtml(sec, g, hereItem) {
    var open = groupsOpen().has(g.id);
    var holds = hereItem && groupHolding(sec, hereItem) === g.id;
    if (holds) open = true;
    return '<div class="rl-grp' + (open ? ' open' : '') + '">'
      + '<button type="button" class="rl-grp-h" data-group="' + esc(g.id) + '"'
      + ' aria-expanded="' + open + '" title="' + esc(g.note || g.label) + '">'
      + '<span class="rl-gnm">' + esc(g.label) + '</span>'
      + (holds && !open ? '<span class="rl-dot"></span>' : '')
      + '<i class="rl-chev fa-solid fa-chevron-down" aria-hidden="true"></i>'
      + '</button>'
      + '<div class="rl-grp-body">' + g.items.map(itemHtml).join('') + '</div>'
      + '</div>';
  }

  // A section carries the counts of everything inside it, for when the section
  // is shut (or the rail is narrowed) and those entries are not on screen.
  function sectionBadge(sec) {
    return itemsOf(sec).reduce(function (n, x) { return n + (x.badge ? (badges[x.badge] || 0) : 0); }, 0);
  }

  function sectionHtml(sec) {
    var here = sec.page === cfg.console || (sec.items || sec.groups ? false : sec.page === cfg.console);
    var leaf = !sec.items && !sec.groups;
    var open = !leaf && openSection === sec.id;
    var hereItem = here ? active : null;

    if (leaf) {
      var on = here && active === sec.id;
      return '<section class="rl-sec leaf' + (on ? ' here' : '') + '">'
        + '<a class="rl-h' + (on ? ' on' : '') + '" href="' + esc(hrefFor(sec)) + '"'
        + ' data-item="' + esc(sec.id) + '" data-page="' + esc(sec.page) + '"'
        + ' title="' + esc(sec.note || sec.label) + '">'
        + '<i class="rl-ico ' + esc(sec.icon) + '" aria-hidden="true"></i>'
        + '<span class="rl-nm">' + esc(sec.label) + '</span>' + badgeHtml(sec)
        + '</a></section>';
    }

    var body = sec.groups
      ? sec.groups.map(function (g) { return groupHtml(sec, g, hereItem); }).join('')
      : sec.items.map(itemHtml).join('');

    var n = sectionBadge(sec);
    return '<section class="rl-sec' + (open ? ' open' : '') + (here ? ' here' : '') + '">'
      + '<button type="button" class="rl-h" data-section="' + esc(sec.id) + '"'
      + ' aria-expanded="' + open + '"'
      + ' title="' + esc(sec.note || sec.label) + ' — click to ' + (open ? 'close' : 'open') + '">'
      + '<i class="rl-ico ' + esc(sec.icon) + '" aria-hidden="true"></i>'
      + '<span class="rl-nm">' + esc(sec.label) + '</span>'
      + (here && !open ? '<span class="rl-dot" title="You are here"></span>' : '')
      + (n ? '<span class="rl-badge alert rl-sum" aria-hidden="true">' + (n > 99 ? '99+' : n) + '</span>' : '')
      + '<i class="rl-chev fa-solid fa-chevron-down" aria-hidden="true"></i>'
      + '</button>'
      + '<div class="rl-body">' + body + '</div>'
      + '</section>';
  }

  function render() {
    if (!root) return;
    var nav = root.querySelector('.rail-nav');
    nav.innerHTML = visibleMap().map(sectionHtml).join('');
    var who = root.querySelector('.rail-who');
    who.textContent = cfg.user || '';
    who.style.display = cfg.user ? '' : 'none';
    var sb = root.querySelector('.rail-brand-sb');
    if (sb) sb.textContent = access && access.role === 'agent' ? 'Agent' : access && access.role === 'admin' ? 'Admin' : 'Team';
    renderTabbar();
  }

  // ── An agent's tab bar (phones): My Day · Properties · Messages · Leads · More ──
  // The four places an agent goes all day, one tap each; More opens the full menu. Only the tabs
  // the admin gave them, and only below the desktop width (the rail is always there above it).
  var TABBAR = [
    { id: 'myday', label: 'My Day', icon: 'fa-solid fa-house', page: 'myday', nav: 'myday', tab: 'myday', badge: 'myday' },
    { id: 'myprops', label: 'Properties', icon: 'fa-regular fa-building', page: 'myprops', nav: 'myprops', tab: 'properties' },
    { id: 'messages', label: 'Messages', icon: 'fa-regular fa-message', page: 'messages', nav: 'messages', tab: 'messages', badge: 'messages' },
    { id: 'kanban', label: 'Leads', icon: 'fa-solid fa-user-group', page: 'crm', nav: 'kanban', tab: 'crm' },
  ];
  function renderTabbar() {
    var bar = document.getElementById('pinTabbar');
    var on = !!(access && access.role === 'agent');
    document.body.classList.toggle('has-tabbar', on);
    if (!on) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('nav');
      bar.id = 'pinTabbar'; bar.className = 'pin-tabbar'; bar.setAttribute('aria-label', 'Main');
      document.body.appendChild(bar);
      bar.addEventListener('click', function (e) {
        var more = e.target.closest('[data-more]');
        if (more) { e.preventDefault(); openDrawer(); return; }
        var a = e.target.closest('a[data-item]');
        if (!a || e.metaKey || e.ctrlKey) return;
        var it = TABBAR.filter(function (x) { return x.id === a.dataset.item; })[0];
        if (it && it.page === cfg.console) { e.preventDefault(); goto(it); }
      });
    }
    var tabs = (access.tabs || []);
    bar.innerHTML = TABBAR.filter(function (it) { return tabs.indexOf(it.tab) >= 0; }).map(function (it) {
      var here = it.page === cfg.console && (it.page !== 'crm' || active === 'kanban' || active === 'list');
      var n = it.badge ? (badges[it.badge] || 0) : 0;
      return '<a href="' + esc(hrefFor(it)) + '" data-item="' + esc(it.id) + '"' + (here ? ' aria-current="page" class="on"' : '') + '>'
        + '<i class="' + esc(it.icon) + '" aria-hidden="true"></i><span>' + esc(it.label) + '</span>'
        + (n ? '<b class="tb-n" aria-label="' + n + ' new">' + (n > 99 ? '99+' : n) + '</b>' : '') + '</a>';
    }).join('') + '<a href="#" data-more><i class="fa-solid fa-bars" aria-hidden="true"></i><span>More</span></a>';
  }

  // ═══════ STATE CHANGES ═══════

  function openOnly(id) {
    openSection = openSection === id ? null : id;
    write(K_SECTION, openSection || '');
    render();
    var el = root.querySelector('[data-section="' + id + '"]');
    if (el) el.focus();
  }

  function toggleGroup(id) {
    var open = groupsOpen();
    if (open.has(id)) open.delete(id); else open.add(id);
    write(K_GROUPS, JSON.stringify([].slice.call(open)));
    render();
    var el = root.querySelector('[data-group="' + id + '"]');
    if (el) el.focus();
  }

  function setActive(id) {
    active = id;
    // Landing on a page always shows the section that page belongs to. Coming
    // back to a console you had collapsed and finding nothing open would read
    // as the rail having forgotten you.
    var sec = null;
    for (var i = 0; i < MAP.length; i++) {
      if (MAP[i].page !== cfg.console) continue;
      var list = itemsOf(MAP[i]);
      if (MAP[i].id === id || list.some(function (x) { return x.id === id; })) { sec = MAP[i]; break; }
    }
    if (sec && (sec.items || sec.groups) && openSection !== sec.id) {
      openSection = sec.id;
      write(K_SECTION, openSection);
    }
    render();
  }

  // ── Narrow / drawer ──
  function setMin(on) {
    document.body.classList.add('rail-anim');   // a person's toggle eases; the page load does not
    document.body.classList.toggle('rail-min', !!on);
    write(K_MIN, on ? '1' : '0');
    syncToggle();
  }
  function openDrawer() { document.body.classList.add('rail-open'); syncToggle(); }
  function closeDrawer() { document.body.classList.remove('rail-open'); syncToggle(); }
  function toggle() {
    if (isDesktop()) setMin(!document.body.classList.contains('rail-min'));
    else document.body.classList.contains('rail-open') ? closeDrawer() : openDrawer();
  }
  function syncToggle() {
    var expanded = isDesktop()
      ? !document.body.classList.contains('rail-min')
      : document.body.classList.contains('rail-open');
    [].forEach.call(document.querySelectorAll('[data-rail-toggle]'), function (b) {
      b.setAttribute('aria-expanded', String(expanded));
      b.setAttribute('aria-label', expanded ? 'Hide menu' : 'Show menu');
      b.title = expanded ? 'Hide menu' : 'Show menu';
    });
  }

  // ═══════ MOUNT ═══════

  var TOGGLE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

  function mount() {
    root = document.createElement('div');
    root.id = 'appRail';
    root.setAttribute('data-console', cfg.console);
    root.innerHTML =
      // Root-absolute, because the rail is rendered by pages at more than one
      // depth (the preview harness lives in /tests/) and the logo must not
      // resolve differently depending on which one drew it.
      '<div class="rail-head">'
      + '<a class="rail-brand" href="/index.html" title="All consoles">'
      + '<img src="/logo.jpg" alt="">'
      + '<span class="rail-brand-tx"><span class="rail-brand-nm">3 PIN Realty</span>'
      + '<span class="rail-brand-sb">Admin</span></span></a>'
      + '</div>'
      + '<nav class="rail-nav" aria-label="Consoles"></nav>'
      + '<div class="rail-foot">'
      + '<div class="rail-who"></div>'
      + '<button type="button" class="rail-out"><i class="rl-ico fa-solid fa-arrow-right-from-bracket" '
      + 'aria-hidden="true"></i><span>Sign out</span></button>'
      + '</div>';
    document.body.insertBefore(root, document.body.firstChild);

    var scrim = document.createElement('div');
    scrim.className = 'rail-scrim';
    scrim.addEventListener('click', closeDrawer);
    document.body.insertBefore(scrim, root.nextSibling);

    // One listener for the whole rail — the markup is rewritten on every
    // state change, so per-element handlers would have to be rebound each time.
    root.addEventListener('click', function (e) {
      var sec = e.target.closest('[data-section]');
      if (sec) {
        // Narrowed, there is nowhere to show what is inside a section — so
        // asking for one widens the rail and opens it, in a single click.
        if (isDesktop() && document.body.classList.contains('rail-min')) {
          setMin(false);
          openSection = null;
        }
        openOnly(sec.getAttribute('data-section'));
        return;
      }
      var grp = e.target.closest('[data-group]');
      if (grp) { toggleGroup(grp.getAttribute('data-group')); return; }
      var item = e.target.closest('[data-item]');
      if (item) {
        // Let the browser handle a deliberate new-tab or new-window click.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) { closeDrawer(); return; }
        e.preventDefault();
        var id = item.getAttribute('data-item');
        var page = item.getAttribute('data-page');
        var found = null;
        MAP.forEach(function (s) {
          if (s.id === id && s.page === page && !s.items && !s.groups) found = s;
          itemsOf(s).forEach(function (x) { if (x.id === id && x.page === page) found = x; });
        });
        if (found) goto(found);
      }
    });
    root.querySelector('.rail-out').addEventListener('click', function () {
      closeDrawer();
      try { localStorage.removeItem('pin.access.last'); sessionStorage.removeItem('pin.access'); } catch (e) {}
      if (cfg.signOut) cfg.signOut();
    });

    [].forEach.call(document.querySelectorAll('[data-rail-toggle]'), function (b) {
      if (!b.innerHTML.trim()) b.innerHTML = TOGGLE_SVG;
      b.addEventListener('click', function (e) { e.preventDefault(); toggle(); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('rail-open')) closeDrawer();
    });
    // Narrowing and the drawer are different states of the same rail; crossing
    // the breakpoint with the drawer open would leave it stuck open on a
    // desktop, where nothing can close it.
    window.matchMedia(DESKTOP).addEventListener('change', function () { closeDrawer(); syncToggle(); });
  }

  // The rail waits behind the login screen. Every console reveals its app the
  // same way — #appRoot stops being display:none — so watching that one
  // element works on all three without touching any auth code.
  function watchAppRoot() {
    var appRoot = document.getElementById('appRoot');
    var shown = function () { return !appRoot || appRoot.style.display !== 'none'; };
    var apply = function () { document.body.classList.toggle('rail-on', shown()); };
    apply();
    if (!appRoot) return;
    new MutationObserver(apply).observe(appRoot, { attributes: true, attributeFilter: ['style'] });
  }

  // ═══════ PUBLIC ═══════

  // ═══════ BACK CLOSES THE PANEL ═══════
  // A full-screen panel (a lead, a card) owns one history entry while it is open, so the phone's
  // Back button — or the browser's — closes it instead of leaving the console with it (and anything
  // unsaved in it). Opening another lead in the same panel reuses the entry; closing it from the page
  // takes the entry back out, so history never piles up.
  var layers = [];      // [{ id, close }]
  var skipPops = 0;     // our own history.back() calls, not the person's
  var deferred = 0;     // entries to add once those land (a panel opened while one was still closing)
  function pushEntry() {
    try { history.pushState({ pinLayer: layers.length ? layers[layers.length - 1].id : '', pinDepth: layers.length }, '', location.href); } catch (e) {}
  }
  function openLayer(id, close) {
    if (layers.length && layers[layers.length - 1].id === id) return;
    layers.push({ id: id, close: close });
    // Closing one panel and opening the next in the same moment: history.back() lands later, so the
    // new entry waits for it — pushed now, the back would take the NEW entry away instead.
    if (skipPops) deferred++; else pushEntry();
  }
  function closeLayer(id) {
    var i = -1;
    for (var k = layers.length - 1; k >= 0; k--) if (layers[k].id === id) { i = k; break; }
    if (i < 0) return;
    layers.splice(i, 1);
    // Its entry not pushed yet (still waiting on an earlier back): nothing to take out.
    if (deferred) { deferred--; return; }
    skipPops++;
    try { history.back(); } catch (e) { skipPops--; }
  }
  window.addEventListener('popstate', function () {
    if (skipPops) {
      skipPops--;
      if (!skipPops) while (deferred) { deferred--; pushEntry(); }
      return;
    }
    var top = layers.pop();
    if (top && typeof top.close === 'function') top.close();
  });

  window.AppNav = {
    openLayer: openLayer,
    closeLayer: closeLayer,
    /* cfg: { console, select(nav, item), signOut(), user } */
    boot: function (options) {
      cfg = options || {};
      if (!PAGES[cfg.console]) throw new Error('AppNav: unknown console ' + cfg.console);
      var saved = read(K_SECTION, null);
      openSection = saved === '' ? null : (saved && sectionById(saved) ? saved : null);
      if (openSection === null && saved === null) {
        // First ever visit: open the console you are standing in.
        for (var i = 0; i < MAP.length; i++) {
          if (MAP[i].page === cfg.console && (MAP[i].items || MAP[i].groups)) { openSection = MAP[i].id; break; }
        }
      }
      if (read(K_MIN, '0') === '1') document.body.classList.add('rail-min');
      mount();
      watchAppRoot();
      syncToggle();
      render();
      return window.AppNav;
    },

    /* The view the host should open, from ?nav= or the finance hash. Read once
       and cleaned out of the URL, so a refresh does not re-trigger a modal. */
    takeNav: function () {
      var value = null;
      try {
        var url = new URL(location.href);
        value = url.searchParams.get('nav');
        if (value) {
          url.searchParams.delete('nav');
          history.replaceState(null, '', url.pathname + url.search + url.hash);
        }
      } catch (e) { /* older browser: no deep link, everything else still works */ }
      if (value && access && access.role === 'agent' && !navAllowed(value)) return null;
      return value;
    },

    setActive: setActive,
    setUser: function (email) { if (cfg) { cfg.user = email; render(); } },
    /* From shared-assets/access.js once the role is known. */
    setAccess: function (a) {
      access = a || null; window.__pinAccess = access; render();
      // An agent standing on a view they may not see (an old link, opened before the role was known):
      // back to the console's home view.
      if (access && access.role === 'agent' && cfg && active && cfg.select && !navAllowedId(active)) {
        var home = PAGES[cfg.console] && PAGES[cfg.console].home;
        if (home && home !== active && navAllowed(home)) cfg.select(home, null);
      }
    },
    navAllowed: function (nav) { return navAllowed(nav); },
    setBadge: function (key, n) { badges[key] = Number(n) || 0; render(); },
    open: openDrawer,
    close: closeDrawer,
    toggle: toggle,
    /* Read by tests/appnav.test.mjs, and handy in the console. */
    map: MAP,
  };
})();

/* Times are picked in 30-minute steps everywhere — a post, a shoot, a site visit, a follow-up, a meeting:
   the picker offers :00 and :30, not every minute. Every time field on every admin page, including the
   ones drawn later (dialogs), unless a field sets its own step. A time already saved off the half hour
   (12:55) is shown as it is and is not changed until someone picks a new one. */
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  var SEL = 'input[type="time"], input[type="datetime-local"]';
  function step(root) {
    var list = root && root.matches && root.matches(SEL) ? [root] : (root && root.querySelectorAll ? root.querySelectorAll(SEL) : []);
    for (var i = 0; i < list.length; i++) if (!list[i].hasAttribute('step')) list[i].step = 1800;
  }
  function start() {
    step(document);
    new MutationObserver(function (muts) {
      for (var m = 0; m < muts.length; m++) {
        var added = muts[m].addedNodes;
        for (var n = 0; n < added.length; n++) if (added[n].nodeType === 1) step(added[n]);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

// ═══════ THEME FLIPS CLEANLY ═══════
// When the colour scheme changes (the system's, or the theme button's data-theme), every colour
// changes at once: transitions are held for that one frame. Without this, an element mid-transition
// could be left showing the old scheme's colour (dark text on a dark panel) — Chrome does not
// re-resolve light-dark() for a transition that was running when the scheme flipped.
(function () {
  var root = document.documentElement;
  var hold = function () {
    root.classList.add('scheme-flip');
    requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.remove('scheme-flip'); }); });
  };
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', hold); else if (mq.addListener) mq.addListener(hold);
  } catch (e) { /* no matchMedia: nothing to hold */ }
  try { new MutationObserver(hold).observe(root, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) {}
})();
