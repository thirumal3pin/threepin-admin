// ═══════ 3 PIN REALTY — FINANCE BANK ═══════
//
// Statement import and reconciliation for the bank account (1000) and the credit card (2300).
// The job is always the same shape: turn whatever file the bank handed us into a clean list of
// { date, desc, debit, credit, balance }, then decide which of those lines we have already
// posted to the ledger and which we have not.
//
// Like finance-core.js this module is deliberately Firebase-free, DOM-free and window-free, so
// the same code runs in the browser and under `node --test`. The only browser API it reaches
// for is DecompressionStream, which Node has had since 18 — that is what lets parseWorkbook()
// read .xlsx without a bundler or an xlsx library, neither of which this static site has.

import { A, num, bal } from './finance-core.js';

// ═══════ DELIMITED TEXT (CSV / TSV) ═══════
//
// Bank CSVs are not RFC 4180 tourists: HDFC ships tabs, some ICICI exports ship semicolons
// because they were generated on a comma-decimal locale, and narration fields regularly carry
// commas and the odd embedded newline. So we detect the delimiter rather than assume it, and
// parse by hand rather than split().

const DELIMS = [',', ';', '\t', '|'];

// Count each candidate delimiter across the header row only, ignoring anything inside quotes.
// The header row is the honest sample: it has one cell per column and no free-text narration
// to skew the counts.
function detectDelimiter(s) {
  const counts = Object.fromEntries(DELIMS.map(d => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQuotes && s[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') break;
    if (ch in counts) counts[ch]++;
  }
  let best = ',', bestN = 0;
  for (const d of DELIMS) if (counts[d] > bestN) { best = d; bestN = counts[d]; }
  return bestN ? best : ',';   // a single-column file still has to parse, so fall back to comma
}

export function parseDelimited(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // Excel's "CSV UTF-8" always writes a BOM
  const delim = detectDelimiter(s);

  const grid = [];
  let row = [], field = '', inQuotes = false, dirty = false;
  const endField = () => { row.push(field); field = ''; dirty = true; };
  const endRow = () => { endField(); grid.push(row); row = []; dirty = false; };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch !== '"') { field += ch; continue; }
      if (s[i + 1] === '"') { field += '"'; i++; continue; }   // "" is one escaped quote
      inQuotes = false;
      continue;
    }
    // A quote only opens a quoted field at the start of that field; anywhere else it is a
    // literal character, which is what mangled exports like 5" pipe actually mean.
    if (ch === '"' && field === '') { inQuotes = true; dirty = true; continue; }
    if (ch === delim) { endField(); continue; }
    if (ch === '\r') { if (s[i + 1] === '\n') i++; endRow(); continue; }
    if (ch === '\n') { endRow(); continue; }
    field += ch;
  }
  if (field !== '' || dirty || row.length) endRow();

  return shapeGrid(grid, 0);
}

// Split a raw grid into { headers, rows }: drop rows that are entirely blank (a trailing
// newline or a spacer line), and pad short rows out to the header width so a mapping index
// never reads undefined off the end of a row.
function shapeGrid(grid, headerAt) {
  const live = grid.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (!live.length) return { headers: [], rows: [] };
  const idx = Math.min(headerAt, live.length - 1);
  const headers = live[idx].map(h => String(h ?? '').trim());
  const width = live.reduce((w, r) => Math.max(w, r.length), headers.length);
  while (headers.length < width) headers.push('');
  const rows = live.slice(idx + 1).map(r => {
    const out = r.map(c => String(c ?? ''));
    while (out.length < width) out.push('');
    return out;
  });
  return { headers, rows };
}

// ═══════ XLSX ═══════
//
// An .xlsx is a ZIP of XML. There is no xlsx library here and no build step to add one, so we
// read the ZIP central directory ourselves and inflate each entry with the browser's own
// DecompressionStream('deflate-raw'). That is the whole trick — everything below it is just
// enough XML scraping to cover what a bank export actually contains. It is not a general xlsx
// reader and does not try to be: no charts, no pivot caches, no multi-sheet selection.
//
// Because inflation is stream-based, parseWorkbook is ASYNC. Callers must await it.

const ZIP_EOCD = 0x06054b50;
const ZIP_CDIR = 0x02014b50;

async function inflateRaw(bytes) {
  const src = new ReadableStream({
    start(c) { c.enqueue(bytes); c.close(); },
  });
  const reader = src.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Read the ZIP into { path: Uint8Array }. We go via the central directory rather than walking
// local headers because entries written with a streaming data descriptor carry zero sizes in
// their local header — the central directory is the copy that is always correct.
async function unzip(arrayBuffer) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot read .xlsx — please export the statement as CSV.');
  }
  const buf = new Uint8Array(arrayBuffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The end-of-central-directory record sits in the last 64KB + 22 bytes; scan backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (dv.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file is not a readable .xlsx workbook.');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = {};

  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (dv.getUint32(p, true) !== ZIP_CDIR) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const localAt = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;

    // ZIP64 uses 0xFFFFFFFF as an escape. No bank statement is 4GB, so say so plainly
    // rather than half-supporting it.
    if (csize === 0xFFFFFFFF || localAt === 0xFFFFFFFF) continue;

    // Only the handful of parts we actually read, so a 40-sheet workbook stays cheap.
    if (!/^xl\/(worksheets\/|sharedStrings\.xml|styles\.xml|workbook\.xml|_rels\/workbook\.xml\.rels)/.test(name)) continue;

    const lNameLen = dv.getUint16(localAt + 26, true);
    const lExtraLen = dv.getUint16(localAt + 28, true);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    files[name] = method === 0 ? raw : await inflateRaw(raw);
  }
  return { files, decode: b => (b ? dec.decode(b) : '') };
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10));
  return e in XML_ENT ? XML_ENT[e] : m;
});

// \b keeps a short name honest: without it, looking for `s` would happily match the `s="` of
// some longer attribute that merely ends in s.
const attr = (tag, name) => {
  const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
  return m ? unxml(m[1]) : null;
};

// "BC7" -> 54. Excel writes the reference on every non-empty cell, and honouring it is the
// only way blank cells stop shifting every later column one place to the left.
function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

// Excel day 0 is 1899-12-30, not 1900-01-01, because Excel wrongly believes 1900 was a leap
// year. Anchoring two days early makes every date from 1900-03-01 onward — i.e. every date a
// bank will ever print — come out correct.
export function excelSerialToDate(serial) {
  const n = Number(serial);
  if (!isFinite(n) || n <= 0) return null;
  const days = Math.floor(n + 1e-9);
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// A plausible statement date as an Excel serial: 20000 is 1954, 60000 is 2064. Anything
// outside that is an amount, a cheque number or a running balance, not a date.
const SERIAL_LO = 20000, SERIAL_HI = 60000;
const isSerialish = v => {
  const n = Number(String(v).trim());
  return isFinite(n) && n >= SERIAL_LO && n <= SERIAL_HI;
};

// numFmtIds Excel reserves for date and time formats. Anything at 164+ is user-defined and
// has to be judged from its format code.
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function readStyles(xml) {
  if (!xml) return () => false;
  const custom = {};
  for (const m of xml.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode') || '';
    if (isFinite(id)) custom[id] = code;
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  const xfs = block
    ? [...block[1].matchAll(/<xf\b[^>]*?\/?>/g)].map(m => Number(attr(m[0], 'numFmtId') || 0))
    : [];
  return styleIdx => {
    const id = xfs[Number(styleIdx) || 0];
    if (!isFinite(id)) return false;
    if (BUILTIN_DATE_FMT.has(id)) return true;
    const code = custom[id];
    if (!code) return false;
    // Strip quoted literals, [colour]/[locale] blocks and backslash escapes before looking for
    // date letters, otherwise a currency format like [$₹-en-IN]#,##0.00 reads as a "d" format.
    const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[dmyh]/i.test(bare);
  };
}

function readSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    let s = '';
    // Rich text splits one string across several <r><t> runs; concatenating them back is
    // exactly what the displayed cell shows.
    for (const t of (m[1] || '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
    out.push(unxml(s));
  }
  return out;
}

// Which worksheet part is the first tab? workbook.xml lists sheets in tab order and its rels
// file maps each r:id to a part name. If any of that is missing we fall back to sheet1.xml,
// which is what every bank export we have seen actually ships.
function firstSheetPath(files, decode) {
  const wb = decode(files['xl/workbook.xml']);
  const rels = decode(files['xl/_rels/workbook.xml.rels']);
  const sheet = wb && /<sheet\b[^>]*\/?>/.exec(wb);
  const rid = sheet && attr(sheet[0], 'r:id');
  if (rid && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
      if (attr(m[0], 'Id') !== rid) continue;
      const target = String(attr(m[0], 'Target') || '').replace(/^\/?xl\//, '').replace(/^\.\//, '');
      const path = 'xl/' + target;
      if (files[path]) return path;
    }
  }
  if (files['xl/worksheets/sheet1.xml']) return 'xl/worksheets/sheet1.xml';
  return Object.keys(files).find(k => /^xl\/worksheets\/.*\.xml$/.test(k)) || null;
}

export async function parseWorkbook(arrayBuffer) {
  const { files, decode } = await unzip(arrayBuffer);
  const path = firstSheetPath(files, decode);
  if (!path) throw new Error('That workbook has no readable worksheet.');

  const sst = readSharedStrings(decode(files['xl/sharedStrings.xml']));
  const isDateStyle = readStyles(decode(files['xl/styles.xml']));
  const xml = decode(files[path]);

  const grid = [];
  let autoRow = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rowAttrs = rm[1] ?? rm[3] ?? '';
    const declared = Number(attr('<row ' + rowAttrs + '>', 'r'));
    const r = isFinite(declared) && declared > 0 ? declared - 1 : autoRow;
    autoRow = r + 1;
    const cells = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const a = cm[1] ?? cm[2] ?? '';
      const body = cm[3] || '';
      const tag = '<c ' + a + '>';
      const ref = attr(tag, 'r');
      const ci = ref ? colIndex(ref) : cells.length;
      const type = attr(tag, 't') || 'n';
      const style = attr(tag, 's');
      const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      const v = vm ? unxml(vm[1]) : '';

      let out = '';
      if (type === 's') {
        out = sst[Number(v)] ?? '';
      } else if (type === 'inlineStr') {
        let s = '';
        for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
        out = unxml(s);
      } else if (type === 'str' || type === 'e') {
        out = v;                                   // cached formula result / error text
      } else if (type === 'b') {
        out = v === '1' ? 'TRUE' : 'FALSE';
      } else {
        // Numeric. A date in Excel is a number wearing a date number-format, so the style is
        // the only signal at this point; the header-driven pass below catches the rest.
        out = (v !== '' && isDateStyle(style) && isSerialish(v)) ? (excelSerialToDate(v) || v) : v;
      }
      if (ci >= 0) cells[ci] = out;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    grid[r] = cells;
  }
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];

  // Workbook exports usually open with a merged title and an account-details block before the
  // real table starts, so the header is the first row with at least two filled cells rather
  // than simply row 1. (parseDelimited stays literal — a CSV's first row IS its header.)
  const live = grid.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  let headerAt = 0;
  for (let i = 0; i < live.length; i++) {
    if (live[i].filter(c => String(c ?? '').trim() !== '').length >= 2) { headerAt = i; break; }
  }
  const shaped = shapeGrid(live, headerAt);

  // Second date pass: a bank that formats its date column as "General" leaves us a bare serial.
  // Any column whose HEADER says date, and whose value sits in the plausible serial window,
  // is safe to convert — an amount never lands in 20000..60000 by coincidence often enough to
  // matter, and if it did the header would not say "date".
  shaped.headers.forEach((h, i) => {
    if (!looksLikeDateHeader(h)) return;
    for (const row of shaped.rows) {
      if (/^\s*-?\d+(\.\d+)?\s*$/.test(row[i] || '') && isSerialish(row[i])) {
        row[i] = excelSerialToDate(row[i]) || row[i];
      }
    }
  });
  return shaped;
}

// ═══════ COLUMN MAPPING ═══════
//
// Two layouts cover almost every Indian bank and card statement:
//   (a) Date | Narration | Withdrawal Amt | Deposit Amt | Closing Balance   — HDFC, SBI, Axis
//   (b) Date | Particulars | Amount | Dr/Cr | Balance                        — ICICI, some cards
// Detect which one we have from the headers, and only sniff the data when the headers are
// unhelpful (blank, numbered, or in a language we do not recognise).

const norm = h => String(h ?? '').toLowerCase().replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

const HEADER_HINTS = {
  date: [/transaction date/, /txn date/, /tran date/, /value date/, /posting date/, /\bdate\b/],
  // Checked before debit/credit, because a "Dr/Cr" column would otherwise be claimed as the
  // credit column on the strength of the letters "cr".
  drcr: [/dr\s*\/\s*cr/, /cr\s*\/\s*dr/, /debit\s*\/\s*credit/, /credit\s*\/\s*debit/,
    /transaction type/, /txn type/, /\bindicator\b/, /^type$/],
  balance: [/closing balance/, /running balance/, /available balance/, /\bbalance\b/, /^bal$/],
  // Bare "dr" and "cr" are anchored rather than substring-matched: as a substring "dr" hits
  // "address" and "cr" hits "credit card no".
  debit: [/withdrawal amt/, /withdrawal amount/, /withdrawal/, /debit amount/, /debit amt/,
    /\bdebit\b/, /paid out/, /^dr$/, /^dr amt$/, /^dr amount$/],
  credit: [/deposit amt/, /deposit amount/, /deposit/, /credit amount/, /credit amt/,
    /\bcredit\b/, /paid in/, /^cr$/, /^cr amt$/, /^cr amount$/],
  amount: [/transaction amount/, /\bamount\b/, /^amt$/, /\bamt\b/],
  desc: [/description/, /narration/, /particulars/, /transaction remarks/, /remarks/, /details/],
};

export const looksLikeDateHeader = h => HEADER_HINTS.date.some(re => re.test(norm(h)));

const looksNumeric = v => {
  const s = String(v ?? '').trim();
  if (!s) return false;
  return /^[(\-+]?\s*(₹|rs\.?|inr)?\s*[\d,]+(\.\d+)?\s*\)?\s*(dr|cr)?\.?$/i.test(s) && /\d/.test(s);
};

export function detectMapping(headers, rows) {
  const hs = (headers || []).map(norm);
  const m = { date: null, desc: null, debit: null, credit: null, balance: null, amount: null, drcr: null };
  const taken = new Set();

  // Order matters: the more specific roles claim their column before the greedier ones get to
  // look at it.
  for (const role of ['date', 'drcr', 'balance', 'debit', 'credit', 'amount', 'desc']) {
    for (const re of HEADER_HINTS[role]) {
      const i = hs.findIndex((h, k) => !taken.has(k) && h && re.test(h));
      if (i >= 0) { m[role] = i; taken.add(i); break; }
    }
  }

  // Layout (a) wins outright when both money columns are present: an extra "Amount" or "Type"
  // column on such a statement is decoration, and honouring it would double-count.
  if (m.debit !== null && m.credit !== null) { m.amount = null; m.drcr = null; }
  // A Dr/Cr flag only means anything beside a single Amount column. Beside its own debit and
  // credit columns it is a stray "Type" column, and following it would flip good rows.
  else if (m.amount === null && (m.debit !== null || m.credit !== null)) m.drcr = null;

  const headerFoundDate = m.date !== null;
  const headerFoundMoney = m.debit !== null || m.credit !== null || m.amount !== null;

  const sample = (rows || []).slice(0, 30).filter(r => r.some(c => String(c ?? '').trim() !== ''));
  const width = sample.reduce((w, r) => Math.max(w, r.length), hs.length);

  // ─ Fallback sniffing ─ only for the roles the headers did not fill.
  if (m.date === null) {
    // Written-out dates beat bare Excel serials, because a balance column of five-digit
    // figures also "parses as a date" through the serial window. Only settle for a numeric
    // column when nothing spelled a date out.
    const tier = [[], []];
    for (let c = 0; c < width; c++) {
      if (taken.has(c)) continue;
      const vals = sample.map(r => String(r[c] ?? '').trim()).filter(Boolean);
      if (!vals.length) continue;
      const hits = vals.filter(v => parseDate(v)).length / vals.length;
      if (hits < 0.6) continue;
      const numericish = vals.filter(looksNumeric).length / vals.length > 0.5;
      tier[numericish ? 1 : 0].push({ c, hits });
    }
    const pick = (tier[0].length ? tier[0] : tier[1]).sort((a, b) => b.hits - a.hits)[0];
    if (pick) { m.date = pick.c; taken.add(pick.c); }
  }

  if (!headerFoundMoney) {
    const numeric = [];
    for (let c = 0; c < width; c++) {
      if (taken.has(c) || c === m.date) continue;
      const vals = sample.map(r => String(r[c] ?? '').trim()).filter(Boolean);
      if (!vals.length) continue;
      if (vals.filter(looksNumeric).length / vals.length >= 0.8) numeric.push(c);
    }
    // The running balance is conventionally the rightmost figure on the line, so read the
    // money columns off the ends: withdrawal, deposit, ... balance.
    if (numeric.length >= 3) {
      m.debit = numeric[0]; m.credit = numeric[1]; m.balance = numeric[numeric.length - 1];
    } else if (numeric.length === 2) {
      m.amount = numeric[0]; m.balance = numeric[1];
    } else if (numeric.length === 1) {
      m.amount = numeric[0];
    }
    [m.debit, m.credit, m.balance, m.amount].forEach(i => { if (i !== null && i !== undefined) taken.add(i); });
  }

  if (m.desc === null) {
    // Whatever is left that carries the most text is the narration.
    let best = -1, bestLen = 0;
    for (let c = 0; c < width; c++) {
      if (taken.has(c) || c === m.date) continue;
      const vals = sample.map(r => String(r[c] ?? '').trim()).filter(Boolean);
      if (!vals.length || vals.filter(looksNumeric).length / vals.length > 0.5) continue;
      const avg = vals.reduce((s, v) => s + v.length, 0) / vals.length;
      if (avg > bestLen) { bestLen = avg; best = c; }
    }
    if (best >= 0) m.desc = best;
  }

  m.confidence = (headerFoundDate && headerFoundMoney) ? 'high' : 'low';
  return m;
}

// ═══════ VALUE PARSING ═══════

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const iso = (y, mo, d) => {
  if (!(y >= 1900 && y <= 2200) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  // Reject 31 April and 30 February rather than letting Date roll them into the next month.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

// Two-digit years on a statement are always recent; 70 is a comfortable pivot for a company
// whose books start in 2026.
const wideYear = y => (y >= 100 ? y : (y < 70 ? 2000 + y : 1900 + y));

export function parseDate(value) {
  if (value === null || value === undefined) return null;

  // A bare number in the serial window is an unformatted Excel date. This is where the
  // "numeric value in the mapped date column" rule lands, because parseDate is only ever
  // called on the column detectMapping picked as the date.
  if (typeof value === 'number' || /^\s*\d+(\.\d+)?\s*$/.test(String(value))) {
    return isSerialish(value) ? excelSerialToDate(value) : null;
  }

  let s = String(value).trim();
  if (!s) return null;
  s = s.split(/[T ]/)[0];                       // drop any time-of-day tail
  s = s.replace(/[^0-9A-Za-z/\-.]/g, '');

  let m;
  // ISO first — it is the only unambiguous form, so it never reaches the day-first rules.
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) {
    return iso(+m[1], +m[2], +m[3]);
  }
  // DD-MMM-YYYY / DD MMM YY — 05-Sep-2026.
  if ((m = /^(\d{1,2})[-/.]?([A-Za-z]{3,9})[-/.]?(\d{2,4})$/.exec(s))) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? iso(wideYear(+m[3]), mo, +m[1]) : null;
  }
  // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YY. Indian statements are DAY-FIRST, always: 05/09/2026 is
  // 5 September, never 9 May. Never "helpfully" fall back to month-first when the first number
  // is <= 12 — that silently mis-dates exactly the rows a human would not notice.
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s))) {
    return iso(wideYear(+m[3]), +m[2], +m[1]);
  }
  // DDMMYYYY, run together by some card exports.
  if ((m = /^(\d{2})(\d{2})(\d{4})$/.exec(s))) {
    return iso(+m[3], +m[2], +m[1]);
  }
  return null;
}

export function parseAmount(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return isFinite(value) ? value : 0;

  let s = String(value).trim();
  if (!s) return 0;

  // A Dr/Cr marker is the bank telling us the direction of a magnitude-only figure. It shows up
  // on either end depending on the bank, with or without a space: "1,234.56 Dr", "1234.56Cr",
  // "Dr 1,234.56". Anchoring on the adjacent digit or bracket stops it eating part of the
  // number itself.
  let sign = 1;
  const tail = /([\d)])\s*(dr|cr)\.?$/i.exec(s);
  if (tail) {
    sign = tail[2].toLowerCase() === 'dr' ? -1 : 1;
    s = s.slice(0, tail.index + 1);
  } else {
    const head = /^(dr|cr)\.?\s*(?=[\d(₹])/i.exec(s);
    if (head) { sign = head[1].toLowerCase() === 'dr' ? -1 : 1; s = s.slice(head[0].length); }
  }
  // Accountants' parentheses mean negative.
  if (/^\(.*\)$/.test(s.trim())) { sign = -Math.abs(sign); s = s.trim().slice(1, -1); }

  // The odd space class is deliberate: Excel and several bank portals group digits with a
  // non-breaking or thin space, which Number() will not forgive.
  s = s.replace(/₹|rs\.?|inr/gi, '').replace(/[,\s   ]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { sign = -sign; s = s.slice(0, -1); }   // trailing-minus exports

  const n = Number(s);
  if (!isFinite(n)) return 0;
  return sign < 0 ? -Math.abs(n) : n;
}

// ═══════ ROW BUILDING ═══════

// "DEP" has to be tested before the generic "d", or every deposit is read as a debit — the one
// trap in this whole function.
function drcrIsDebit(token) {
  const t = String(token ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return null;
  if (t.startsWith('dep')) return false;
  if (t.startsWith('d') || t.startsWith('w')) return true;    // DR, DEBIT, WD, WITHDRAWAL
  if (t.startsWith('c')) return false;                        // CR, CREDIT
  return null;
}

export function buildRows(parsed, mapping) {
  const rows = [];
  const src = (parsed && parsed.rows) || [];
  const m = mapping || {};
  const cell = (r, i) => (i === null || i === undefined ? '' : String(r[i] ?? ''));

  src.forEach((r, i) => {
    // No parseable date means this is not a transaction line: it is the account-details block,
    // a column header repeated mid-page, a "carried forward" rule or the totals footer.
    const date = parseDate(cell(r, m.date));
    if (!date) return;

    let debit = 0, credit = 0;
    if (m.debit !== null && m.debit !== undefined || m.credit !== null && m.credit !== undefined) {
      debit = Math.abs(parseAmount(cell(r, m.debit)));
      credit = Math.abs(parseAmount(cell(r, m.credit)));
    } else if (m.amount !== null && m.amount !== undefined) {
      // Single-amount layout: the Dr/Cr flag decides the side. Where there is no flag, fall
      // back to the sign the bank put on the figure itself.
      const amt = parseAmount(cell(r, m.amount));
      const flag = drcrIsDebit(cell(r, m.drcr));
      const isDebit = flag === null ? amt < 0 : flag;
      if (isDebit) debit = Math.abs(amt); else credit = Math.abs(amt);
    }

    rows.push({
      id: 'r' + i,
      srcRow: i,
      date,
      desc: cell(r, m.desc).replace(/\s+/g, ' ').trim(),
      debit,
      credit,
      balance: (m.balance === null || m.balance === undefined) ? null : parseAmount(cell(r, m.balance)),
    });
  });
  return rows;
}

// ═══════ MATCHING ═══════
//
// SIGN CONVENTION — the easiest thing in this file to get backwards, so spelled out in full.
//
// Account 1000 Bank is an ASSET. Money arriving is a statement CREDIT, and in the ledger it is
// a DEBIT on 1000 (dr 1000 / cr 4000 for a receipt). So the statement's movement is
// credit − debit, and the txn's movement is Σdr − Σcr. A ₹50,000 receipt: statement
// 0 − 50000 → +50000; txn +50000 − 0 → +50000. They agree.
//
// Account 2300 Credit card is a LIABILITY. A purchase is a statement DEBIT — it increases what
// we owe — and in the ledger it is a CREDIT on 2300 (dr 5080 / cr 2300). So the statement's
// movement is debit − credit, and the txn's movement is measured the way finance-core's bal()
// measures a liability, credit-positive: Σcr − Σdr. A ₹2,000 subscription charge: statement
// 2000 − 0 → +2000; txn 2000 − 0 → +2000. They agree.
//
// One `sign` flips both halves at once, which is why the two cases stay in step: for an asset
// sign = +1 (movement = Σdr − Σcr, statement = credit − debit), for a liability sign = −1
// (movement = Σcr − Σdr, statement = debit − credit).

const accountSign = code => (A[code] && (A[code].type === 'asset' || A[code].type === 'expense')) ? 1 : -1;

const dayNum = d => {
  const p = String(d ?? '').split('-').map(Number);
  if (p.length !== 3 || p.some(x => !isFinite(x))) return NaN;
  return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000;
};

const TOL = 1;        // ₹1 — enough to absorb a rounded paisa, tight enough to stay honest
const WINDOW = 3;     // days either side: UPI clears same day, cheques and cards drift

// Net movement of one txn on one account, in the same direction as the statement reads it.
function txnMovement(t, account, sign) {
  let dr = 0, cr = 0, touches = false;
  for (const l of (t.lines || [])) {
    if (l.acc !== account) continue;
    touches = true;
    dr += num(l.dr); cr += num(l.cr);
  }
  return touches ? sign * (dr - cr) : null;
}

export function autoMatch(rows, txns, account) {
  const sign = accountSign(account);
  const list = rows || [];

  // Candidates: every txn that moves this account. A txn that debits and credits the same
  // account to a net zero (an internal correction) can never correspond to a statement line.
  const cands = [];
  (txns || []).forEach((t, i) => {
    const movement = txnMovement(t, account, sign);
    if (movement === null || Math.abs(movement) < 0.005) return;
    cands.push({ key: t.id ?? ('#' + i), txn: t, movement, day: dayNum(t.date) });
  });

  for (const r of list) { r.matchedTxnId = null; r.status = 'unmatched'; r.confidence = null; }

  // The statement's own movement, in the direction described in the block above.
  const want = r => sign > 0
    ? num(r.credit) - num(r.debit)
    : num(r.debit) - num(r.credit);

  const used = new Set();
  const take = (row, cand, confidence) => {
    row.matchedTxnId = cand.txn.id ?? null;
    row.status = 'matched';
    row.confidence = confidence;
    used.add(cand.key);
  };

  // Pass 1 — same-day matches first, across the whole statement, so a near-date row can never
  // steal the txn that some other row matches exactly.
  for (const r of list) {
    const target = want(r);
    const hit = cands.find(c => !used.has(c.key) && c.txn.date === r.date && Math.abs(c.movement - target) <= TOL);
    if (hit) take(r, hit, 'exact');
  }

  // Pass 2 — ±3 days. Score every surviving (row, txn) pair and assign the closest first, so
  // the greedy walk does not hand a 3-day-old txn to the first row that could take it.
  const pairs = [];
  for (const r of list) {
    if (r.status === 'matched') continue;
    const target = want(r), rd = dayNum(r.date);
    if (!isFinite(rd)) continue;
    for (const c of cands) {
      if (used.has(c.key)) continue;
      const gap = Math.abs(c.day - rd);
      const diff = Math.abs(c.movement - target);
      if (!isFinite(gap) || gap > WINDOW || diff > TOL) continue;
      pairs.push({ r, c, gap, diff });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.diff - b.diff);
  for (const p of pairs) {
    if (p.r.status === 'matched' || used.has(p.c.key)) continue;
    take(p.r, p.c, 'near');
  }

  return {
    rows: list,
    matched: list.filter(r => r.status === 'matched'),
    unmatched: list.filter(r => r.status !== 'matched'),
  };
}

// The other half of the reconciliation: entries we posted that the bank never showed us —
// a cheque issued but not presented, a card charge posted early, or a duplicate. Returns the
// txns themselves with their movement on the account attached, ready to list.
export function bookEntriesWithoutStatement(txns, rows, account, from, upto) {
  const sign = accountSign(account);
  const claimed = new Set((rows || []).map(r => r.matchedTxnId).filter(id => id !== null && id !== undefined));
  const out = [];
  for (const t of (txns || [])) {
    const d = String(t.date || '');
    if (from && d < from) continue;
    if (upto && d > upto) continue;
    if (claimed.has(t.id)) continue;
    const movement = txnMovement(t, account, sign);
    if (movement === null || Math.abs(movement) < 0.005) continue;
    out.push({ ...t, movement });
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// ═══════ SUMMARY ═══════

// bookBalance comes from finance-core's bal(), which reads the shared in-memory state rather
// than the `txns` argument — that keeps this figure identical to the one the Overview and the
// balance sheet show, so a reconciliation can never disagree with the rest of the app. `txns`
// is still used, for the count of book entries the statement never mentioned.
//
// Both sides are naturally positive: bal('1000') is cash we hold, bal('2300') is the amount
// outstanding on the card — which is how a card statement prints its closing balance too.
export function reconcileSummary(rows, txns, account, closingBalance, asOf) {
  const statementClosing = num(closingBalance);
  const bookBalance = bal(account, { upto: asOf });
  const difference = statementClosing - bookBalance;
  const unmatchedCount = (rows || []).filter(r => r.status !== 'matched').length;
  return {
    statementClosing,
    bookBalance,
    difference,
    unmatchedCount,
    bookOnlyCount: bookEntriesWithoutStatement(txns, rows, account, null, asOf).length,
    // Reconciled means BOTH halves agree: the closing figure ties AND every statement line has
    // been accounted for. A tie with unmatched lines left over is two errors cancelling out.
    reconciled: Math.abs(difference) < 1 && unmatchedCount === 0,
  };
}
