// ═══════ THE CRM, WIRED TO THE APP RAIL ═══════
//
// Board, List, Follow-ups, Analytics and Daily task are five panes of one
// page, so picking any of them is a display swap rather than a navigation.
// Daily task lives here rather than on its own page because everything it
// shows — today's visits, who to call, what was promised — is lead data that
// is already loaded and already kept live by this page's snapshot listener.

(function () {
  'use strict';

  window.AppNav.boot({
    console: 'crm',
    // A lead (or the bot editor) open over the page: picking a section from the menu closes it
    // first — else the section opened behind the panel and only showed after "All Leads".
    select: function (view) {
      var dp = document.getElementById('dp');
      if (dp && dp.classList.contains('open') && typeof closeDetail === 'function') closeDetail();
      var bot = document.getElementById('botEditorPanel');
      if (bot && bot.classList.contains('open') && typeof closeBotEditor === 'function') closeBotEditor();
      toggleView(view);
    },
    signOut: function () { crmLogout(); },
  });
  window.AppNav.setActive(typeof currentView === 'string' ? currentView : 'kanban');

  // A link from another console lands with ?nav=today (or ?nav=followups).
  // The leads arrive from Firestore a moment later and each pane re-renders
  // itself then, so opening immediately is safe and feels instant.
  var pending = window.AppNav.takeNav();
  if (pending) setTimeout(function () { toggleView(pending); }, 0);
})();
