// ═══════ TASKS — assigned work, its own page and a list on Daily task ═══════
//
// The rules (who assigns, who sees whose, who may change what, who is emailed) are not here: they
// are in shared-assets/task-model.js (window.PinTaskModel), which the database rules, the server's
// emails and the tests share. This file draws the Tasks page, the assign / edit form, and the
// "Tasks for you" list on Daily task, and saves through window.crmTasks (firebase-sync.js).
//
// A plain script, like today.js: it reads the CRM's globals (currentUserEmail, leads, teamRoster,
// agentName, escapeHtml, showToast, openDetail, loadInventory) when it runs, never at load.

(function () {
  'use strict';

  var tasks = [], loaded = false, loadError = null, cfg = null;
  var filt = { who: '', status: 'open', due: 'any', q: '' };
  var draft = null;            // the form's working copy: { id|null, ...fields }
  var linkKind = '';           // the form's link picker: '' | 'lead' | 'property'
  var pendingTask = null;      // ?task=ID from an email link, opened once the tasks are in
  try { pendingTask = new URLSearchParams(location.search).get('task'); } catch (e) {}

  var M = function () { return window.PinTaskModel; };
  var me = function () { return String(typeof currentUserEmail !== 'undefined' && currentUserEmail || '').toLowerCase(); };
  function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(s == null ? '' : s) : String(s == null ? '' : s); }
  function nameOf(email) { return email ? (typeof agentName === 'function' ? agentName(email) : String(email).split('@')[0]) : ''; }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function jsArg(v) { return esc(JSON.stringify(String(v))); }
  function isManager() { return !!M() && M().isManager(cfg, me()); }
  function rights(t) { return M() ? M().rightsFor(t, cfg, me()) : { view: false }; }
  function roster() {
    var set = {};
    (typeof teamRoster === 'function' ? teamRoster() : []).forEach(function (e) { set[e] = 1; });
    if (M()) M().managersOf(cfg).forEach(function (e) { set[e] = 1; });
    tasks.forEach(function (t) { M().assigneesOf(t).forEach(function (e) { set[e] = 1; }); });
    if (me()) set[me()] = 1;
    return Object.keys(set).sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
  }
  function fmtDue(due) {
    if (!due) return '';
    var d = new Date(due + 'T12:00:00');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function dueText(t) {
    var b = M().dueBucket(t);
    if (b === 'none') return t.status === 'done' ? '' : 'No due date';
    if (b === 'overdue') return 'Overdue · ' + fmtDue(t.due);
    if (b === 'today') return 'Due today';
    if (b === 'done') return t.due ? 'Was due ' + fmtDue(t.due) : '';
    return 'Due ' + fmtDue(t.due);
  }
  // A live update never redraws under the person's fingers: while they are typing in the search box
  // or holding a status list open, the page waits and redraws when they leave it.
  var stale = false;
  function busy() {
    var a = document.activeElement, host = document.getElementById('tasksView');
    return !!(a && host && host.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }
  document.addEventListener('focusout', function () {
    if (!stale) return;
    setTimeout(function () { if (stale && !busy()) { stale = false; redraw(); } }, 0);
  });
  function redraw() {
    if (typeof currentView === 'undefined') return;
    if (currentView === 'tasks') { if (busy()) { stale = true; return; } render(); }
    else if (currentView === 'today' && window.renderTodayView) window.renderTodayView();
  }
  // Midnight turns "due today" into "overdue": the badge and the page follow the clock, not only the data.
  var lastDay = new Date().toDateString();
  setInterval(function () {
    var d = new Date().toDateString();
    if (d === lastDay) return;
    lastDay = d; setBadge(); redraw();
  }, 5 * 60 * 1000);
  function setBadge() {
    if (!window.AppNav || !M()) return;
    var n = tasks.filter(function (t) { var b = M().dueBucket(t); return M().isAssignee(t, me()) && (b === 'overdue' || b === 'today'); }).length;
    window.AppNav.setBadge('tasks', n);
  }

  // ── Data in ──
  window.applyTasksSnapshot = function (list, mode, err, fromCache) {
    loadError = err || null;
    if (list) { tasks = list; loaded = true; }
    setBadge();
    redraw();
    if (draft && draft.id) {
      // The task open in the form changed elsewhere (or was deleted): keep the person's typing,
      // but say so when it is gone.
      if (!tasks.some(function (t) { return t.id === draft.id; })) { close(); toast('That task was deleted.'); }
    }
    // This device's saved copy can come first and not hold a task assigned a minute ago: an email's
    // link is given up on only once the server has answered.
    var found = pendingTask && tasks.some(function (t) { return t.id === pendingTask; });
    if (pendingTask && loaded && (found || !fromCache)) {
      var id = pendingTask; pendingTask = null;
      try { var u = new URL(location.href); u.searchParams.delete('task'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (e) {}
      if (tasks.some(function (t) { return t.id === id; })) {
        if (typeof toggleView === 'function' && currentView !== 'tasks') toggleView('tasks');
        open(id);
      } else toast('That task is not one you can see, or it was deleted.');
    }
  };
  window.applyTaskConfig = function (c) { cfg = c; setBadge(); redraw(); };

  // ── Which tasks the page shows ──
  // Everything this person may see (the database already sent only that): for most people their own
  // tasks, for a manager everyone's, for someone given another's tasks theirs too.
  function whoDefault() { return 'all'; }
  function shown() {
    var who = filt.who || whoDefault(), q = filt.q.trim().toLowerCase(), now = Date.now();
    return M().sortTasks(tasks.filter(function (t) {
      if (who === 'mine' && !M().isAssignee(t, me())) return false;
      if (who !== 'mine' && who !== 'all' && !M().isAssignee(t, who)) return false;
      if (filt.status === 'open' && t.status === 'done') return false;
      if (filt.status !== 'open' && filt.status !== 'all' && t.status !== filt.status) return false;
      var b = M().dueBucket(t, now);
      if (filt.due === 'overdue' && b !== 'overdue') return false;
      if (filt.due === 'today' && b !== 'today') return false;
      if (filt.due === 'week' && !(b === 'overdue' || b === 'today' || b === 'week')) return false;
      if (filt.due === 'none' && t.due) return false;
      if (q) {
        var hay = [t.title, t.description, t.link && t.link.label].concat(M().assigneesOf(t).map(nameOf)).join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }), now);
  }

  // ── The page ──
  function label(s) { return s === 'done' ? '✓ Completed' : (M().STATUS_LABEL[s] || ''); }
  function statusSelect(t, cls) {
    var r = rights(t);
    var opts = M().STATUSES.map(function (s) { return '<option value="' + s[0] + '"' + (t.status === s[0] ? ' selected' : '') + '>' + esc(label(s[0])) + '</option>'; }).join('');
    if (!r.edit) return '<span class="tsk-st s-' + esc(t.status) + '">' + esc(label(t.status)) + '</span>';
    return '<select class="tsk-st sel s-' + esc(t.status) + (cls ? ' ' + cls : '') + '" aria-label="Status of ' + esc(t.title) + '"'
      + ' onclick="event.stopPropagation()" onkeydown="event.stopPropagation()" onchange="PinTasks.setStatus(' + jsArg(t.id) + ', this.value)">' + opts + '</select>';
  }
  function peopleHtml(t) {
    var sec = (t.secondary || []).map(function (e) { return '<span class="tsk-p">' + esc(nameOf(e)) + '</span>'; }).join('');
    return '<span class="tsk-p main" title="Primary">' + esc(nameOf(t.primary)) + '</span>' + sec;
  }
  function linkChip(t) {
    if (!t.link || !t.link.id) return '';
    var icon = t.link.kind === 'lead' ? '👤' : '🏠';
    return '<button type="button" class="tsk-link" onclick="event.stopPropagation(); PinTasks.openLink(' + jsArg(t.id) + ')" title="Open the ' + (t.link.kind === 'lead' ? 'lead' : 'property') + '">'
      + icon + ' ' + esc(t.link.label || t.link.id) + '</button>';
  }
  function rowHtml(t) {
    var b = M().dueBucket(t);
    var desc = String(t.description || '').trim().split('\n')[0];
    return '<article class="tsk-row b-' + b + ' s-' + esc(t.status) + '" role="button" tabindex="0" onclick="PinTasks.open(' + jsArg(t.id) + ')"'
      + ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();PinTasks.open(' + jsArg(t.id) + ');}">'
      + '<div class="tsk-main">'
      + '<div class="tsk-t">' + esc(t.title) + '</div>'
      + (desc ? '<div class="tsk-d">' + esc(desc) + '</div>' : '')
      + '<div class="tsk-tags">' + peopleHtml(t) + linkChip(t) + '</div>'
      + '</div>'
      + '<div class="tsk-side">'
      + (dueText(t) ? '<span class="tsk-due b-' + b + '">' + esc(dueText(t)) + '</span>' : '')
      + statusSelect(t)
      + '</div>'
      + '</article>';
  }
  function counts() {
    var c = { overdue: 0, today: 0, doing: 0, done7: 0 }, now = Date.now(), who = filt.who || whoDefault();
    tasks.forEach(function (t) {
      if (who === 'mine' && !M().isAssignee(t, me())) return;
      if (who !== 'mine' && who !== 'all' && !M().isAssignee(t, who)) return;
      var b = M().dueBucket(t, now);
      if (b === 'overdue') c.overdue++;
      if (b === 'today') c.today++;
      if (t.status === 'doing') c.doing++;
      if (t.status === 'done' && (t.completedAt || 0) > now - 7 * 86400000) c.done7++;
    });
    return c;
  }
  function stat(key, n, label, f) {
    var on = (f.due && filt.due === f.due && filt.status === (f.status || 'open')) || (f.status && !f.due && filt.status === f.status && filt.due === 'any');
    return '<button type="button" class="tsk-stat k-' + key + (n ? ' has' : '') + (on ? ' on' : '') + '" aria-pressed="' + on + '" onclick="PinTasks.quick(' + jsArg(key) + ')">'
      + '<b>' + n + '</b><span>' + esc(label) + '</span></button>';
  }
  function render() {
    var host = document.getElementById('tasksView');
    if (!host || !M()) return;
    var mgr = isManager(), list = loaded ? shown() : [], c = counts();
    var who = filt.who || whoDefault();
    var people = mgr ? roster() : [me()].concat(M().canViewPeople(cfg, me()));
    var whoOpts = '<option value="mine"' + (who === 'mine' ? ' selected' : '') + '>Assigned to me</option>'
      + (mgr || people.length > 1 ? '<option value="all"' + (who === 'all' ? ' selected' : '') + '>' + (mgr ? 'Everyone' : 'Everyone I can see') + '</option>' : '')
      + people.filter(function (e) { return e !== me(); }).map(function (e) {
        return '<option value="' + esc(e) + '"' + (who === e ? ' selected' : '') + '>' + esc(nameOf(e)) + '</option>';
      }).join('');
    var stOpts = [['open', 'Open'], ['todo', 'Yet to start'], ['doing', 'In Progress'], ['done', 'Completed'], ['all', 'All']];
    var dueOpts = [['any', 'Any date'], ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due this week'], ['none', 'No due date']];
    var sub = mgr ? 'Assign work to the team and follow it to done. You see every task.'
      : 'The work assigned to you' + (people.length > 1 ? ', and the people you have been given to see' : '') + '.';
    var empty = !loaded ? (loadError ? 'Tasks could not be loaded. Check your connection and reload.' : 'Loading tasks…')
      : tasks.length ? 'No task matches these filters.' : (mgr ? 'No tasks yet. Assign the first one.' : 'Nothing assigned to you yet.');
    host.innerHTML = '<div class="tsk-wrap">'
      + '<header class="tsk-head"><div class="tsk-hl">'
      + '<h1 class="tsk-title">Tasks</h1><p class="tsk-sub">' + esc(sub) + '</p></div>'
      + '<div class="tsk-hacts">'
      + (mgr ? '<a class="tsk-btn ghost" href="propertytrack.html?nav=settings#cfTasks" title="Who assigns, and who sees whose tasks">Who sees what</a>' : '')
      + (mgr ? '<button type="button" class="tsk-btn primary" onclick="PinTasks.create()">+ Assign task</button>' : '')
      + '</div></header>'
      + '<div class="tsk-stats" role="group" aria-label="At a glance">'
      + stat('overdue', c.overdue, 'Overdue', { due: 'overdue' })
      + stat('today', c.today, 'Due today', { due: 'today' })
      + stat('doing', c.doing, 'In progress', { status: 'doing' })
      + stat('done', c.done7, 'Completed this week', { status: 'done' })
      + '</div>'
      + '<div class="tsk-filters">'
      + '<label class="tsk-f"><span>Person</span><select onchange="PinTasks.filter(\'who\', this.value)">' + whoOpts + '</select></label>'
      + '<label class="tsk-f"><span>Status</span><select onchange="PinTasks.filter(\'status\', this.value)">'
      + stOpts.map(function (o) { return '<option value="' + o[0] + '"' + (filt.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>'
      + '<label class="tsk-f"><span>Due</span><select onchange="PinTasks.filter(\'due\', this.value)">'
      + dueOpts.map(function (o) { return '<option value="' + o[0] + '"' + (filt.due === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>'
      + '<label class="tsk-f grow"><span>Search</span><input type="search" value="' + esc(filt.q) + '" placeholder="Title, person, lead or property" oninput="PinTasks.filter(\'q\', this.value)"></label>'
      + '</div>'
      + '<div class="tsk-count">' + (loaded ? list.length + (list.length === 1 ? ' task' : ' tasks') : '') + '</div>'
      + '<div class="tsk-list">' + (list.length ? list.map(rowHtml).join('') : '<p class="tsk-empty">' + esc(empty) + '</p>') + '</div>'
      + '</div>';
  }

  // ── The form ──
  function modalEl() {
    var el = document.getElementById('taskModal');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'taskModal';
    el.innerHTML = '<div class="modal-box tsk-box" role="dialog" aria-modal="true" aria-labelledby="tkmTitle">'
      + '<div class="modal-hdr"><div class="modal-title" id="tkmTitle">Assign task</div><button type="button" class="modal-x" aria-label="Close" onclick="PinTasks.close()">×</button></div>'
      + '<div class="modal-body" id="tkmBody"></div>'
      + '<div class="modal-ftr" id="tkmFtr"></div></div>';
    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    document.body.appendChild(el);
    return el;
  }
  function formHtml() {
    var t = draft, isNew = !t.id, existing = isNew ? null : tasks.find(function (x) { return x.id === t.id; });
    var r = isNew ? { edit: true, reassign: true, remove: false } : rights(existing);
    var dis = r.edit ? '' : ' disabled', disPeople = r.reassign ? '' : ' disabled';
    var people = roster();
    var segs = M().STATUSES.map(function (s) {
      return '<button type="button" class="tsk-seg-b s-' + s[0] + (t.status === s[0] ? ' on' : '') + '" aria-pressed="' + (t.status === s[0]) + '"' + dis
        + ' onclick="PinTasks.field(\'status\', ' + jsArg(s[0]) + ')">' + esc(label(s[0])) + '</button>';
    }).join('');
    var prim = '<option value="">Choose a person…</option>' + people.map(function (e) {
      return '<option value="' + esc(e) + '"' + (t.primary === e ? ' selected' : '') + '>' + esc(nameOf(e)) + '</option>';
    }).join('');
    var secs = people.filter(function (e) { return e !== t.primary; }).map(function (e) {
      var on = (t.secondary || []).indexOf(e) >= 0;
      return '<button type="button" class="tsk-chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '"' + disPeople
        + ' onclick="PinTasks.toggleSecondary(' + jsArg(e) + ')">' + (on ? '✓ ' : '') + esc(nameOf(e)) + '</button>';
    }).join('');
    var link = t.link && t.link.id
      ? '<div class="tsk-linked"><span>' + (t.link.kind === 'lead' ? '👤 Lead' : '🏠 Property') + ' · <b>' + esc(t.link.label || t.link.id) + '</b></span>'
        + (r.edit ? '<button type="button" class="tsk-x" onclick="PinTasks.unlink()" aria-label="Remove the link">×</button>' : '') + '</div>'
      : (r.edit ? '<div class="tsk-seg sm" role="group" aria-label="Link to">'
          + [['', 'Nothing'], ['lead', 'A lead'], ['property', 'A property']].map(function (o) {
            return '<button type="button" class="tsk-seg-b' + (linkKind === o[0] ? ' on' : '') + '" aria-pressed="' + (linkKind === o[0]) + '" onclick="PinTasks.linkKind(' + jsArg(o[0]) + ')">' + o[1] + '</button>';
          }).join('') + '</div>'
          + (linkKind ? '<input type="search" id="tkmLinkQ" class="tsk-linkq" placeholder="' + (linkKind === 'lead' ? 'Type a name or phone' : 'Type a code, name or area') + '" oninput="PinTasks.linkSearch(this.value)" autocomplete="off">'
            + '<div class="tsk-linkres" id="tkmLinkRes"></div>' : '')
        : '<div class="tsk-none">Not linked</div>');
    var hist = !isNew && existing && (existing.history || []).length
      ? '<details class="tsk-hist"><summary>Activity (' + existing.history.length + ')</summary><ol>'
        + existing.history.slice().reverse().map(function (h) {
          return '<li><b>' + esc(nameOf(h.by) || 'Someone') + '</b> ' + esc(h.text) + ' <time>' + esc(new Date(h.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })) + '</time></li>';
        }).join('') + '</ol></details>'
      : '';
    var note = !r.edit ? '<p class="tsk-ro">You can see this task. Only the people it is assigned to, and ' + esc(M().managersOf(cfg).map(nameOf).join(' and ')) + ', can change it.</p>'
      : !r.reassign && !isNew ? '<p class="tsk-ro">Who it is assigned to is set by ' + esc(M().managersOf(cfg).map(nameOf).join(' and ')) + '.</p>' : '';
    return note
      + '<div class="field"><label for="tkmT">Title *</label><input type="text" id="tkmT" maxlength="' + M().MAX_TITLE + '" value="' + esc(t.title) + '"' + dis + ' oninput="PinTasks.field(\'title\', this.value, true)" placeholder="What needs doing"></div>'
      + '<div class="field"><label for="tkmD">Description</label><textarea id="tkmD" rows="4"' + dis + ' oninput="PinTasks.field(\'description\', this.value, true)" placeholder="Details, numbers, what done looks like">' + esc(t.description) + '</textarea></div>'
      + '<div class="field"><label>Status</label><div class="tsk-seg" role="group" aria-label="Status">' + segs + '</div></div>'
      + '<div class="field-row"><div class="field"><label for="tkmDue">Due date</label><input type="date" id="tkmDue" value="' + esc(t.due) + '"' + dis + ' onchange="PinTasks.field(\'due\', this.value, true)"></div>'
      + '<div class="field"><label for="tkmP">Assigned to *</label><select id="tkmP"' + disPeople + ' onchange="PinTasks.field(\'primary\', this.value)">' + prim + '</select></div></div>'
      + '<div class="field"><label>Also assigned to <span class="tsk-opt">optional</span></label><div class="tsk-chips">' + (secs || '<span class="tsk-none">No one else on the team yet.</span>') + '</div></div>'
      + '<div class="field"><label>Linked to <span class="tsk-opt">optional</span></label>' + link + '</div>'
      + hist
      + '<div class="modal-err" id="tkmErr"></div>';
  }
  function ftrHtml() {
    var isNew = !draft.id, existing = isNew ? null : tasks.find(function (x) { return x.id === draft.id; });
    var r = isNew ? { edit: true, remove: false } : rights(existing);
    return (r.remove ? '<button type="button" class="tsk-del" onclick="PinTasks.remove()">Delete</button>' : '')
      + '<span class="tsk-sp"></span>'
      + '<button type="button" class="modal-cancel" onclick="PinTasks.close()">' + (r.edit ? 'Cancel' : 'Close') + '</button>'
      + (r.edit ? '<button type="button" class="modal-save" id="tkmSave" onclick="PinTasks.save()">' + (isNew ? 'Assign' : 'Save') + '</button>' : '');
  }
  function drawForm() {
    var el = modalEl();
    document.getElementById('tkmTitle').textContent = draft.id ? 'Task' : 'Assign task';
    document.getElementById('tkmBody').innerHTML = formHtml();
    document.getElementById('tkmFtr').innerHTML = ftrHtml();
    if (!el.classList.contains('open')) {
      el.classList.add('open');
      setTimeout(function () { var f = document.getElementById(draft.id ? 'tkmD' : 'tkmT'); if (f && !f.disabled) f.focus(); }, 60);
    }
  }
  function open(id) {
    var t = tasks.find(function (x) { return x.id === id; });
    if (!t) return;
    draft = { id: t.id, title: t.title || '', description: t.description || '', status: t.status || 'todo', due: t.due || '',
      primary: (t.primary || '').toLowerCase(), secondary: (t.secondary || []).map(function (e) { return String(e).toLowerCase(); }), link: t.link || null };
    // What the form opened with: a save writes only what this person changed, so an edit someone
    // else made meanwhile (a status, a date) is not put back.
    draft.base = JSON.parse(JSON.stringify(draft));
    linkKind = '';
    drawForm();
  }
  function create(preset) {
    if (!isManager()) { toast('Only ' + M().managersOf(cfg).map(nameOf).join(' and ') + ' can assign tasks.'); return; }
    draft = Object.assign({ id: null, title: '', description: '', status: 'todo', due: '', primary: '', secondary: [], link: null }, preset || {});
    linkKind = '';
    drawForm();
  }
  function close() {
    var el = document.getElementById('taskModal');
    if (el) el.classList.remove('open');
    draft = null; linkKind = '';
  }
  function showErr(list) {
    var e = document.getElementById('tkmErr');
    if (!e) return;
    e.textContent = (list || []).join(' ');
    e.classList.toggle('show', !!(list && list.length));
  }

  // ── Saving ──
  function newId() { return 'tsk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function tenant() { return window.crmTasks && window.crmTasks.tenantId ? window.crmTasks.tenantId() : null; }
  function notifyResult(r, what) {
    if (r && r.ok && r.sent) return what + ' · ' + r.sent + (r.sent === 1 ? ' email sent' : ' emails sent');
    if (r && r.ok) return what;
    return what + ' · the email could not be sent';
  }
  async function saveNew(d) {
    var now = Date.now(), T = M();
    var doc = {
      id: newId(), title: d.title.trim(), description: d.description.trim(), status: d.status, due: d.due || '',
      primary: d.primary, secondary: d.secondary.slice(), link: d.link || null,
      createdAt: now, createdBy: me(), updatedAt: now, updatedBy: me(), statusAt: now, completedAt: d.status === 'done' ? now : null
    };
    doc.assignees = T.assigneesOf(doc);
    doc.visibleTo = T.visibleToFor(doc, cfg, tenant());
    doc.history = [T.historyEntry(me(), 'assigned it to ' + doc.assignees.map(nameOf).join(', '), now)];
    await window.crmTasks.create(doc);
    close();
    toast('Task assigned to ' + nameOf(doc.primary) + '…');
    var r = await window.crmTasks.notify(doc.id, 'assigned', { added: doc.assignees });
    toast(notifyResult(r, 'Task assigned to ' + nameOf(doc.primary)));
  }
  async function saveEdit(d, opts) {
    var T = M(), before = tasks.find(function (x) { return x.id === d.id; });
    if (!before) { close(); return; }
    var r = rights(before), now = Date.now();
    // Only the fields this person changed in the form (all of them for a quick status change).
    var base = d.base || {};
    var touched = function (k) { return !d.base || JSON.stringify(d[k] == null ? null : d[k]) !== JSON.stringify(base[k] == null ? null : base[k]); };
    var after = Object.assign({}, before);
    if (touched('title')) after.title = d.title.trim();
    if (touched('description')) after.description = d.description.trim();
    if (touched('status')) after.status = d.status;
    if (touched('due')) after.due = d.due || '';
    if (touched('link')) after.link = d.link || null;
    if (r.reassign && touched('primary')) after.primary = d.primary;
    if (r.reassign && touched('secondary')) after.secondary = d.secondary.slice();
    var changes = T.changesBetween(before, after, nameOf);
    if (!changes.length) { if (!opts || !opts.quiet) close(); return; }
    var patch = { title: after.title || '', description: after.description || '', due: after.due || '', link: after.link || null, updatedAt: now, updatedBy: me() };
    if (before.status !== after.status) {
      patch.status = after.status; patch.statusAt = now;
      patch.completedAt = after.status === 'done' ? now : null;
    }
    var added = [];
    if (r.reassign && (touched('primary') || touched('secondary'))) {
      var was = T.assigneesOf(before);
      patch.primary = after.primary; patch.secondary = after.secondary;
      patch.assignees = T.assigneesOf(after);
      patch.visibleTo = T.visibleToFor(after, cfg, tenant());
      added = patch.assignees.filter(function (e) { return was.indexOf(e) < 0; });
    }
    patch.history = T.withHistory(before.history, T.historyEntry(me(), changes.join(', '), now));
    // Only what changed goes in the write (the rules check which fields a non-manager touches).
    ['title', 'description', 'due'].forEach(function (k) { if ((before[k] || '') === (patch[k] || '')) delete patch[k]; });
    if (JSON.stringify(before.link || null) === JSON.stringify(patch.link || null)) delete patch.link;
    await window.crmTasks.update(d.id, patch);
    if (!opts || !opts.quiet) close();
    var msg = before.status !== after.status ? '“' + after.title + '” → ' + T.STATUS_LABEL[after.status] : 'Task saved';
    toast(msg);
    var results = [];
    if (added.length) results.push(await window.crmTasks.notify(d.id, 'assigned', { added: added }));
    if (before.status !== after.status) results.push(await window.crmTasks.notify(d.id, 'status', { from: before.status }));
    if (results.length) {
      var sent = results.reduce(function (n, x) { return n + (x && x.sent || 0); }, 0), bad = results.some(function (x) { return !x || !x.ok; });
      toast(notifyResult({ ok: !bad, sent: sent }, msg));
    }
  }
  async function save() {
    if (!draft) return;
    var probs = M().problemsWith(draft);
    if (probs.length) { showErr(probs); return; }
    var btn = document.getElementById('tkmSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      if (draft.id) await saveEdit(draft); else await saveNew(draft);
    } catch (e) {
      console.error('Task save failed:', e);
      showErr([e && e.code === 'permission-denied' ? 'You are not allowed to make that change.' : 'Could not save — check your connection and try again.']);
      if (btn) { btn.disabled = false; btn.textContent = draft && draft.id ? 'Save' : 'Assign'; }
    }
  }
  async function setStatus(id, status) {
    var t = tasks.find(function (x) { return x.id === id; });
    if (!t || t.status === status) return;
    try {
      await saveEdit({ id: id, title: t.title || '', description: t.description || '', status: status, due: t.due || '',
        primary: t.primary, secondary: t.secondary || [], link: t.link || null }, { quiet: true });
    } catch (e) {
      console.error('Task status change failed:', e);
      toast(e && e.code === 'permission-denied' ? 'You are not allowed to change that task.' : 'Could not change the status — check your connection.');
      redraw();
    }
  }
  async function remove() {
    if (!draft || !draft.id) return;
    var t = tasks.find(function (x) { return x.id === draft.id; });
    if (!t || !confirm('Delete “' + t.title + '”? This cannot be undone.')) return;
    try { await window.crmTasks.remove(t.id); close(); toast('Task deleted'); }
    catch (e) { showErr(['Could not delete — check your connection and try again.']); }
  }

  // ── The link picker ──
  function linkSearch(qRaw) {
    var host = document.getElementById('tkmLinkRes');
    if (!host) return;
    var q = String(qRaw || '').trim().toLowerCase();
    if (!q) { host.innerHTML = ''; return; }
    if (linkKind === 'lead') {
      var all = typeof leads !== 'undefined' && Array.isArray(leads) ? leads : [];
      var digits = q.replace(/\D/g, '');
      var hits = all.filter(function (l) {
        return String(l.name || '').toLowerCase().indexOf(q) >= 0 || (digits.length >= 3 && String(l.phone || '').replace(/\D/g, '').indexOf(digits) >= 0);
      }).slice(0, 8);
      host.innerHTML = hits.length ? hits.map(function (l) {
        return '<button type="button" class="tsk-res" onclick="PinTasks.pick(\'lead\', ' + jsArg(l.id) + ')"><b>' + esc(l.name || 'Unnamed lead') + '</b><small>' + esc([l.phone, l.propertyInterest].filter(Boolean).join(' · ')) + '</small></button>';
      }).join('') : '<div class="tsk-none">No lead matches.</div>';
    } else if (linkKind === 'property') {
      host.innerHTML = '<div class="tsk-none">Searching…</div>';
      Promise.resolve(typeof loadInventory === 'function' ? loadInventory() : []).then(function (inv) {
        var cur = document.getElementById('tkmLinkQ');
        if (!cur || cur.value.trim().toLowerCase() !== q) return;
        var hits = (inv || []).filter(function (p) {
          return [p.propertyCode, p.id, p.name, p.location].join(' ').toLowerCase().indexOf(q) >= 0;
        }).slice(0, 8);
        host.innerHTML = hits.length ? hits.map(function (p) {
          return '<button type="button" class="tsk-res" onclick="PinTasks.pick(\'property\', ' + jsArg(p.id) + ')"><b>' + esc([p.propertyCode, p.name].filter(Boolean).join(' · ') || p.id) + '</b><small>' + esc(p.location || '') + '</small></button>';
        }).join('') : '<div class="tsk-none">No property matches.</div>';
      });
    }
  }
  function pick(kind, id) {
    if (!draft) return;
    if (kind === 'lead') {
      var l = (typeof leads !== 'undefined' ? leads : []).find(function (x) { return x.id === id; });
      draft.link = { kind: 'lead', id: id, label: (l && l.name) || 'Lead' };
    } else {
      var inv = (typeof inventory !== 'undefined' && inventory) || [];
      var p = inv.find(function (x) { return x.id === id; });
      draft.link = { kind: 'property', id: id, label: p ? [p.propertyCode, p.name].filter(Boolean).join(' · ') : id };
    }
    linkKind = '';
    drawForm();
  }
  function openLink(taskId) {
    var t = tasks.find(function (x) { return x.id === taskId; }) || (draft && draft.id === taskId ? draft : null);
    var link = t && t.link;
    if (!link) return;
    if (link.kind === 'lead') {
      var exists = (typeof leads !== 'undefined' ? leads : []).some(function (l) { return l.id === link.id; });
      if (!exists) { toast('That lead is not in the CRM any more.'); return; }
      close();
      if (typeof openDetail === 'function') openDetail(link.id);
    } else window.open('dashboard.html?property=' + encodeURIComponent(link.id), '_blank', 'noopener');
  }

  // ── Daily task ──
  // My open tasks: late, due by the end of the span shown, or with no date (still mine to do).
  function todayItems(spanEnd) {
    if (!M()) return [];
    return M().sortTasks(tasks.filter(function (t) {
      if (!M().isAssignee(t, me()) || t.status === 'done') return false;
      if (!t.due) return true;
      return t.due <= M().istDay(spanEnd) || M().dueBucket(t) === 'overdue';
    })).map(function (t) { return { kind: 'task', task: t, at: M().dueAtOf(t.due) || Infinity, mine: true, overdue: M().dueBucket(t) === 'overdue' }; });
  }
  function todayRowHtml(t) {
    var b = M().dueBucket(t), others = M().assigneesOf(t).filter(function (e) { return e !== me(); });
    return '<div class="td-row tsk-today b-' + b + '">'
      + '<div class="tsk-trow" role="button" tabindex="0" onclick="PinTasks.open(' + jsArg(t.id) + ')" onkeydown="if(event.key===\'Enter\'){PinTasks.open(' + jsArg(t.id) + ');}">'
      + '<div class="tsk-main"><div class="tsk-t">' + esc(t.title) + '</div>'
      + '<div class="tsk-d">' + esc([dueText(t), others.length ? 'with ' + others.map(nameOf).join(', ') : '', t.createdBy && t.createdBy !== me() ? 'from ' + nameOf(t.createdBy) : ''].filter(Boolean).join(' · ')) + '</div>'
      + (t.link ? '<div class="tsk-tags">' + linkChip(t) + '</div>' : '') + '</div>'
      + '<div class="tsk-side">' + statusSelect(t) + '</div>'
      + '</div></div>';
  }

  window.renderTasksView = render;
  window.PinTasks = {
    open: open, create: create, close: close, save: save, remove: remove, setStatus: setStatus,
    todayItems: todayItems, todayRowHtml: todayRowHtml, openLink: openLink,
    tasks: function () { return tasks; }, config: function () { return cfg; },
    filter: function (k, v) {
      filt[k] = v;
      if (k === 'q') {
        // Keep the caret in the search box while the list redraws under it.
        render();
        var inp = document.querySelector('#tasksView .tsk-f.grow input');
        if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      } else render();
    },
    quick: function (key) {
      var map = { overdue: { due: 'overdue', status: 'open' }, today: { due: 'today', status: 'open' }, doing: { due: 'any', status: 'doing' }, done: { due: 'any', status: 'done' } };
      var m = map[key];
      var on = filt.due === m.due && filt.status === m.status;
      filt.due = on ? 'any' : m.due; filt.status = on ? 'open' : m.status;
      render();
    },
    field: function (k, v, typing) {
      if (!draft) return;
      draft[k] = k === 'primary' ? String(v || '').toLowerCase() : v;
      if (k === 'primary') draft.secondary = (draft.secondary || []).filter(function (e) { return e !== draft.primary; });
      showErr([]);
      if (!typing) drawForm();
    },
    toggleSecondary: function (e) {
      if (!draft) return;
      var i = draft.secondary.indexOf(e);
      if (i >= 0) draft.secondary.splice(i, 1); else draft.secondary.push(e);
      drawForm();
    },
    linkKind: function (k) {
      linkKind = k; drawForm();
      setTimeout(function () { var q = document.getElementById('tkmLinkQ'); if (q) q.focus(); }, 30);
    },
    linkSearch: linkSearch, pick: pick,
    unlink: function () { if (draft) { draft.link = null; drawForm(); } }
  };
})();
