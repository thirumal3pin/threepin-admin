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
      id: 'today', label: 'Daily task', icon: 'fa-regular fa-sun', page: 'crm', nav: 'today',
      note: 'Your visits and tasks for today',
    },
    {
      id: 'property', label: 'Properties', icon: 'fa-regular fa-building', page: 'property',
      note: 'The inventory, and everything that keeps it right',
      items: [
        { id: 'all', label: 'All properties', icon: 'fa-solid fa-list', page: 'property', nav: 'all' },
        { id: 'missing', label: 'Missing data', icon: 'fa-solid fa-triangle-exclamation', page: 'property', nav: 'missing', badge: 'missing' },
        { id: 'changes', label: 'Changes to apply', icon: 'fa-regular fa-clock', page: 'property', nav: 'changes' },
        { id: 'areamap', label: 'Area map', icon: 'fa-solid fa-map-location-dot', page: 'property', nav: 'areamap' },
        { id: 'sync', label: 'Sync from sheet', icon: 'fa-solid fa-rotate', page: 'property', nav: 'sync' },
      ],
    },
    {
      id: 'crm', label: 'CRM', icon: 'fa-regular fa-comments', page: 'crm',
      note: 'Leads, the board and what is owed a reply',
      items: [
        { id: 'kanban', label: 'Board', icon: 'fa-solid fa-table-columns', page: 'crm', nav: 'kanban' },
        { id: 'list', label: 'List', icon: 'fa-solid fa-bars', page: 'crm', nav: 'list' },
        { id: 'followups', label: 'Follow-ups', icon: 'fa-regular fa-calendar-check', page: 'crm', nav: 'followups', badge: 'followups' },
        { id: 'dashboard', label: 'Analytics', icon: 'fa-solid fa-chart-column', page: 'crm', nav: 'dashboard' },
      ],
    },
    {
      id: 'finance', label: 'Finance', icon: 'fa-solid fa-indian-rupee-sign', page: 'finance',
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
      id: 'track', label: 'Property & Media', icon: 'fa-solid fa-camera-retro', page: 'track',
      note: 'Listings from owner yes to brochure out, and the shoots between',
      items: [
        { id: 'board', label: 'Board', icon: 'fa-solid fa-table-columns', page: 'track', nav: 'board' },
        { id: 'shoots', label: 'Shoots', icon: 'fa-regular fa-calendar-check', page: 'track', nav: 'shoots' },
        { id: 'sellers', label: 'Sellers to list', icon: 'fa-solid fa-tag', page: 'track', nav: 'sellers', badge: 'sellers' },
      ],
    },
    {
      id: 'brochure', label: 'Create brochure', icon: 'fa-regular fa-file-lines', page: 'property', nav: 'brochure',
      note: 'New listing intake — Claude builds the brochure',
      apart: true,
    },
  ];

  // Where each console lives, and what a bare visit to it should open.
  var PAGES = {
    property: { href: 'dashboard.html', home: 'all' },
    crm: { href: 'crm.html', home: 'kanban' },
    finance: { href: '3pinfinance', home: 'overview' },
    track: { href: 'propertytrack.html', home: 'board' },
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
    var alert = item.badge === 'followups' || item.badge === 'missing' || item.badge === 'sellers';
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
    nav.innerHTML = MAP.map(sectionHtml).join('');
    var who = root.querySelector('.rail-who');
    who.textContent = cfg.user || '';
    who.style.display = cfg.user ? '' : 'none';
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

  window.AppNav = {
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
      return value;
    },

    setActive: setActive,
    setUser: function (email) { if (cfg) { cfg.user = email; render(); } },
    setBadge: function (key, n) { badges[key] = Number(n) || 0; render(); },
    open: openDrawer,
    close: closeDrawer,
    toggle: toggle,
    /* Read by tests/appnav.test.mjs, and handy in the console. */
    map: MAP,
  };
})();
