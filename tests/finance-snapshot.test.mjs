// ═══════ THE SERVER-SIDE LEDGER SNAPSHOT ═══════
//
// The nightly digest reads the book from a compacted snapshot rather than from every
// collection, so the codec that writes it is load-bearing: a snapshot that decodes to
// something slightly different from what went in would move numbers in an email nobody
// cross-checks against the app.
//
//   node tests/finance-snapshot.test.mjs

import { encode, decode } from '../api/_finance-snapshot.js';

let passed = 0, failed = 0;
const fail = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log('  ok    ' + label); return; }
  failed++; fail.push(label + (detail ? ' — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
};
const section = n => console.log('\n── ' + n);

// Firestore's own limits, which are what the chunking exists to respect.
const MAX_INDEX_ENTRY = 7.5 * 1024;
const MAX_DOC = 1024 * 1024;
const PIECES_PER_DOC = 200;

section('Round trip');

const simple = [
  { id: 'a1', no: 1, desc: 'Opening balances', lines: [{ acc: '1000', dr: 50000 }, { acc: '3100', cr: 50000 }] },
  { id: 'a2', no: 2, desc: 'Rent', lines: [{ acc: '5010', dr: 25000 }, { acc: '1000', cr: 25000 }] },
];
check('A small book survives encode → decode', JSON.stringify(decode(encode(simple))) === JSON.stringify(simple));
check('An empty collection survives', JSON.stringify(decode(encode([]))) === '[]');

section('Characters that break naive chunking');

// The reason the payload is base64 and not raw JSON: a rupee sign is three bytes of UTF-8 in
// one JavaScript character, so slicing a JSON string by character count can put a fraction of
// a character at a boundary and produce a chunk that no longer decodes. Base64 is ASCII, so
// character count and byte count are the same number and no boundary can split anything.
const unicode = [
  { id: 'u1', desc: 'Rent ₹25,000 — வாடகை', party: 'ஸ்ரீ ராம்', note: '日本語テスト' },
  { id: 'u2', desc: 'Fee €1.500,00 · £900 · ₹1,00,000', emoji: '🧾📊' },
  { id: 'u3', desc: 'quote " backslash \\ newline \n tab \t' },
];
const back = decode(encode(unicode));
check('Rupee signs, Tamil, Japanese and emoji come back identical',
  JSON.stringify(back) === JSON.stringify(unicode));
check('Quotes, backslashes and control characters come back identical',
  back[2].desc === unicode[2].desc);

section('Timestamps');

// Firestore Timestamps are packed to {__ts:{...}} by the caller before encoding. The codec
// must carry that structure through untouched — it is what the reader rebuilds real
// Timestamps from, and a book whose dates decoded to plain objects would break every report.
const stamped = [{ id: 't1', updatedAt: { __ts: { seconds: 1757000000, nanoseconds: 123456000 } } }];
const ts = decode(encode(stamped))[0].updatedAt;
check('A packed timestamp keeps its seconds', ts.__ts.seconds === 1757000000);
check('A packed timestamp keeps its nanoseconds', ts.__ts.nanoseconds === 123456000);

section('Chunk shape at ledger scale');

// Five thousand entries is a few years of a working agency's books — the size at which the
// old design's cost became the reason any of this was written.
const big = Array.from({ length: 5000 }, (_, i) => ({
  id: 'txn' + i,
  no: i + 1,
  date: '2026-0' + ((i % 9) + 1) + '-15',
  event: 'expense',
  desc: 'Vendor payment ₹' + (1000 + i) + ' for site visit and documentation',
  lines: [{ acc: '5010', dr: 1000 + i }, { acc: '1000', cr: 1000 + i }],
  totals: { dr: 1000 + i, cr: 1000 + i },
  createdBy: '3pinrentals@gmail.com',
  createdAt: 1757000000000 + i,
  updatedAt: { __ts: { seconds: 1757000000 + i, nanoseconds: 0 } },
}));

const pieces = encode(big);
const rawBytes = Buffer.byteLength(JSON.stringify(big), 'utf8');
const packedBytes = pieces.join('').length;

check('Every piece is within Firestore\'s 7.5 KiB index-entry limit',
  pieces.every(p => Buffer.byteLength(p, 'utf8') <= MAX_INDEX_ENTRY),
  'largest ' + Math.max(...pieces.map(p => Buffer.byteLength(p, 'utf8'))));
check('Every piece is pure ASCII, so length is byte length',
  pieces.every(p => !/[^\x00-\x7F]/.test(p)));

// Each document holds PIECES_PER_DOC pieces, and must stay inside the 1 MiB document limit
// with room for the field names and the rest of the document around it.
const docCount = Math.ceil(pieces.length / PIECES_PER_DOC);
const biggestDoc = Math.max(...Array.from({ length: docCount }, (_, i) =>
  pieces.slice(i * PIECES_PER_DOC, (i + 1) * PIECES_PER_DOC).join('').length));
check('Every snapshot document is within the 1 MiB limit', biggestDoc <= MAX_DOC * 0.85,
  Math.round(biggestDoc / 1024) + ' KiB');

check('5,000 entries round-trip byte-identical',
  JSON.stringify(decode(pieces)) === JSON.stringify(big));

console.log(`\n  5,000 entries: ${Math.round(rawBytes / 1024)} KiB of JSON → ` +
  `${Math.round(packedBytes / 1024)} KiB packed (${(rawBytes / packedBytes).toFixed(1)}× smaller), ` +
  `${pieces.length} pieces across ${docCount} document${docCount === 1 ? '' : 's'}`);
console.log(`  the whole book is therefore ${docCount + 1} reads to load, not ${big.length}`);

section('Corruption is detected, not silently accepted');

// A torn snapshot must throw rather than decode to something plausible — loadBooks catches
// that and falls back to reading the collections, which is the behaviour that keeps a bad
// cache from becoming bad numbers.
let threw = false;
try { decode(pieces.slice(0, pieces.length - 1)); } catch { threw = true; }
check('A snapshot missing its last piece refuses to decode', threw);

threw = false;
try { decode(['not-base64-at-all!!!']); } catch { threw = true; }
check('Rubbish in place of a snapshot refuses to decode', threw);

console.log('\n──────────────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\n' + fail.map(f => '  · ' + f).join('\n')); process.exit(1); }
console.log('All green.');
