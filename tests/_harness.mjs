// ═══════ TEST HARNESS ═══════
//
// Mirrors finance-sync.js save() / reverse() / runMonthEnd() without Firebase, line for
// line where it matters: resolve parties, validate the form, build, normalise, validate the
// journal, post, create documents (with the same id-linking a Firestore save does), apply
// updates, apply allocations, number invoices. A change in finance-sync.js that this does
// not reflect shows up as a behaviour difference in the tests rather than passing silently.
//
// Shared by every test file so there is exactly one mirror to keep honest.

import {
  today,
  ym,
  getState, setState, blank, defaultSettings, normalise, validate, reversalLines,
  fyOf, num, fmt, monthEndEntries, docStatus,
} from '../finance-assets/finance-core.js';
import { EV, PARTY_FIELDS, validateEvent } from '../finance-assets/finance-events.js';

// ═══════ TINY TEST RUNNER ═══════

export let passed = 0, failed = 0;
export const failures = [];

export function check(label, condition, detail) {
  if (condition) { passed++; return true; }
  failed++;
  failures.push(`${label}${detail ? ' — ' + detail : ''}`);
  console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

// Money comparisons tolerate a paisa of float drift; anything larger is a real bug.
export const near = (a, b, tol = 0.02) => Math.abs(num(a) - num(b)) <= tol;

export function eq(label, actual, expected, tol) {
  return check(label, near(actual, expected, tol), `got ${fmt(actual)} (${actual}), expected ${fmt(expected)} (${expected})`);
}

export function section(name) { console.log(`\n── ${name}`); }

// Expect a save to be refused, and say why it was not.
export function refuses(label, fn, wantMsg) {
  try { fn(); }
  catch (e) {
    const ok = !wantMsg || String(e.message).toLowerCase().includes(String(wantMsg).toLowerCase());
    return check(label, ok, `refused with "${e.message}"`);
  }
  return check(label, false, 'was accepted');
}

export function report() {
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`${passed} passed, ${failed} failed  ·  ${getState().txns.length} entries posted`);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('All green.');
}

// ═══════ STATE ═══════

let seq = 0;
let txnNo = 0;
const nid = p => `${p}${String(++seq).padStart(4, '0')}`;
const r2 = x => Math.round(num(x) * 100) / 100;

export function fresh(settings = {}) {
  seq = 0; txnNo = 0;
  const s = blank();
  s.settings = { ...defaultSettings(), booksStartDate: '2026-09-01', tdsEnabled: false, ...settings };
  setState(s);
  return s;
}

export const byName = (arr, name) => arr.find(x => x.name === name || x.nickname === name);
export const party = name => getState().parties.find(p => p.name === name)?.id;

function resolveParty(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const s = getState();
  const hit = s.parties.find(p => p.name.trim().toLowerCase() === String(value.name).trim().toLowerCase());
  if (hit) return hit.id;
  const id = nid('P');
  s.parties.push({ id, name: String(value.name).trim(), type: value.type || 'other', phone: '', state: value.state || '' });
  return id;
}

function applyUpdate(obj, data) {
  // Firestore treats a dotted key as a nested path; charges.2026-09 must not create a
  // literal "charges.2026-09" property or confirmcharge silently stops working.
  for (const [k, v] of Object.entries(data)) {
    if (k.includes('.')) {
      const keys = k.split('.');
      let node = obj;
      keys.slice(0, -1).forEach(key => { node = node[key] = node[key] || {}; });
      node[keys.at(-1)] = v;
    } else obj[k] = v;
  }
}

const COLL_KEY = {
  deals: 'deals', subscriptions: 'subs', loans: 'loans', assets: 'assets', parties: 'parties',
  bills: 'bills', invoices: 'invoices',
};

// '$bill' inside a document or update becomes the id of the bill created by the same save.
function link(val, keyIds) {
  if (typeof val === 'string' && keyIds[val] !== undefined) return keyIds[val];
  if (Array.isArray(val)) return val.map(x => link(x, keyIds));
  if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).map(([k, x]) => [k, link(x, keyIds)]));
  return val;
}

// Mirrors the form: seed the defaults of every visible field the caller did not supply and
// run the event's onchange for each, exactly as buildForm() does, so a test that passes only
// what a person would type gets the same derived values (GST total, allocation) the screen
// would. Pass {raw:true} to skip this and hand build() the values untouched.
function seedLikeTheForm(evKey, v) {
  const ev = EV[evKey];
  const fields = typeof ev.fields === 'function' ? ev.fields(v) : ev.fields;
  for (const f of fields) {
    if (typeof f.show === 'function' && !f.show(v)) continue;
    if (v[f.k] !== undefined) continue;
    if (f.type === 'select') {
      const opts = typeof f.opts === 'function' ? f.opts(v) : (f.opts || []);
      v[f.k] = f.def ?? (opts[0] ? opts[0][0] : '');
    } else if (f.def !== undefined) v[f.k] = f.def;
    else continue;
    ev.onchange?.(f.k, v);
  }
}

export function save(evKey, values, opts = {}) {
  const s = getState();
  const ev = EV[evKey];
  if (!ev) throw new Error('Unknown event ' + evKey);
  const v = { ...values };

  for (const k of (PARTY_FIELDS[evKey] || [])) v[k] = resolveParty(v[k]);
  if (evKey === 'card2emi') v.__lender = resolveParty({ __new: true, name: 'Card EMI', type: 'lender' });

  // The form's onchange chain, so a test can type what a person types: the party, and let
  // the allocation and the total work themselves out.
  if (!opts.raw) {
    for (const k of Object.keys(values)) ev.onchange?.(k, v);
    seedLikeTheForm(evKey, v);
    for (const k of Object.keys(values)) v[k] = values[k] === undefined ? v[k] : (PARTY_FIELDS[evKey] || []).includes(k) ? v[k] : values[k];
    // Party values were resolved above and must not be clobbered; everything else the caller
    // typed wins over anything onchange derived from a default.
    if (values.alloc === undefined) { ev.onchange?.('amt', v); }
  }

  // The same gate as finance-sync.js: the form's field checks, warnings excluded.
  const problems = validateEvent(evKey, v).filter(p => !p.warn);
  if (problems.length) throw new Error(problems[0].msg);

  const out = ev.build(v);
  if (out.incomplete) throw new Error(out.effects[0]);

  const lines = normalise(out.lines || []);
  const allocations = out.allocations || [];
  const docs = out.docs || [];
  const updates = out.updates || [];
  if (!lines.length && !docs.length && !updates.length) throw new Error('Nothing to save');

  const postDate = out.postDate || v.date;
  let txnId = null, no = null;
  if (lines.length) {
    validate({ ...out, date: postDate, lines });
    txnId = nid('TX');
    no = ++txnNo;
    s.txns.push({
      id: txnId, no, date: postDate, event: evKey, desc: out.desc, lines,
      totals: {
        dr: r2(lines.reduce((a, l) => a + num(l.dr), 0)),
        cr: r2(lines.reduce((a, l) => a + num(l.cr), 0)),
      },
      meta: Object.fromEntries(Object.entries(v).filter(([k, x]) => x != null && typeof x !== 'object' && !k.startsWith('__') && k !== 'alloc')),
      attachments: [], auto: false,
      allocations: allocations.map(a => ({ coll: a.coll, id: a.id, amt: a.amt })),
      fy: fyOf(postDate, s.settings.fyStartMonth), createdBy: 'test', createdAt: Date.now(),
    });
  }

  const keyIds = {};
  const docRefs = docs.map(d => {
    const id = nid(d.coll[0].toUpperCase());
    if (d._key) keyIds['$' + d._key] = id;
    return { ...d, id };
  });
  for (const d of docRefs) {
    const data = { ...link(d.data, keyIds), id: d.id, createdBy: 'test', createdAt: Date.now() };
    if (d._linkTxn && txnId) data.txnId = txnId;
    if (d.coll === 'bills' && no) data.no = no;
    s[COLL_KEY[d.coll]].push(data);
  }
  for (const u of updates) {
    const target = s[COLL_KEY[u.coll]].find(x => x.id === u.id);
    if (target) applyUpdate(target, link(u.data, keyIds));
  }
  for (const a of allocations) {
    const cur = s[COLL_KEY[a.coll]].find(x => x.id === a.id);
    if (!cur || cur.status === 'void') continue;
    const paid = r2(num(cur.paid) + num(a.amt));
    const total = a.coll === 'bills' ? num(cur.net ?? cur.total) : num(cur.total);
    cur.paid = paid;
    cur.status = docStatus(r2(total - paid), total);
    if (a.creditNote) cur.credited = r2(num(cur.credited) + num(a.amt));
    cur.allocations = [...(cur.allocations || []), { txnId, amt: a.amt, date: postDate, ...(a.writtenOff ? { writtenOff: true } : {}), ...(a.creditNote ? { creditNote: true } : {}) }];
  }
  if (out.creditNote && txnId) {
    const n = num(s.settings.nextCreditNoteNo) || 1;
    s.invoices.push({ kind: 'creditnote', ...out.creditNote, id: nid('I'), invoiceNo: (s.settings.creditNotePrefix || '3PIN/CN/') + String(n).padStart(3, '0'), txnId, status: 'issued' });
    s.settings.nextCreditNoteNo = n + 1;
  }

  if (out.selfInvoice && txnId) {
    const n = num(s.settings.nextSelfInvoiceNo) || 1;
    const t = s.txns.at(-1);
    t.selfInvoiceNo = (s.settings.selfInvoicePrefix || '3PIN/SI/') + String(n).padStart(3, '0');
    t.selfInvoice = out.selfInvoice;
    s.settings.nextSelfInvoiceNo = n + 1;
  }

  if (out.invoice && txnId) {
    const n = num(s.settings.nextInvoiceNo) || 1;
    const invoiceNo = (s.settings.invoicePrefix || '3PIN/') + String(n).padStart(3, '0');
    const invPaid = num(out.invoice.paid);
    s.invoices.push({
      ...out.invoice, id: nid('I'), txnId, invoiceNo,
      paid: invPaid, status: docStatus(num(out.invoice.total) - invPaid, out.invoice.total), allocations: [],
      createdBy: 'test', createdAt: Date.now(),
    });
    s.settings.nextInvoiceNo = n + 1;
  }
  return txnId;
}

export function reverse(txnId) {
  const s = getState();
  const t = s.txns.find(x => x.id === txnId);
  if (!t) throw new Error('Transaction not found');
  if (t.reversedBy) throw new Error('This entry has already been reversed');
  const settled = s.bills.find(b => b.txnId === txnId && b.status !== 'void'
    && (b.allocations || []).reduce((a, x) => a + num(x.amt), 0) > 0.005);
  if (settled) throw new Error(`${settled.desc} has already been paid. Reverse the payment first, then reverse this entry.`);
  const truedUp = s.bills.find(b => b.txnId === txnId && b.status !== 'void' && b.billNo && b.accrued === false);
  if (truedUp) throw new Error(`The vendor bill ${truedUp.billNo} was recorded against ${truedUp.desc} with "Bill arrived". Reverse that entry first, then reverse this one.`);
  const invPaid = s.invoices.find(i => i.txnId === txnId && i.kind !== 'creditnote'
    && (i.allocations || []).reduce((a, x) => a + num(x.amt), 0) > 0.005);
  if (invPaid) throw new Error(`${invPaid.invoiceNo} has a payment against it. Reverse the payment first, or reduce the invoice with a credit note instead.`);
  const rid = nid('TX');
  const lines = normalise(reversalLines(t.lines));
  // Same rule as finance-sync.js: on the original's day unless that month is closed.
  const when = s.monthEnds[ym(t.date)] ? today() : t.date;
  s.txns.push({
    id: rid, no: ++txnNo, date: when, event: 'reverse', desc: 'Reversal — ' + t.desc, lines,
    totals: {
      dr: lines.reduce((a, l) => a + num(l.dr), 0),
      cr: lines.reduce((a, l) => a + num(l.cr), 0),
    },
    reversalOf: t.id, auto: false, attachments: [], meta: {},
    fy: t.fy, createdBy: 'test', createdAt: Date.now(),
  });
  t.reversedBy = rid;

  // The same unwinding finance-sync.js does: allocations handed back, bills voided, the
  // service month marked reversed so it can be recorded again.
  for (const a of t.allocations || []) {
    const cur = s[COLL_KEY[a.coll]].find(x => x.id === a.id);
    if (!cur || cur.status === 'void') continue;
    const paid = Math.max(0, r2(num(cur.paid) - num(a.amt)));
    const total = a.coll === 'bills' ? num(cur.net ?? cur.total) : num(cur.total);
    cur.paid = paid;
    cur.status = docStatus(total - paid, total);
    cur.allocations = [...(cur.allocations || []), { txnId: rid, amt: -num(a.amt), date: when, reversal: true }];
  }
  const madeBills = s.bills.filter(b => b.txnId === txnId && b.status !== 'void');
  for (const b of madeBills) { b.status = 'void'; b.voidedBy = rid; }
  // Firestore issues a credit note and voids the original; the ledger effect is the same
  // reversal, so here it is enough to close the document.
  for (const i of s.invoices.filter(x => x.txnId === txnId && x.kind !== 'creditnote')) {
    i.status = 'void'; i.voidedBy = rid;
  }
  for (const sb of s.subs) {
    for (const [m, c] of Object.entries(sb.charges || {})) {
      if (c && madeBills.some(b => b.id === c.billId)) { c.reversed = true; c.reversedBy = rid; }
    }
  }
  return rid;
}

export function runMonthEnd(month) {
  const s = getState();
  const entries = monthEndEntries(month);
  for (const e of entries) {
    const lines = normalise(e.txn.lines);
    s.txns.push({
      id: nid('TX'), no: ++txnNo, ...e.txn, lines,
      totals: {
        dr: lines.reduce((a, l) => a + num(l.dr), 0),
        cr: lines.reduce((a, l) => a + num(l.cr), 0),
      },
      meta: {}, attachments: [], fy: fyOf(e.txn.date, s.settings.fyStartMonth),
      createdBy: 'test', createdAt: Date.now(),
    });
    if (e.kind === 'prepaid') {
      const sub = s.subs.find(x => x.id === e.ref);
      sub.amortized = [...(sub.amortized || []), month];
    } else {
      const a = s.assets.find(x => x.id === e.ref);
      a.depreciated = [...(a.depreciated || []), month];
    }
  }
  s.monthEnds[month] = { ranAt: Date.now(), entriesPosted: entries.length };
  return entries.length;
}
