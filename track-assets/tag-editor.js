// ═══════ THE TAG PICKER — chips you can remove, and a box that suggests or creates ═══════
//
// One picker for the whole page, so tags behave the same on a listing and in the Posting tab.
// A picker edits a TARGET:
//   'l:<listingId>'  a listing on the board — the property's own tags (x.tags). A Posting row of
//                    the same property shows and edits these too, so a property has one set.
//   'p:<trackerId>'  a Posting row with no listing behind it (only a plan reference, say).
//
// Typing suggests from every tag in use (tags.js); Enter takes the first suggestion, or creates
// what was typed. Saving goes through the board's mutate (history, caches, Media ready) or the
// Posting tab's own save, and the picker comes back focused so several can be added in a row.

import * as TG from './tags.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsq = v => esc(JSON.stringify(String(v == null ? '' : v)));
const api = () => window.trackApi;
const listing = id => ((api() && api().listings()) || []).find(l => l.id === id) || null;

// Every tag in use, on listings and on Posting rows of their own.
window.tagCatalog = () => TG.catalog(
  ...((api() && api().listings()) || []).map(l => l.tags),
  ...((window.pgOwnTagLists && window.pgOwnTagLists()) || [])
);

function tagsOfTarget(target) {
  const [kind, id] = [target.slice(0, 1), target.slice(2)];
  if (kind === 'l') return TG.cleanTags((listing(id) || {}).tags);
  return TG.cleanTags(window.pgOwnTags ? window.pgOwnTags(id) : []);
}

// Where the picker that was used sits (a Sheet row, a Properties block, a dialog, the listing), so
// focus goes back to that one — a repost shares its original's tags, and its picker is not the first.
const HOME = '[id^="pg-"], [id^="pf-"], #pgModal, #dpBody';
const homeOf = el => { const h = el && el.closest && el.closest(HOME); return h ? (h.id || '') : ''; };
function redrawPickers(target, typing, home) {
  const now = tagsOfTarget(target);
  const mine = () => [...document.querySelectorAll('.tg')].filter(e => e.dataset.tg === target);
  for (const el of mine()) {
    const shown = [...el.querySelectorAll('.tg-t')].map(e => e.textContent);
    if (JSON.stringify(shown) !== JSON.stringify(now)) el.outerHTML = window.tagEditorHtml(target, now, { small: el.classList.contains('sm'), lazy: el.classList.contains('lazy') });
  }
  const all = mine();
  const homeEl = home && document.getElementById(home);
  const box = (homeEl && all.find(e => homeEl.contains(e))) || all.find(e => e.closest('#pgModal.open, #dp.open')) || all[0];
  const input = box && box.querySelector('.tg-in');
  if (input) { if (document.activeElement !== input) input.focus(); }
  // Added from a "+ Tag" box that the redraw folded back: open it again for the next one.
  else if (typing && box && box.classList.contains('lazy')) window.tagExpand(box.querySelector('.tg-plus'));
}

function save(target, next, what, typing, home) {
  const [kind, id] = [target.slice(0, 1), target.slice(2)];
  if (kind === 'l') {
    if (!api() || !listing(id)) return;
    api().mutate(id, x => { x.tags = next; }, what);
    if (api().currentDetailId() === id) api().openDetail(id);
    if (window.pgRedraw) window.pgRedraw();
  } else if (window.pgSetTags) window.pgSetTags(id, next, what.replace(/<[^>]+>/g, '').replace(/&(lt|gt|quot|#39|amp);/g, (m, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' }[e])));
  // The board's Tags filter lists every tag in use, with counts.
  if (api() && api().refreshFilters) api().refreshFilters();
  // Every picker of this property shows the change — also one in a dialog the tab does not redraw —
  // and the one that was used is back in its box at once, so the next keys typed are not lost.
  // (Once more after the event, in case something redraws later.)
  redrawPickers(target, typing, home);
  setTimeout(() => redrawPickers(target, typing, home), 0);
}

// opts.small: compact. opts.lazy: just the chips and a "+ Tag" button that becomes the box when
// clicked — for long lists (the Posting sheet), where a box on every row would weigh the page down.
window.tagEditorHtml = (target, tags, opts) => {
  const list = TG.cleanTags(tags);
  const small = opts && opts.small, lazy = opts && opts.lazy;
  const chips = list.map(t => `<span class="tk-tag ${TG.tagClass(t)}" title="${esc(t)}"><span class="tg-t">${esc(t)}</span><button type="button" class="tg-x" onclick="event.stopPropagation();tagRemove(${jsq(target)}, ${jsq(t)})" aria-label="Remove tag ${esc(t)}" title="Remove">✕</button></span>`).join('');
  if (lazy) return `<div class="tg sm lazy" data-tg="${esc(target)}">${chips}<button type="button" class="tg-plus" onclick="event.stopPropagation();tagExpand(this)" aria-label="Add a tag">+ Tag</button></div>`;
  return `<div class="tg${small ? ' sm' : ''}" data-tg="${esc(target)}">
    ${chips}
    <span class="tg-add">
      <input class="tg-in" type="text" maxlength="${TG.MAX_TAG}" placeholder="+ Add tag" autocomplete="off" spellcheck="false" aria-label="Add a tag"
        onclick="event.stopPropagation()" oninput="tagInput(this)" onfocus="tagInput(this)" onkeydown="tagKeydown(event, this)" onblur="setTimeout(() => tagClose(this), 150)">
      <div class="tg-sug" role="listbox"></div>
    </span>
  </div>`;
};

const targetOf = el => (el.closest('.tg') || {}).dataset ? el.closest('.tg').dataset.tg : '';
function options(el) {
  const target = targetOf(el), typed = TG.normTag(el.value);
  const cat = window.tagCatalog();
  const sug = TG.suggestTags(typed, cat, tagsOfTarget(target)).slice(0, 8);
  const exists = cat.some(t => TG.tagKey(t) === TG.tagKey(typed)) || TG.hasTag(tagsOfTarget(target), typed);
  return { target, typed, sug, create: typed && !exists ? typed : '' };
}
// "+ Tag" → the full picker in its place, ready to type.
window.tagExpand = btn => {
  const box = btn.closest('.tg'), target = box.dataset.tg;
  box.outerHTML = window.tagEditorHtml(target, tagsOfTarget(target), { small: true });
  const now = [...document.querySelectorAll('.tg')].find(e => e.dataset.tg === target && !e.classList.contains('lazy'));
  const input = now && now.querySelector('.tg-in');
  if (input) input.focus();
};
window.tagInput = el => {
  const box = el.parentElement.querySelector('.tg-sug');
  const o = options(el);
  if (!o.sug.length && !o.create) { box.classList.remove('open'); box.innerHTML = ''; return; }
  const btn = (t, label) => `<button type="button" role="option" class="tg-opt" onmousedown="event.preventDefault()" onclick="event.stopPropagation();tagPick(${jsq(o.target)}, ${jsq(t)})">${label}</button>`;
  box.innerHTML = o.sug.map(t => btn(t, `<i class="tg-dot ${TG.tagClass(t)}" aria-hidden="true"></i>${esc(t)}`)).join('') + (o.create ? btn(o.create, `<span class="tg-new">Create</span> “${esc(o.create)}”`) : '');
  box.classList.add('open');
};
window.tagClose = el => { const box = el && el.parentElement && el.parentElement.querySelector('.tg-sug'); if (box) box.classList.remove('open'); };
window.tagKeydown = (e, el) => {
  e.stopPropagation();   // the card behind it must not open on Enter
  if (e.key === 'Escape') { el.value = ''; window.tagClose(el); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const o = options(el);
  // The exact tag if it exists, else the first suggestion for what was typed, else a new one.
  const exact = window.tagCatalog().find(t => TG.tagKey(t) === TG.tagKey(o.typed));
  const pick = exact || (o.typed ? o.sug[0] || o.create : '');
  if (pick) window.tagPick(o.target, pick);
};
window.tagPick = (target, tag) => {
  const cur = tagsOfTarget(target);
  if (TG.hasTag(cur, tag)) return;
  const next = TG.addTag(cur, tag, window.tagCatalog());
  save(target, next, `Tag added: <b>${esc(next.find(t => TG.tagKey(t) === TG.tagKey(tag)))}</b>`, true, homeOf(document.activeElement));
};
window.tagRemove = (target, tag) => {
  save(target, TG.removeTag(tagsOfTarget(target), tag), `Tag removed: <b>${esc(tag)}</b>`, false, homeOf(document.activeElement));
};
