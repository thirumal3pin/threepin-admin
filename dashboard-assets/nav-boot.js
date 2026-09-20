// ═══════ THE PROPERTY CONSOLE, WIRED TO THE APP RAIL ═══════
//
// The rail owns the menu; this file owns what each entry does on this page.
// Nothing here reloads: All properties, Missing data and Changes are panels
// this page already has, so picking one is a class toggle, not a navigation.
//
// Sync and Create brochure are modals rather than pages. They open over
// whatever you were reading and leave it highlighted in the rail, because
// that is still where you are — a dialog is not somewhere you went.

(function () {
  'use strict';

  var panel = 'all';   // the page underneath: all | missing | changes

  function showAll() {
    if (typeof closeMissing === 'function') closeMissing();
    if (typeof closeChanges === 'function') closeChanges();
    if (typeof closeDetail === 'function') closeDetail();
  }

  function select(nav) {
    switch (nav) {
      case 'missing': showAll(); if (typeof openMissing === 'function') openMissing(); panel = 'missing'; break;
      case 'changes': showAll(); if (typeof openChanges === 'function') openChanges(); panel = 'changes'; break;
      case 'sync': if (typeof openSyncModal === 'function') openSyncModal(); break;
      case 'brochure': if (typeof openBrochureModal === 'function') openBrochureModal(); break;
      default: showAll(); panel = 'all';
    }
    // Said last, and said here, because showAll() closes whichever panel was
    // up and each close puts the rail back on All properties on its way past.
    // Sync and Create brochure never touch `panel`, so a dialog leaves the
    // highlight on the page it opened over — which is still where you are.
    window.AppNav.setActive(panel);
  }

  window.AppNav.boot({ console: 'property', select: select, signOut: function () { window.pinAuth.logout(); } });
  window.AppNav.setActive('all');

  // Closing a panel from its own back button has to move the rail too,
  // otherwise the highlight claims you are still inside it.
  ['closeMissing', 'closeChanges'].forEach(function (fn) {
    var original = window[fn];
    if (typeof original !== 'function') return;
    window[fn] = function () {
      var out = original.apply(this, arguments);
      panel = 'all';
      window.AppNav.setActive('all');
      return out;
    };
  });

  var authChange = window.onDashboardAuthChange;
  window.onDashboardAuthChange = function (user) {
    window.AppNav.setUser(user && user.email ? user.email : '');
    return authChange.apply(this, arguments);
  };

  // A link from another console lands with ?nav=, which is how Create
  // brochure works from Finance or the CRM. Opening straight away is safe:
  // applyPropertiesSnapshot re-renders the Missing panel when the real
  // inventory lands, so an early open fills in rather than going stale.
  var pending = window.AppNav.takeNav();
  if (pending) setTimeout(function () { select(pending); }, 0);
})();
