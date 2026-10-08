// ═══════ TAGS — words to group properties by (Collab, New Dev., Resale, Plot …) ═══════
//
// Pure, dependency-free ES module shared by the board (app.js), the Posting tab (posting.js /
// posting-view.js) and the tag picker (tag-editor.js), so every page agrees on what a tag is.
//
// A tag is free text, added on the spot. The list to pick from is the starting four plus every
// tag in use anywhere — there is no separate list to keep. Spelling is shared: a tag that already
// exists keeps its spelling, so "resale" typed later is Resale, never a second tag.

export const DEFAULT_TAGS = ['Collab', 'New Dev.', 'Resale', 'Plot'];

// Each tag has its own colour, the same everywhere: the starting four fixed (Collab violet, New Dev.
// blue, Resale green, Plot amber), any other picked from the rest of the palette by its name — so a
// tag never changes colour, and nobody has to choose one. Styled as .tc0 … .tc9 in style.css.
export const TAG_COLORS = 10;
export function tagColor(tag) {
  const k = tagKey(tag);
  const d = DEFAULT_TAGS.findIndex(x => tagKey(x) === k);
  if (d >= 0) return d;
  let h = 0;
  for (const ch of k) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return DEFAULT_TAGS.length + (h % (TAG_COLORS - DEFAULT_TAGS.length));
}
export const tagClass = tag => 'tc' + tagColor(tag);
export const MAX_TAG = 32;

export const normTag = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_TAG);
export const tagKey = s => normTag(s).toLowerCase();

// A saved list, made safe: strings only, trimmed, no blanks, no repeats (first spelling wins).
export function cleanTags(list) {
  const seen = new Set(), out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const n = normTag(t), k = n.toLowerCase();
    if (n && !seen.has(k)) { seen.add(k); out.push(n); }
  }
  return out;
}

// Everything that can be picked: the starting tags in their order, then every other tag in use, A–Z.
export function catalog(...lists) {
  const seen = new Set(DEFAULT_TAGS.map(tagKey)), extra = [];
  for (const l of lists) for (const t of cleanTags(l)) if (!seen.has(tagKey(t))) { seen.add(tagKey(t)); extra.push(t); }
  return [...DEFAULT_TAGS, ...extra.sort((a, b) => a.localeCompare(b))];
}

export const hasTag = (list, tag) => cleanTags(list).some(t => tagKey(t) === tagKey(tag));

// Adding takes the spelling already in use; adding one that is there changes nothing.
export function addTag(list, tag, cat) {
  const n = normTag(tag);
  if (!n) return cleanTags(list);
  const known = (cat || []).find(c => tagKey(c) === tagKey(n)) || n;
  return cleanTags([...cleanTags(list), known]);
}
export const removeTag = (list, tag) => cleanTags(list).filter(t => tagKey(t) !== tagKey(tag));

// What to offer while typing: tags not on it yet, those starting with the text first, then those
// containing it. Nothing typed → all of them.
export function suggestTags(typed, cat, current) {
  const k = tagKey(typed);
  const on = new Set(cleanTags(current).map(tagKey));
  const pool = (cat || []).filter(t => !on.has(tagKey(t)));
  if (!k) return pool;
  return [...pool.filter(t => tagKey(t).startsWith(k)), ...pool.filter(t => !tagKey(t).startsWith(k) && tagKey(t).includes(k))];
}
