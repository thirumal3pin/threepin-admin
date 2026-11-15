// ═══════ WHAT A SELLER'S PROPERTY IS, FROM THEIR OWN WORDS ═══════
//
// Owners describe the property in the chat — "Individual house 4800 sqft land, over 3000 sqft
// construction, Adambakkam", "2 BHK 1555 sqft, 62000₹ rent", "6.5 cents and 16L". The Sellers
// page needs that as fields it can show, filter and sort: sale or rent, type, configuration,
// size and price. This reads them with plain patterns — no AI, so no cost and no surprises —
// and returns only what it actually found. Anything it cannot read stays blank, and the board's
// own edits always win over it.
//
// Pure: used by the TailorTalk sync on the server (from the customer's messages and TailorTalk's
// profile) and by the Sellers page in the browser (for sellers typed in by hand, from notes).

const NUM = '(\\d{1,3}(?:,\\d{2,3})+|\\d+(?:\\.\\d+)?)';
const num = s => parseFloat(String(s).replace(/,/g, ''));
// One formatter for every number (toLocaleString builds a new one per call — the Sellers page calls
// this for every seller on every redraw).
const NUM_FMT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const fmtNum = n => NUM_FMT.format(Math.round(n * 100) / 100);

// Buildings before land: "villa, land area 4500 sqft" is a villa, not a plot.
const TYPES = [
  ['villa', /\bvillas?\b/i],
  ['house', /\b(independent|individual|standalone)\s+(house|home|building)\b|\bduplex\b|\bg\s*\+\s*\d\b|\bbungalow\b|\bhouse\b/i],
  ['commercial', /\b(commercial|office|shop|showroom|godown|warehouse|pre-?school|school|clinic|hotel|retail)\b/i],
  ['apartment', /\b(apartment|flat|gated community)\b/i],
  ['land', /\b(plot|land|cents?|grounds?|acres?)\b/i],
  ['apartment', /bhk\b/i]
];
export const TYPE_LABELS = { apartment: 'Apartment', villa: 'Villa', house: 'Independent house', land: 'Land / plot', commercial: 'Commercial' };

/**
 * @param {Array<string>|string} texts  the seller's own words, newest last
 * @returns {{deal, type, config, sizes: Array<{kind,label,sqft}>, price, priceValue, rent}}
 */
export function extractPropertyFacts(texts) {
  const all = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).map(t => String(t).replace(/\s+/g, ' ')).join(' \n ');
  const out = { deal: null, type: null, config: null, sizes: [], price: null, priceValue: null };
  if (!all.trim()) return out;

  // Sale or rent: weighed, never "any sale word wins". An agent's sign-off ("Agent. Buying Selling
  // Properties") says what they do, not what this property is; "Rent 6 lak, 6 Month Advance" says
  // it is a rental. When both sides are equally strong the answer is unknown, not a guess.
  out.deal = dealOf(all);
  const rent = out.deal === 'rent';

  for (const [k, re] of TYPES) if (re.test(all)) { out.type = k; break; }

  const bhk = all.match(/(\d(?:\.\d)?)\s*-?\s*bhk\b/i);
  if (bhk) out.config = `${bhk[1]} BHK`;
  else if (out.type === 'commercial') out.config = 'Commercial';

  // Sizes: square feet tagged by what they measure, plus cents / grounds / acres for land.
  const seen = new Set();
  const sqftRe = new RegExp(`${NUM}\\s*(?:sq\\.?\\s*ft|sqft|sft|sq\\s*feet|square\\s*feet|sq\\.?\\s*f)\\b`, 'gi');
  const KIND = t => /\buds\b/.test(t) ? 'uds' : /\b(land|plot|site)\b/.test(t) ? 'land'
    : /\bcarpet\b/.test(t) ? 'carpet' : /\b(built|construction|super|saleable|bua)\b/.test(t) ? 'built' : null;
  let lastEnd = 0;
  for (const m of all.matchAll(sqftRe)) {
    const n = num(m[1]);
    const end = m.index + m[0].length;
    // What the number measures is named right after it ("4800 sqft land") or just before it
    // ("Land - 1375 sqft", "Carpet Area- 1250 sq ft"). A word after the number counts only when it
    // is not itself the label of the next one ("1836 sq ft Carpet Area- 1250"), and the text
    // before never reaches back into the previous measurement or the word that labelled it.
    // tail: the first word after the number, then everything up to the next figure. When that
    // run ends in "-" or ":" it is the label of the NEXT figure ("Carpet Area- 1250").
    const tail = all.slice(end, end + 40).toLowerCase().match(/^\s*([a-z]+)([^0-9]*)/);
    const postfix = tail && KIND(tail[1]) && !/[-:–]\s*$/.test(tail[2]) ? KIND(tail[1]) : null;
    const before = all.slice(Math.max(lastEnd, m.index - 24), m.index).toLowerCase();
    lastEnd = postfix ? end + tail[0].length : end;
    if (!n || n < 100 || n > 500000) continue;
    const kind = postfix || KIND(before) || 'built';
    const key = kind + n;
    if (seen.has(key)) continue;
    seen.add(key);
    out.sizes.push({ kind, sqft: n, label: `${fmtNum(n)} sqft${kind === 'built' ? '' : ' ' + ({ uds: 'UDS', land: 'land', carpet: 'carpet' })[kind]}` });
  }
  const landRe = new RegExp(`${NUM}\\s*(cents?|grounds?|acres?)\\b`, 'gi');
  for (const m of all.matchAll(landRe)) {
    const n = num(m[1]), unit = m[2].toLowerCase().replace(/s$/, '');
    const per = { cent: 435.6, ground: 2400, acre: 43560 }[unit];
    if (!n || !per) continue;
    out.sizes.push({ kind: 'land', sqft: Math.round(n * per), label: `${fmtNum(n)} ${unit}${n === 1 ? '' : 's'}` });
    if (!out.type) out.type = 'land';
  }
  // The same figure repeated across messages is one measurement.
  const once = new Set();
  out.sizes = out.sizes.filter(z => !once.has(z.label) && once.add(z.label)).slice(0, 4);
  // A land area AND a built-up area with a BHK count is a house on its own plot.
  if ((out.type === 'apartment' || (out.type === 'land' && out.config)) && out.sizes.some(x => x.kind === 'land') && out.sizes.some(x => x.kind === 'built')) out.type = 'house';

  // Price: crores / lakhs for a sale (a range "55-60L" kept as a range, sorted by its low end),
  // a monthly figure for rent.
  const big = all.match(new RegExp(`(?:₹|rs\\.?|inr)?\\s*${NUM}(?:\\s*(?:-|to|–)\\s*${NUM})?\\s*(cr|crs|crore|crores|l|lac|lacs|lacks|lak|laks|lakh|lakhs)\\b`, 'i'));
  if (big) {
    const n = num(big[1]), hi = big[2] ? num(big[2]) : null, u = big[3].toLowerCase();
    const crore = /^cr/.test(u);
    out.priceValue = Math.round(n * (crore ? 1e7 : 1e5));
    // A rental quoted in lakhs ("Rent 6 lakh, 6 months advance") is 6 lakh a month, not a price.
    out.price = `₹${fmtNum(n)}${hi ? '–' + fmtNum(hi) : ''} ${crore ? 'Cr' : 'L'}${rent && !crore ? '/month' : ''}`;
    if (!out.deal) out.deal = 'sale';
  } else {
    // "for Rent in Mylapore – 8,600 Sq. Ft." — the number after "rent" there is the area, not the
    // rent: a figure followed by an area unit (or not ending there: "8,60" of "8,600"), or one
    // already read as a size, is never a monthly rent.
    const AREA_AFTER = '(?![\\d,]|\\.\\d|\\s*(?:sq|sft|square|ft\\b|feet|cents?\\b|grounds?\\b|acres?\\b|bhk))';
    const isSize = m => out.sizes.some(z => z.sqft === Math.round(num(m[1])));
    const afterWord = [...all.matchAll(new RegExp(`(?:rent|expect(?:ed|ing)?)[^\\d]{0,24}${NUM}${AREA_AFTER}\\s*(?:₹|k\\b)?`, 'gi'))].find(m => !isSize(m));
    const monthly = all.match(new RegExp(`(?:₹|rs\\.?)?\\s*${NUM}\\s*(?:₹|rs\\.?|\\/-)?\\s*(?:per month|\\/month|\\/ month|pm|monthly)\\b`, 'i'))
      || (out.deal === 'rent' ? all.match(new RegExp(`${NUM}\\s*(?:₹|rs\\b|\\/-)`, 'i')) : null)
      || afterWord;
    if (monthly) {
      let n = num(monthly[1]);
      if (/k\b/i.test(monthly[0]) && n < 1000) n *= 1000;
      if (n >= 1000) { out.priceValue = Math.round(n); out.price = `₹${fmtNum(n)}/month`; if (!out.deal) out.deal = 'rent'; }
    }
  }
  return out;
}

// ── Sale or rent ──
// What an agent or broker says they do ("Buying Selling Properties", "buying, selling & renting",
// "real estate agent") is about them, not this property: it is taken out before weighing.
const TRADE_LINE = /\b(?:buy(?:ing)?|sell(?:ing)?|sale|rent(?:al|ing)?|leas(?:e|ing))(?:\s*(?:[,/&+]|and)?\s*(?:buy(?:ing)?|sell(?:ing)?|sale|rent(?:al|ing)?|leas(?:e|ing)))+\s*(?:of\s+)?(?:propert(?:y|ies)|real\s*estate|services?)\b|\breal\s*estate\s*(?:agent|broker|consultant|services?)\b/gi;
// Strong: says what THIS property is. Weak: words that lean one way.
const RENT_STRONG = /\b(?:for\s*rent|for\s*lease|on\s*rent|to[\s-]*let|rent(?:ing)?\s*out|give\s*(?:it\s*)?(?:for|on)\s*rent|rent\s*(?:is|:|-|of|rs\.?|₹)?\s*₹?\s*\d|monthly\s*rent|expected\s*rent|\d+\s*months?\s*(?:advance|deposit)|(?:advance|deposit)\s*(?:of\s*)?\d+\s*months?)/gi;
const RENT_WEAK = /\b(?:rent(?:al)?|lease|tenants?|per\s*month|\/\s*month|monthly|p\.?\s*m\b|advance|deposit|families\s*only|bachelors?)\b/gi;
const SALE_STRONG = /\b(?:for\s*sale|to\s*sell|want\s*to\s*sell|wants\s*to\s*sell|planning\s*to\s*sell|sell\s*(?:my|our|this|it|the)|selling\s*(?:my|our|this|the)|resale|sale\s*price|outright|guideline\s*value)\b/gi;
const SALE_WEAK = /\b(?:sale|sell|selling|sold|crores?|cr\b)\b/gi;
const hits = (re, s) => (s.match(re) || []).length;

/**
 * 'sale', 'rent' or null for a text about ONE property. Strong phrases count 3, leaning words 1;
 * the side that is clearly ahead wins, and a tie is null (shown as nothing, never a wrong label).
 * Exported for the board and the TailorTalk sync, which also weigh the AI's read of the chat.
 */
export function dealOf(text) {
  const s = ' ' + String(text || '').replace(TRADE_LINE, ' ') + ' ';
  const rStrong = hits(RENT_STRONG, s), sStrong = hits(SALE_STRONG, s);
  // A rental income on a property for sale ("pre-leased, rental income 1.5L/month") is a sale.
  const income = /\b(?:rental\s*income|pre[\s-]*leased|tenanted|yield|roi)\b/i.test(s);
  const r = rStrong * 3 + hits(RENT_WEAK, s) - (income ? 3 : 0);
  const sa = sStrong * 3 + hits(SALE_WEAK, s) + (income ? 3 : 0);
  if (!r && !sa) return null;
  if (r > sa) return 'rent';
  if (sa > r) return 'sale';
  return null;
}

/**
 * What TailorTalk's own summary ("List, residential individual house for rent") or the CRM's AI
 * says the owner is doing: 'rent', 'sale' or null. This is a read of the whole conversation, so
 * it outranks patterns picked out of single messages.
 */
export function dealFromIntent(intentText, aiIntent) {
  if (aiIntent === 'rent_out') return 'rent';
  if (aiIntent === 'sell') return 'sale';
  const t = String(intentText || '').toLowerCase();
  if (!t) return null;
  const rent = /\b(?:for\s*rent|for\s*lease|on\s*rent|rent(?:ing)?\s*out|rental\s*listing|let\s*out|to\s*let)\b|^\s*rent\b/.test(t);
  const sale = /\b(?:for\s*sale|sell(?:ing)?\b(?!\s*(?:and|\/|&)\s*buy)|sale\b)/.test(t.replace(TRADE_LINE, ' '));
  return rent && !sale ? 'rent' : sale && !rent ? 'sale' : null;
}

/** The size to sort by: built-up first, then land, then any. */
export function sortSize(f) {
  const s = (f && f.sizes) || [];
  const pick = s.find(x => x.kind === 'built') || s.find(x => x.kind === 'land') || s[0];
  return pick ? pick.sqft : 0;
}
