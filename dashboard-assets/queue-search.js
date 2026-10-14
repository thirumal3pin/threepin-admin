// ═══════════════════════════════════════════════════════════════════════
// THE SELLER QUEUE, AS SEARCH SUGGESTIONS
//
// A property reaches the Property Dashboard only after its shoot and edit are done and its
// brochure is made — but a client can be shown it before that. A card on the Shoot & Media board
// that is still on its way (new listing … media ready, even live) and has no property in the
// dashboard yet is offered under a search as "UPCOMING : NOT IN PROPERTY DASHBOARD", with a
// link to its card on the seller board.
//
// Pure: takes the cards and the dashboard's properties, returns what to suggest. The page
// (dashboard-assets/app.js) owns fetching and drawing. Each card is read by the SAME engine as
// the dashboard (PinSearch), as a property with only the facts a card has: title, location,
// configuration, asking price.
// ═══════════════════════════════════════════════════════════════════════
(function (root) {
  // The sheet's Property_ID, as the board's own rule has it: a bare number is an older record's id.
  const realCode = c => !!String(c || '').trim() && !/^\d+$/.test(String(c).trim());
  // A code compared the way the board compares it (track-assets/brochure-flow.js codeKey):
  // "TNAG-0002", "tnag 0002" and "TNAG0002" are one property.
  const codeKey = c => String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Cards that are finished (sold / rented), set aside (on hold) or abandoned (dropped) are not
  // upcoming stock. The page resolves each card's column before this runs and does not offer
  // anything when it could not (see sellerQueue in firebase-sync.js), so an unrecognised column
  // here is a hand-named one the board keeps open: kept.
  function isWaiting(card) {
    const kind = card.stageKind;
    return !kind || kind === 'open';
  }

  // Whether the dashboard already has this property — by the card's code, or the code its
  // brochure was asked for under (filled into propertyCode only when the board next opens), or an
  // older record's id.
  function inDashboard(card, properties) {
    const keys = [card.propertyCode, card.brochureCode].map(codeKey).filter(Boolean);
    if (!keys.length) return false;
    for (const p of properties || []) {
      const pk = codeKey(p.propertyCode), ik = codeKey(p.id);
      if (keys.some(k => k === pk || k === ik)) return true;
    }
    return false;
  }

  // What kind of property, from what the card says — so the dashboard's Type bar can apply when
  // the card makes it clear, and is not applied when it does not.
  function typeOf(card) {
    const t = String([card.propertyType, card.title, card.config].filter(Boolean).join(' ')).toLowerCase();
    if (!t) return '';
    if (/\bvilla\b/.test(t)) return 'Villa';
    if (/\b(plot|plots|land|ground)\b/.test(t)) return 'Plots';
    if (/\b(independent|individual)\s+house\b|\bhouse\b/.test(t)) return 'House';
    if (/\b(apartment|apartments|flat|flats)\b|\d\s*bhk\b/.test(t)) return 'Apartments';
    return '';
  }

  // One card, as a property the search engine can read.
  function asProperty(card) {
    const title = String(card.title || '').trim();
    const location = String(card.location || card.address || '').trim();
    const code = realCode(card.propertyCode) ? String(card.propertyCode).trim()
      : realCode(card.brochureCode) ? String(card.brochureCode).trim() : '';
    return {
      id: 'queue:' + card.id,
      queue: true,
      listingId: card.id,
      name: title || code || location,
      propertyCode: code,
      location,
      config: card.config || '',
      startingPrice: card.askingPrice || '',
      type: card.propertyType || '',
      queueType: typeOf(card),
      // No status: a card does not say whether the flat is ready, and "Upcoming" is said by the label.
      status: '',
      stageName: card.stageName || '',
      stageKey: card.stageKey || '',
      shootAt: card.shootAt || null
    };
  }

  // Two cards for one property (before someone merges them on the board) are one suggestion.
  function sameKey(p) {
    if (p.propertyCode) return 'c:' + codeKey(p.propertyCode);
    const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return 't:' + n(p.name) + '|' + n(p.location);
  }

  /** The cards worth suggesting: waiting on the board, not in the dashboard, with something to read. */
  function candidates(cards, properties) {
    const out = [], seen = new Set();
    for (const card of cards || []) {
      if (!card || !card.id || !isWaiting(card)) continue;
      // A series card is one edit of several properties, not a property.
      if (card.kind === 'series') continue;
      if (inDashboard(card, properties)) continue;
      // Something to read: a title, a place or a code. A card with none is not a suggestion.
      if (!(String(card.title || '').trim() || String(card.location || card.address || '').trim()
        || realCode(card.propertyCode) || realCode(card.brochureCode))) continue;
      const p = asProperty(card);
      const k = sameKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out;
  }

  /**
   * What the queue has for this search, best first.
   * @param cards       the seller board's cards, each with stageKind / stageName resolved
   * @param properties  the dashboard's properties (what is already there is never suggested)
   * @param opts        { text, advanced, gazetteer, limit, type }   type: the Type bar's pick
   * @returns [{ p, score, reasons, km?, from?, where? }]  p is the card read as a property
   *          (p.queue === true); km/from/where are set on a card offered for a NEARBY area
   */
  function search(cards, properties, opts) {
    const o = opts || {};
    const eng = root.PinSearch;
    if (!eng || !(o.text || o.advanced)) return [];
    let list = candidates(cards, properties);
    // The Type bar, where the card says what it is; a card that does not say is kept.
    if (o.type && o.type !== 'all') list = list.filter(p => !p.queueType || p.queueType === o.type);
    if (!list.length) return [];
    let hits = [];
    try { hits = eng.search(list, { text: o.text || '', advanced: o.advanced || null, gazetteer: o.gazetteer }); }
    catch (e) { hits = []; }
    // Cards a few km from the area asked for, as the dashboard's own nearby group does.
    const M = root.PinMatch;
    if (o.text && M && M.nearbyAreas && root.PinGeo) {
      try {
        const near = M.nearbyAreas(list, o.text, { gazetteer: o.gazetteer, exclude: hits.map(h => h.p) });
        hits = hits.concat(near.map(n => ({ p: n.p, score: 0, reasons: [], km: n.km, from: n.from, where: n.where })));
      } catch (e) { /* nearby is a bonus */ }
    }
    return o.limit ? hits.slice(0, o.limit) : hits;
  }

  root.PinQueue = { candidates, search, asProperty, inDashboard, isWaiting, realCode, codeKey, typeOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
