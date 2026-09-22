// ═══════ THE SAME PROPERTY, ENTERED TWICE ═══════
//
// The inventory holds the same property under two records: one synced from
// the sheet, carrying a property code, and one entered another way — an early
// import (small numeric ids) or the Add Property form (ids like
// p1785591124271). They are not near-misses. "Aynavaram Bungalow" and
// "Independent Bungalow, Police Manickam Street" are one 5BHK in Ayanavaram
// at ₹6.75 Cr with the same phone number, the same 1,280 sqft and the same
// notes; only the title differs.
//
// On the map they appear as two pins at the same place with the same price,
// which is what the owner saw. In the list they are two cards. In matching
// they are two results for one building.
//
// ═══════ WHAT THIS WILL AND WILL NOT DO ═══════
//
// Hiding a property that is REAL costs a sale, so nothing is dropped on a
// hunch. A pair has to agree on several things at once that a coincidence
// would not:
//
//   · one has a property code and the other does not — every duplicate in
//     the live data has that shape, and it says which record is canonical;
//   · one locality is contained in the other (token-wise), so
//     "Anna Nagar West Extension, Chennai" matches "Anna Nagar West
//     Extension" but not "Anna Nagar, I Block";
//   · AND EITHER the names are identical once punctuation is stripped,
//     OR the prices agree within 3% and the config or the floor area matches
//     too.
//
// That last branch is what catches the pairs whose titles were rewritten, and
// the price condition is what stops it catching two different flats in one
// building. Nothing is ever deleted: the losing record is hidden from the
// views and reported, so the owner can merge or remove it at source.
(function (root) {
  'use strict';

  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tight = s => norm(s).replace(/ /g, '');

  // Words that say where something is in Chennai without narrowing it down.
  const STOP = new Set(['chennai', 'tamil', 'nadu', 'india', 'near', 'next', 'to', 'off', 'bang', 'on', 'the', 'and']);
  const locTokens = s => new Set(norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)));

  const digitsOf = s => String(s == null ? '' : s).replace(/[^0-9]/g, '');

  // ═══════ WHAT MAKES ONE UNIT DIFFERENT FROM THE ONE NEXT TO IT ═══════
  //
  // "Pooja Diamond Foundation (11th Floor)" and "(12th Floor)" are one
  // building, one price, one floor area and one configuration — and two
  // properties. So are "MP PETALS Phase 1" and "Phase 2". Everything the
  // price branch looks at agrees, and it is still wrong to merge them.
  //
  // These markers are the difference. When both names carry one and they do
  // not match, the records are about different units and no amount of other
  // agreement can outvote that.
  const MARKER = /\b(?:phase|floor|block|tower|wing|stage|unit|villa|plot)\s*(?:no\.?\s*)?([0-9]{1,3}|[a-z])\b/gi;
  const ORDINAL = /\b([0-9]{1,3})(?:st|nd|rd|th)\b/gi;

  function unitMarkers(name) {
    const t = ' ' + norm(name) + ' ';
    const out = new Set();
    let m;
    MARKER.lastIndex = 0;
    while ((m = MARKER.exec(t))) out.add(m[0].replace(/\s+/g, ' ').trim());
    ORDINAL.lastIndex = 0;
    while ((m = ORDINAL.exec(t))) out.add('ord' + m[1]);
    return out;
  }

  // True when both names name a unit and they are not the same unit.
  function differentUnit(a, b) {
    const ma = unitMarkers(a.name), mb = unitMarkers(b.name);
    if (!ma.size || !mb.size) return false;
    if (ma.size !== mb.size) return true;
    for (const x of ma) if (!mb.has(x)) return true;
    return false;
  }

  // Price comes from the search engine when it is loaded, because it already
  // understands "Rs.65 Lakhs to Rs.95 L", "2,20,00,000" and "₹2.20 Crores +
  // Registration". Without it, only the name branch can fire — which is the
  // safe direction to fail in.
  function priceOf(p) {
    const S = root.PinSearch;
    if (!S || !S.indexProperty) return null;
    try {
      const r = S.indexProperty(p).num.price;
      return r && r.length ? Math.min(...r.map(v => v[0])) : null;
    } catch (e) { return null; }
  }

  function areaOf(p) {
    return digitsOf(p.sqftRange || p.builtupArea || p.carpetArea || '');
  }

  // Is `a` one locality inside the other's? Token containment rather than
  // string containment, so word order and punctuation do not matter.
  function sameLocality(a, b) {
    const la = locTokens(a.location), lb = locTokens(b.location);
    if (!la.size || !lb.size) return false;
    let shared = 0;
    la.forEach(w => { if (lb.has(w)) shared++; });
    return shared > 0 && shared >= Math.min(la.size, lb.size);
  }

  /**
   * Why these two records are the same property — or null if they are not.
   * Returned rather than a boolean so the reason can be shown to whoever has
   * to decide what to delete.
   */
  function duplicateReason(a, b) {
    // Exactly one carries a code. Two coded records are two sheet rows and
    // are the sheet's business; two uncoded ones give us nothing to prefer.
    if (!!a.propertyCode === !!b.propertyCode) return null;
    if (!sameLocality(a, b)) return null;
    // A veto, checked before anything else: no amount of agreement on price,
    // size and configuration makes the 11th floor the 12th.
    if (differentUnit(a, b)) return null;

    const nameHit = !!tight(a.name) && tight(a.name) === tight(b.name);
    if (nameHit) return { why: 'the same name in the same locality', strength: 'name' };

    const pa = priceOf(a), pb = priceOf(b);
    const priceHit = pa != null && pb != null && Math.abs(pa - pb) / Math.max(pa, pb) < 0.03;
    if (!priceHit) return null;

    const cfgHit = !!tight(a.config) && tight(a.config) === tight(b.config);
    const areaHit = !!areaOf(a) && areaOf(a) === areaOf(b);
    if (!cfgHit && !areaHit) return null;

    const agrees = ['the same price'];
    if (cfgHit) agrees.push('the same configuration');
    if (areaHit) agrees.push('the same floor area');
    return { why: agrees.join(', ') + ' in the same locality', strength: cfgHit && areaHit ? 'strong' : 'price' };
  }

  /**
   * Finds every duplicate pair in a list.
   * Returns { pairs, hide } where `hide` is a Set of the ids to leave out of
   * the views. The coded record is always the one kept: it is the one the
   * sheet will keep re-syncing, and the one whose code an agent quotes.
   */
  function findDuplicates(list) {
    const items = Array.isArray(list) ? list : [];
    const pairs = [];
    const hide = new Set();
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (hide.has(a.id) || hide.has(b.id)) continue;
        const r = duplicateReason(a, b);
        if (!r) continue;
        const keep = a.propertyCode ? a : b;
        const drop = a.propertyCode ? b : a;
        hide.add(drop.id);
        pairs.push({ keep, drop, why: r.why, strength: r.strength });
      }
    }
    return { pairs, hide };
  }

  /** The list with the duplicate records left out, plus what was left out. */
  function dedupe(list) {
    const { pairs, hide } = findDuplicates(list);
    if (!hide.size) return { list: Array.isArray(list) ? list : [], pairs, hide };
    return { list: list.filter(p => !hide.has(p.id)), pairs, hide };
  }

  const api = { dedupe, findDuplicates, duplicateReason, sameLocality, unitMarkers, differentUnit };
  root.PinDedupe = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
