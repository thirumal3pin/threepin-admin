// ═══════ ADVANCED SEARCH PANEL ═══════
//
// The structured half of the search: pick values, get properties. The search
// box is for what an agent can say in one line; this is for a brief with
// several parts — "3 or 4 BHK, Anna Nagar or Adyar, ready to move, under 6
// crore" — where the OR/AND has to be visible rather than guessed.
//
// Two rules govern the whole panel, and they are the ones people get wrong
// when they build a filter drawer:
//
//   · Values INSIDE one filter are OR. Ticking 3 BHK and 4 BHK means either,
//     because no flat is both. Ticking Adyar and Mylapore means either.
//   · Filters are combined by the ALL/ANY switch at the top, ALL by default.
//     So BHK ∈ {3,4} AND locality ∈ {Adyar, Mylapore}.
//
// Amenities are the deliberate exception and carry their own All/Any switch,
// because "pool and gym" there really does mean both.
//
// Every filter, every option and every count comes from PinSearch.buildFacets
// over the live inventory — nothing here is hand-listed. A filter appears the
// day the sheet starts carrying that fact and disappears when it stops, and
// a count on a chip is the number of properties that chip will actually
// return (tests/property-search.test.mjs asserts exactly that, per chip).

(function (root) {
  'use strict';

  // Filters shown before the "More filters" fold. The rest are real but
  // rarely the first thing anyone reaches for, and a wall of twenty groups is
  // its own kind of unusable.
  const PRIMARY = ['bhk', 'type', 'status', 'priceBand', 'sqftBand', 'area', 'zone', 'corridor'];

  // Filters that also offer a typed min/max, because a band is not always the
  // shape of the question ("between 1.4 and 1.8 crore").
  const RANGES = [
    { field: 'price', label: 'Exact budget', unit: '₹', hint: 'e.g. 75L or 1.5cr', money: true },
    { field: 'sqft', label: 'Exact built-up area', unit: 'sqft', hint: 'e.g. 1518' },
    { field: 'uds', label: 'UDS', unit: 'sqft', hint: 'e.g. 1140' },
    { field: 'psf', label: 'Rate per sqft', unit: '₹', hint: 'e.g. 7000' }
  ];

  let facets = [];
  let gazetteer = null;
  const picked = Object.create(null);   // field → Set of values
  const ranges = Object.create(null);   // field → { min, max }
  let matchMode = 'all';
  let amenityMode = 'all';
  let includeUnknownNumbers = true;
  let onChange = () => { };
  const listFilters = Object.create(null); // field → the text typed in a searchable list

  const setOf = f => (picked[f] || (picked[f] = new Set()));
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ═══════ BUILD ═══════

  function build(properties, opts) {
    facets = root.PinSearch.buildFacets(properties);
    gazetteer = root.PinSearch.buildGazetteer(properties);
    if (opts && opts.onChange) onChange = opts.onChange;
    // A value that no longer exists in the inventory must not keep filtering
    // invisibly — a sheet sync can retire a locality or a builder overnight.
    for (const field of Object.keys(picked)) {
      const f = facets.find(x => x.field === field);
      if (!f) { picked[field].clear(); continue; }
      const live = new Set(f.options.map(o => String(o.value)));
      [...picked[field]].forEach(v => { if (!live.has(String(v))) picked[field].delete(v); });
    }
    render();
  }

  const getGazetteer = () => gazetteer;

  // ═══════ THE QUERY THIS PANEL PRODUCES ═══════

  function query() {
    const rules = [];
    for (const field of Object.keys(picked)) {
      const vals = [...picked[field]];
      if (!vals.length) continue;
      if (field === 'amenityTags') rules.push({ field, values: vals, mode: amenityMode });
      else rules.push({ field, values: vals });
    }
    for (const r of RANGES) {
      const v = ranges[r.field];
      if (!v || (v.min == null && v.max == null)) continue;
      rules.push({ field: r.field, min: v.min, max: v.max, includeUnknown: includeUnknownNumbers });
    }
    return rules.length ? { match: matchMode, rules } : null;
  }

  const isActive = () => !!query();

  // What the chip row under the search bar shows: one removable chip per
  // chosen value, so an active filter can never be invisible.
  function chips() {
    const out = [];
    for (const field of Object.keys(picked)) {
      const f = facets.find(x => x.field === field);
      for (const v of picked[field]) {
        const opt = f && f.options.find(o => String(o.value) === String(v));
        out.push({
          field, value: v,
          label: (f ? f.label + ': ' : '') + (opt ? opt.label : v)
        });
      }
    }
    for (const r of RANGES) {
      const v = ranges[r.field];
      if (!v || (v.min == null && v.max == null)) continue;
      const fmt = n => n == null ? '' : (r.money ? fmtMoney(n) : Math.round(n).toLocaleString('en-IN'));
      out.push({
        field: r.field, value: '__range__',
        label: `${r.label}: ${v.min != null ? fmt(v.min) : 'any'} – ${v.max != null ? fmt(v.max) : 'any'}`
      });
    }
    return out;
  }

  function fmtMoney(n) {
    const S = root.PinSearch;
    return n >= S.CR ? '₹' + (Math.round(n / S.CR * 100) / 100) + ' Cr'
      : n >= S.LAKH ? '₹' + (Math.round(n / S.LAKH * 100) / 100) + ' L'
        : '₹' + Math.round(n).toLocaleString('en-IN');
  }

  function removeChip(field, value) {
    if (value === '__range__') delete ranges[field];
    else if (picked[field]) picked[field].delete(value);
    render(); onChange();
  }

  function reset() {
    Object.keys(picked).forEach(k => picked[k].clear());
    Object.keys(ranges).forEach(k => delete ranges[k]);
    Object.keys(listFilters).forEach(k => delete listFilters[k]);
    matchMode = 'all'; amenityMode = 'all';
    render(); onChange();
  }

  // ═══════ INTERACTION ═══════

  function toggle(field, value) {
    const s = setOf(field);
    const v = String(value);
    if (s.has(v)) s.delete(v); else s.add(v);
    render(); onChange();
  }

  function setMatch(mode) { matchMode = mode; render(); onChange(); }
  function setAmenityMode(mode) { amenityMode = mode; render(); onChange(); }
  function setIncludeUnknown(on) { includeUnknownNumbers = !!on; render(); onChange(); }

  // The min/max boxes speak the same language as the search bar: "1.5cr",
  // "75L", "1,518" all land as the number meant.
  function setRange(field, which, raw) {
    const txt = String(raw == null ? '' : raw).trim();
    const cur = ranges[field] || (ranges[field] = { min: null, max: null });
    if (!txt) cur[which] = null;
    else {
      const m = root.PinSearch.readMagnitude(txt.toLowerCase().replace(/[,\s₹]/g, ''));
      cur[which] = m ? m.n : null;
    }
    if (cur.min == null && cur.max == null) delete ranges[field];
    onChange();
    renderChipsOnly();
    updateCount();
  }

  function filterList(field, text) { listFilters[field] = text; renderGroup(field); }

  // ═══════ RENDER ═══════

  function open() {
    const el = document.getElementById('advPanel');
    if (!el) return;
    render();
    const body = document.getElementById('advBody');
    if (body) body.scrollTop = 0;
    el.classList.add('open');
    document.body.classList.add('adv-open');
    const first = el.querySelector('.adv-list-search');
    if (first && window.matchMedia('(min-width: 900px)').matches) first.focus();
  }
  function close() {
    const el = document.getElementById('advPanel');
    if (el) el.classList.remove('open');
    document.body.classList.remove('adv-open');
  }
  function isOpen() {
    const el = document.getElementById('advPanel');
    return !!el && el.classList.contains('open');
  }

  function groupHtml(f) {
    const chosen = picked[f.field] || new Set();
    let inner = '';
    if (f.kind === 'search') {
      const typed = listFilters[f.field] || '';
      const needle = root.PinSearch.normText(typed);
      const opts = needle
        ? f.options.filter(o => root.PinSearch.normText(o.label).includes(needle))
        : f.options;
      inner = `
        <input class="adv-list-search" type="search" placeholder="Find a ${esc(f.label.toLowerCase())}…"
               value="${esc(typed)}" oninput="PinAdvanced.filterList('${esc(f.field)}', this.value)">
        <div class="adv-list">
          ${opts.length ? opts.slice(0, 200).map(o => optionHtml(f, o, chosen)).join('')
          : '<div class="adv-empty">Nothing matches that</div>'}
        </div>`;
    } else {
      inner = `<div class="adv-chips">${f.options.map(o => optionHtml(f, o, chosen)).join('')}</div>`;
    }
    const extra = f.field === 'amenityTags'
      ? `<div class="adv-mode">
           <span>Match</span>
           <button type="button" class="adv-mode-btn ${amenityMode === 'all' ? 'on' : ''}" onclick="PinAdvanced.setAmenityMode('all')">all of them</button>
           <button type="button" class="adv-mode-btn ${amenityMode === 'any' ? 'on' : ''}" onclick="PinAdvanced.setAmenityMode('any')">any of them</button>
         </div>` : '';
    const n = chosen.size;
    return `
      <div class="adv-group" data-field="${esc(f.field)}">
        <div class="adv-group-hd">
          <span class="adv-group-t">${esc(f.label)}</span>
          ${n ? `<span class="adv-group-n">${n} selected</span>
                 <button type="button" class="adv-group-clr" onclick="PinAdvanced.clearField('${esc(f.field)}')">clear</button>` : ''}
        </div>
        ${extra}
        ${inner}
      </div>`;
  }

  function optionHtml(f, o, chosen) {
    const on = chosen.has(String(o.value));
    return `<button type="button" class="adv-opt${on ? ' on' : ''}"
      onclick="PinAdvanced.toggle('${esc(f.field)}', ${JSON.stringify(String(o.value))})"
      aria-pressed="${on}"><span class="adv-opt-l">${esc(o.label)}</span><span class="adv-opt-n">${o.count}</span></button>`;
  }

  function rangeHtml(r) {
    const v = ranges[r.field] || {};
    const show = n => n == null ? '' : (r.money ? fmtMoney(n).replace('₹', '') : String(Math.round(n)));
    return `
      <div class="adv-range">
        <label>${esc(r.label)}</label>
        <div class="adv-range-row">
          <input type="text" inputmode="decimal" placeholder="min" value="${esc(show(v.min))}"
                 onchange="PinAdvanced.setRange('${esc(r.field)}','min',this.value)">
          <span class="adv-range-to">to</span>
          <input type="text" inputmode="decimal" placeholder="max" value="${esc(show(v.max))}"
                 onchange="PinAdvanced.setRange('${esc(r.field)}','max',this.value)">
          <span class="adv-range-u">${esc(r.unit)}</span>
        </div>
        <div class="adv-range-hint">${esc(r.hint)}</div>
      </div>`;
  }

  function clearField(field) { if (picked[field]) picked[field].clear(); render(); onChange(); }

  function render() {
    const body = document.getElementById('advBody');
    if (!body) return;
    const primary = PRIMARY.map(k => facets.find(f => f.field === k)).filter(Boolean);
    const rest = facets.filter(f => PRIMARY.indexOf(f.field) === -1);
    const moreCount = rest.reduce((n, f) => n + ((picked[f.field] || new Set()).size), 0);
    body.innerHTML = `
      <div class="adv-match">
        <span class="adv-match-l">A property must match</span>
        <button type="button" class="adv-match-btn ${matchMode === 'all' ? 'on' : ''}" onclick="PinAdvanced.setMatch('all')">ALL filters</button>
        <button type="button" class="adv-match-btn ${matchMode === 'any' ? 'on' : ''}" onclick="PinAdvanced.setMatch('any')">ANY filter</button>
        <span class="adv-match-note">Inside one filter, ticking several values means <b>any of them</b>.</span>
      </div>
      ${primary.map(groupHtml).join('')}
      <div class="adv-group">
        <div class="adv-group-hd"><span class="adv-group-t">Exact numbers</span></div>
        ${RANGES.map(rangeHtml).join('')}
        <label class="adv-inc">
          <input type="checkbox" ${includeUnknownNumbers ? 'checked' : ''}
                 onchange="PinAdvanced.setIncludeUnknown(this.checked)">
          Also show properties where that figure is not on file
        </label>
      </div>
      <details class="adv-more" ${moreCount ? 'open' : ''}>
        <summary>More filters${moreCount ? ` <span class="adv-group-n">${moreCount} selected</span>` : ''}</summary>
        ${rest.map(groupHtml).join('')}
      </details>`;
    renderChipsOnly();
    updateCount();
  }

  // Re-render one group in place, so typing in a list's search box does not
  // move the scroll position of the whole panel.
  function renderGroup(field) {
    const f = facets.find(x => x.field === field);
    const el = document.querySelector(`.adv-group[data-field="${CSS.escape(field)}"]`);
    if (!f || !el) return render();
    const wasFocused = document.activeElement && el.contains(document.activeElement);
    const caret = wasFocused ? document.activeElement.selectionStart : null;
    el.outerHTML = groupHtml(f);
    if (wasFocused) {
      const inp = document.querySelector(`.adv-group[data-field="${CSS.escape(field)}"] .adv-list-search`);
      if (inp) { inp.focus(); if (caret != null) try { inp.setSelectionRange(caret, caret); } catch (e) { /* not selectable */ } }
    }
  }

  function updateCount() {
    const el = document.getElementById('advCount');
    if (!el || !root.pinAllProperties) return;
    const q = query();
    const n = q ? root.PinSearch.search(root.pinAllProperties(), { advanced: q }).length : root.pinAllProperties().length;
    el.textContent = `${n} propert${n === 1 ? 'y' : 'ies'} match`;
    el.classList.toggle('none', n === 0);
  }

  function renderChipsOnly() {
    const row = document.getElementById('advChips');
    if (!row) return;
    const list = chips();
    row.innerHTML = list.length
      ? list.map(c => `<button type="button" class="advchip" onclick="PinAdvanced.removeChip('${esc(c.field)}', ${JSON.stringify(String(c.value))})">
           ${esc(c.label)}<span class="advchip-x">×</span></button>`).join('')
      + `<button type="button" class="advchip advchip-clr" onclick="PinAdvanced.reset()">Clear all filters</button>`
      : '';
    row.classList.toggle('show', list.length > 0);
    const btn = document.getElementById('advBtn');
    if (btn) {
      btn.classList.toggle('on', list.length > 0);
      const badge = document.getElementById('advBtnN');
      if (badge) { badge.textContent = list.length || ''; badge.style.display = list.length ? '' : 'none'; }
    }
  }

  root.PinAdvanced = {
    build, open, close, isOpen, query, isActive, chips, removeChip, reset,
    toggle, setMatch, setAmenityMode, setIncludeUnknown, setRange, filterList,
    clearField, render, renderChipsOnly, updateCount, getGazetteer
  };
})(window);
