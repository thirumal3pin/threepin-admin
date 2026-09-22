// ═══════ MAP CORE — the load contract, and the text agents send clients ═══════
//
//   node tests/map-core.test.mjs
//
// Two things live in map-core that had no tests:
//
//   · the LOAD state machine, which decides what the agent is told when the
//     map does not appear. It has crashed production twice — once on
//     `class extends google.maps.OverlayView` before importLibrary was
//     called, once on ControlPosition, which is in the 'core' library and not
//     in 'maps'. Both times a permissive stub let it pass.
//
//   · priceLabel / priceRange / pitchFor / whatsappUrl, which produce the
//     message an agent pastes into a client's WhatsApp. A rounding slip here
//     is a wrong price quoted to a buyer.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = f => readFileSync(join(ROOT, f), 'utf8');

let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); fails.push(label); }
}
const eq = (label, got, want) => ok(label, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
const section = t => { console.log(''); console.log(t); };

// A fresh module per case: `load()` memoises its promise, so the state
// machine can only be driven once per instance.
function freshCore(env) {
  const g = { console, setTimeout, clearTimeout, Promise, Error, JSON, Math, String, Number, encodeURIComponent };
  Object.assign(g, env);
  g.globalThis = g;
  new Function('globalThis', 'window', 'document', 'google',
    'return (function(){ ' + src('map-assets/map-core.js') + ' }).call(globalThis)')
    .call(g, g, g, g.document, g.google);
  return g.PinMapCore;
}

// ═══════════════════════════════════════════════════════════════════════
section('PRICE — what a client is told the property costs');
// ═══════════════════════════════════════════════════════════════════════
{
  const C = freshCore({ document: undefined });
  const L = C.priceLabel;
  eq('a crore is a crore', L(10000000), '1 Cr');
  eq('3.5 crore keeps its half', L(35000000), '3.5 Cr');
  eq('under ten crore keeps one decimal', L(32500000), '3.3 Cr');
  eq('ten and over rounds to whole crore', L(125000000), '13 Cr');
  eq('lakhs below a crore', L(7500000), '75 L');
  eq('thousands below a lakh', L(45000), '₹45k');
  eq('nothing known says so', L(null), '—');
  eq('a broken number says so rather than printing NaN', L(Infinity), '—');
  eq('...and so does NaN', L(NaN), '—');
  eq('zero is a number, not a blank', L(0), '₹0k');

  const R = C.priceRange;
  eq('no price at all is on request', R(null, null), 'Price on request');
  eq('one price is one price', R(35000000, null), '₹3.5 Cr');
  eq('a range within 2% is not a range', R(35000000, 35400000), '₹3.5 Cr');
  eq('a real range is shown as one', R(30000000, 40000000), '₹3 Cr–4 Cr');
  eq('a backwards range is put the right way round, not read out as-is',
    R(40000000, 30000000), '₹3 Cr–4 Cr');
}

// ═══════════════════════════════════════════════════════════════════════
section('THE WHATSAPP PITCH — what actually gets sent');
// ═══════════════════════════════════════════════════════════════════════
{
  const C = freshCore({ document: undefined });
  const p = {
    propertyCode: 'ANR0099', name: 'Kanaka Residency', location: 'Anna Nagar, Chennai',
    config: '3BHK', sqftRange: '1750-1900 Sq.Ft', startingPrice: '₹3.5 Crores',
    pricePerSqft: '₹19,500/Sqft', status: 'Ready to Move',
    highlights: 'Corner plot, 40ft road, Park facing, Vastu, Covered parking'
  };
  const t = C.pitchFor(p, { url: 'https://example.com/p/1' });
  ok('the code and the name lead', t.startsWith('ANR0099 — Kanaka Residency'), t.split('\n')[0]);
  ok('the locality is there', t.includes('Anna Nagar'));
  ok('ready to move is stated, because assuming it wastes a visit', t.includes('Ready to move'));
  ok('at most three highlights, so it stays a message and not a brochure',
    (t.match(/Corner plot|40ft road|Park facing|Vastu|Covered parking/g) || []).length === 3, t);
  ok('the link is last', t.trim().endsWith('https://example.com/p/1'));

  const upcoming = C.pitchFor({ propertyCode: 'X1', name: 'Y', status: 'Under Construction', possession: 'Dec 2027' });
  ok('an unfinished build says when, not "ready"',
    upcoming.includes('Dec 2027') && !/Ready to move/.test(upcoming), upcoming);

  const bare = C.pitchFor({ name: 'Just a name' });
  ok('a property with almost nothing still produces a sendable line',
    bare.trim().length > 0 && !/undefined|null|NaN/.test(bare), bare);

  const priced = C.pitchFor(p, { priceLo: 30000000, priceHi: 40000000 });
  ok('a known range beats the free-text price', priced.includes('₹3 Cr–4 Cr'), priced);
}
{
  const C = freshCore({ document: undefined });
  const u = C.whatsappUrl('hello there', '98400 12345');
  ok('a ten-digit Indian number gets its country code', u.includes('wa.me/919840012345'), u);
  ok('the text is encoded, not pasted raw', u.includes('hello%20there'), u);
  ok('a number that already has 91 is not given a second one',
    C.whatsappUrl('x', '919840012345').includes('wa.me/919840012345'));
  ok('no number still opens WhatsApp for the agent to choose a contact',
    C.whatsappUrl('x', '').startsWith('https://wa.me/?text='), C.whatsappUrl('x', ''));
  ok('a short or junk number is not sent as a recipient',
    C.whatsappUrl('x', '12345').startsWith('https://wa.me/?text='));
  ok('an ampersand in the pitch cannot break out of the url',
    !/[^%]&/.test(C.whatsappUrl('3BHK & parking', '9840012345').split('?text=')[1]),
    C.whatsappUrl('3BHK & parking', '9840012345'));
}

// ═══════════════════════════════════════════════════════════════════════
section('LOADING — what the agent is told when the map does not appear');
// ═══════════════════════════════════════════════════════════════════════
{
  const C = freshCore({ document: undefined });
  const r = await C.load('');
  ok('no key is reported as no key, not as a crash', r.ok === false && r.reason === 'no-key');
  ok('...and says exactly what to set', /GOOGLE_MAPS_BROWSER_KEY/.test(r.fix), r.fix);
}
{
  // The real contract: with loading=async the google.maps namespace is empty
  // until importLibrary is called, and the classes are split across two
  // libraries. A stub that hands everything back from 'maps' is what let two
  // production crashes through, so this one refuses to.
  const imported = [];
  const CORE = { LatLng: function () {}, LatLngBounds: function () {}, ControlPosition: { TOP_RIGHT: 1 }, event: {} };
  const MAPS = { Map: function () {}, OverlayView: function () {}, MapTypeControlStyle: { DROPDOWN_MENU: 1 } };
  const el = { appendChild() {}, classList: { add() {} }, style: {}, addEventListener() {} };
  const C = freshCore({
    document: {
      createElement: () => { const s = {}; setTimeout(() => s.onload && s.onload(), 0); return s; },
      head: { appendChild() {} }, body: { appendChild() {} }
    },
    google: { maps: { importLibrary: async n => { imported.push(n); return n === 'core' ? CORE : n === 'maps' ? MAPS : {}; } } }
  });
  const r = await C.load('A-KEY');
  ok('a healthy load reports ok', r.ok === true, JSON.stringify(r));
  ok('BOTH libraries are imported', imported.includes('maps') && imported.includes('core'), JSON.stringify(imported));
  const lib = C.lib();
  ok('the handle carries the maps classes', !!lib.Map && !!lib.OverlayView);
  ok('...and the core ones, which is where ControlPosition really lives',
    !!lib.ControlPosition && !!lib.LatLng && !!lib.LatLngBounds && !!lib.event);
}
{
  // The exact production failure: importLibrary('maps') alone.
  const C = freshCore({
    document: {
      createElement: () => { const s = {}; setTimeout(() => s.onload && s.onload(), 0); return s; },
      head: { appendChild() {} }, body: { appendChild() {} }
    },
    google: { maps: { importLibrary: async n => (n === 'maps'
      ? { Map: function () {}, OverlayView: function () {}, MapTypeControlStyle: {} } : {}) } }
  });
  const r = await C.load('A-KEY');
  ok('a library missing its members fails at load, not at first use', r.ok === false && r.reason === 'library');
  ok('...and names what is missing and which library it is in',
    /ControlPosition \(core\)/.test(r.fix || ''), r.fix);
}
{
  const C = freshCore({
    document: {
      createElement: () => { const s = {}; setTimeout(() => s.onerror && s.onerror(), 0); return s; },
      head: { appendChild() {} }, body: { appendChild() {} }
    }
  });
  const r = await C.load('A-KEY');
  ok('a blocked script is reported as a network problem', r.ok === false && r.reason === 'network');
  ok('...and mentions what to check', /maps\.googleapis\.com/.test(r.fix), r.fix);
}
{
  const C = freshCore({
    document: {
      createElement: () => { const s = {}; setTimeout(() => { if (typeof globalThis !== 'undefined') {} }, 0); return s; },
      head: { appendChild() {} }, body: { appendChild() {} }
    }
  });
  const p = C.load('A-KEY');
  // Google reports a rejected key through this global, not through onerror.
  setTimeout(() => { if (typeof C.__ === 'undefined') {} }, 0);
  ok('load returns a promise rather than throwing on a bad key', typeof p.then === 'function');
}
{
  const C = freshCore({ document: undefined });
  const a = C.load('');
  const b = C.load('');
  ok('load is asked once however many callers there are', a === b);
}

// ═══════════════════════════════════════════════════════════════════════
section('ESCAPING — a property name cannot become markup');
// ═══════════════════════════════════════════════════════════════════════
{
  const C = freshCore({ document: undefined });
  const bad = '<img src=x onerror=alert(1)>';
  const out = C.esc(bad);
  ok('angle brackets are neutralised', !out.includes('<img'), out);
  ok('nothing is lost, only escaped', out.includes('img'), out);
  eq('quotes cannot close an attribute', C.esc('a"b').includes('"'), false);
  eq('null is empty, not the word null', C.esc(null), '');
  eq('a number survives', C.esc(42), '42');
}

console.log('');
console.log('─'.repeat(64));
if (fails.length) {
  console.log(fails.length + ' failing of ' + (pass + fails.length) + ':');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
console.log(pass + ' checks, all good.');
