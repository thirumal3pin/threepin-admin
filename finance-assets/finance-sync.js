// ═══════ 3 PIN REALTY — FINANCE FIRESTORE SYNC ═══════
//
// Same Firebase project, tenant and login accounts as crm.html and dashboard.html — log in
// here with the same email/password. Mirrors dashboard-assets/firebase-sync.js: the modular
// v12 SDK straight off the gstatic CDN, tenantId resolved from the Auth custom claim, and a
// window.onFinanceAuthChange hook the page implements.
//
// Everything the finance module owns lives under one document, finance/{tenantId}, so it can
// never be confused with CRM or property data. The tenant id IS the document id, which lets
// firestore.rules gate the whole subtree with the ownsTenantDoc() helper it already has.
//
// The whole ledger is cached in memory via onSnapshot and read from there by every view.
// Nothing re-queries Firestore to render — that is what keeps the page usable on a phone
// once there are thousands of transactions.
//
// Every write that posts to the ledger runs as a Firestore transaction rather than a batch,
// because each entry takes the next number off a counter on the settings document (#0001,
// #0002…) and that read-then-write has to be atomic across two devices.

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot,
  getDoc, getDocs, writeBatch, runTransaction, query, where, limit,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js';

import {
  ACCOUNTS, getState, setState, blank, defaultSettings,
  validate, normalise, reversalLines, fyOf, today, ym, num,
  monthEndEntries,
} from './finance-core.js';
import { EV, PARTY_FIELDS } from './finance-events.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0',
  authDomain: 'pin-realty.firebaseapp.com',
  projectId: 'pin-realty',
  storageBucket: 'pin-realty.firebasestorage.app',
  messagingSenderId: '570586680667',
  appId: '1:570586680667:web:859a61bf99fe1824725e7e',
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

let currentTenantId = null;
let currentUser = null;
let subscribed = false;

// Which subcollections stream into the in-memory cache, and where each lands on the state.
const COLLECTIONS = [
  ['txns', 'txns'],
  ['parties', 'parties'],
  ['deals', 'deals'],
  ['subscriptions', 'subs'],
  ['loans', 'loans'],
  ['assets', 'assets'],
  ['invoices', 'invoices'],
  ['bankStatements', 'bankStatements'],
];

const root = () => doc(db, 'finance', currentTenantId);
const col = name => collection(db, 'finance', currentTenantId, name);
const ref = (name, id) => doc(db, 'finance', currentTenantId, name, id);

// ═══════ AUTH ═══════

window.financeAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  getTenantId: () => currentTenantId,
  getUserEmail: () => currentUser?.email || null,
  getIdToken: () => currentUser ? currentUser.getIdToken() : Promise.resolve(null),
};

onAuthStateChanged(auth, async user => {
  currentUser = user;
  if (user) {
    // Force a refresh so a claim added moments ago on a freshly provisioned account is seen.
    const tokenResult = await user.getIdTokenResult(true);
    currentTenantId = tokenResult.claims.tenantId || null;
    if (!currentTenantId) {
      console.error('This account has no tenantId claim yet — contact support to finish onboarding.');
    } else {
      subscribeAll();
    }
  } else {
    currentTenantId = null;
    subscribed = false;
    setState(blank());
  }
  if (window.onFinanceAuthChange) window.onFinanceAuthChange(user, currentTenantId);
});

// ═══════ LIVE CACHE ═══════

// Each listener replaces its own slice of the cache and then tells the page to re-render.
// Views are pure functions of this state, so a single repaint after any change is enough.
function subscribeAll() {
  if (subscribed) return;
  subscribed = true;

  onSnapshot(root(), snap => {
    const s = getState();
    s.settings = snap.exists() ? { ...defaultSettings(), ...snap.data() } : defaultSettings();
    s.settingsExists = snap.exists();
    notify('settings');
  }, err => console.error('Finance settings sync error:', err));

  for (const [name, key] of COLLECTIONS) {
    onSnapshot(col(name), snap => {
      getState()[key] = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      notify(key);
    }, err => console.error(`Finance ${name} sync error:`, err));
  }

  onSnapshot(col('monthEnds'), snap => {
    const m = {};
    snap.docs.forEach(d => { m[d.id] = { ...d.data(), id: d.id }; });
    getState().monthEnds = m;
    notify('monthEnds');
  }, err => console.error('Finance monthEnds sync error:', err));
}

let repaintQueued = false;
function notify(what) {
  // Eight listeners all fire on first load; coalesce them into one repaint.
  if (repaintQueued) return;
  repaintQueued = true;
  queueMicrotask(() => {
    repaintQueued = false;
    if (window.onFinanceData) window.onFinanceData(what);
  });
}

// ═══════ WRITING TO THE LEDGER ═══════

function stamp(t, no) {
  const s = getState();
  const lines = normalise(t.lines);
  return {
    no: no || null,
    date: t.date || today(),
    event: t.event || 'manual',
    desc: t.desc || '',
    lines,
    totals: {
      dr: Math.round(lines.reduce((a, l) => a + num(l.dr), 0) * 100) / 100,
      cr: Math.round(lines.reduce((a, l) => a + num(l.cr), 0) * 100) / 100,
    },
    meta: t.meta || {},
    attachments: t.attachments || [],
    auto: !!t.auto,
    fy: fyOf(t.date || today(), s.settings.fyStartMonth),
    createdBy: currentUser?.email || 'unknown',
    createdAt: Date.now(),
    ...(t.reversalOf ? { reversalOf: t.reversalOf } : {}),
  };
}

// Reads the entry counter inside a transaction and reserves `count` numbers. The caller must
// have done no writes yet — Firestore requires every read in a transaction before any write.
async function reserveNumbers(tx, count) {
  const snap = await tx.get(root());
  const settings = snap.exists() ? snap.data() : defaultSettings();
  const first = num(settings.nextTxnNo) || 1;
  return {
    settings,
    nos: Array.from({ length: count }, (_, i) => first + i),
    patch: count ? { nextTxnNo: first + count } : {},
  };
}

// The one entry point the Record screen uses. Materialises any brand-new parties, runs the
// event builder for real, and writes the transaction plus every master record it implies in
// a single transaction — so a half-saved deal or subscription can never exist, and the entry
// number cannot collide with one taken from another phone at the same moment.
export async function save(evKey, values, opts = {}) {
  const ev = EV[evKey];
  if (!ev) throw new Error('Unknown event ' + evKey);
  const v = { ...values };

  // 1. Turn "add new" party entries into records with reserved ids BEFORE the transaction,
  //    and seed the cache once. Firestore may run the transaction body more than once on
  //    contention, so the party writes are replayed from this list each attempt rather than
  //    being decided inside it.
  const newParties = [];
  for (const k of (PARTY_FIELDS[evKey] || [])) v[k] = resolveParty(v[k], newParties);
  // card2emi always books against a lender called "Card EMI"; reuse it rather than making
  // a new party every time a purchase is converted.
  if (evKey === 'card2emi') {
    v.__lender = resolveParty(findPartyByName('Card EMI') || { __new: true, name: 'Card EMI', type: 'lender' }, newParties);
  }

  // 2. Build for real. Nothing in here writes — it only describes what should happen.
  const out = ev.build(v);
  if (out.incomplete) throw new Error(out.effects[0] || 'Fill in the form');

  const lines = normalise(out.lines || []);
  const docs = out.docs || [];
  const updates = out.updates || [];
  if (!lines.length && !docs.length && !updates.length) throw new Error('Nothing to save');
  if (lines.length) validate({ ...out, date: v.date, lines });

  // 3. One transaction for the entry, its number, any master records, and the invoice.
  return runTransaction(db, async tx => {
    const { settings, nos, patch } = await reserveNumbers(tx, lines.length ? 1 : 0);

    for (const p of newParties) tx.set(p.ref, p.record);

    let txnId = null, no = null;
    if (lines.length) {
      const tref = doc(col('txns'));
      txnId = tref.id;
      no = nos[0];
      tx.set(tref, stamp({
        ...out, lines, date: v.date, event: evKey,
        meta: stripForMeta(v),
        attachments: opts.attachments || [],
      }, no));
    }

    for (const d of docs) {
      tx.set(doc(col(d.coll)), { ...d.data, createdBy: currentUser?.email || 'unknown', createdAt: Date.now() });
    }
    for (const u of updates) tx.update(ref(u.coll, u.id), u.data);

    // A GST invoice takes the next invoice number off the same settings document, in the
    // same transaction, so the sequence stays gapless and can never double up.
    let invoiceId = null, invoiceNo = null;
    if (out.invoice && txnId) {
      const n = num(settings.nextInvoiceNo) || 1;
      invoiceNo = (settings.invoicePrefix || '3PIN/') + String(n).padStart(3, '0');
      const iref = doc(col('invoices'));
      invoiceId = iref.id;
      tx.set(iref, {
        ...out.invoice, txnId, invoiceNo, status: 'unpaid',
        createdBy: currentUser?.email || 'unknown', createdAt: Date.now(),
      });
      patch.nextInvoiceNo = n + 1;
    }

    if (Object.keys(patch).length) tx.set(root(), patch, { merge: true });
    return {
      txnId, no, invoiceId, invoiceNo, desc: out.desc,
      total: lines.reduce((a, l) => a + num(l.dr), 0),
    };
  });
}

// Party values arrive either as an existing id or as {__new:true, name, phone}. New ones get
// a document id reserved up front so the journal can reference them inside the transaction.
function resolveParty(value, newParties) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const existing = findPartyByName(value.name);
  if (existing) return existing;
  const pref = doc(col('parties'));
  const record = {
    name: String(value.name || '').trim(),
    type: value.type || 'other',
    phone: value.phone || '',
    email: value.email || '',
    gstin: value.gstin || '',
    state: value.state || '',
    crmRef: value.crmRef || null,
    createdAt: Date.now(),
  };
  newParties.push({ ref: pref, record });
  // Seed the cache straight away. build() runs before the onSnapshot echo gets back, and it
  // asks for this party's name to write the transaction description — without this it would
  // render as "—" on the very entry that created the party.
  getState().parties.push({ ...record, id: pref.id });
  return pref.id;
}

function findPartyByName(name) {
  if (!name) return null;
  const hit = getState().parties.find(
    p => p.name.trim().toLowerCase() === String(name).trim().toLowerCase());
  return hit ? hit.id : null;
}

// The form values are kept on the transaction so an entry can be explained later, but the
// bulky picker objects are flattened first — Firestore rejects undefined and nested classes.
function stripForMeta(v) {
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null || k.startsWith('__')) continue;
    if (typeof val === 'object') {
      out[k] = val.id || val.name || JSON.stringify(val).slice(0, 200);
    } else {
      out[k] = val;
    }
  }
  return out;
}

// A mistake is corrected by posting the opposite entry, never by editing or deleting the
// original — both stay on the record, which is what makes the ledger auditable.
export async function reverse(txnId) {
  const t = getState().txns.find(x => x.id === txnId);
  if (!t) throw new Error('Transaction not found');
  if (t.reversedBy) throw new Error('This entry has already been reversed');

  // Reversing an invoiced entry has to issue a credit note against the original — GST does
  // not allow an invoice to simply disappear.
  const inv = getState().invoices.find(i => i.txnId === txnId && i.kind !== 'creditnote');

  return runTransaction(db, async tx => {
    const { settings, nos, patch } = await reserveNumbers(tx, 1);
    const rref = doc(col('txns'));
    tx.set(rref, stamp({
      date: today(),
      event: 'reverse',
      desc: 'Reversal — ' + t.desc,
      lines: reversalLines(t.lines),
      reversalOf: t.id,
    }, nos[0]));
    tx.update(ref('txns', t.id), { reversedBy: rref.id });

    let creditNoteNo = null;
    if (inv) {
      const n = num(settings.nextCreditNoteNo) || 1;
      creditNoteNo = (settings.creditNotePrefix || '3PIN/CN/') + String(n).padStart(3, '0');
      tx.set(doc(col('invoices')), {
        kind: 'creditnote', against: inv.invoiceNo, againstId: inv.id, invoiceNo: creditNoteNo,
        date: today(), partyId: inv.partyId, dealId: inv.dealId || null,
        base: inv.base, gstRate: inv.gstRate, cgst: inv.cgst || 0, sgst: inv.sgst || 0, igst: inv.igst || 0,
        total: inv.total, placeOfSupply: inv.placeOfSupply || null, sac: inv.sac || null,
        desc: 'Credit note — ' + t.desc, txnId: rref.id, status: 'issued',
        createdBy: currentUser?.email || 'unknown', createdAt: Date.now(),
      });
      patch.nextCreditNoteNo = n + 1;
    }
    tx.set(root(), patch, { merge: true });
    return { id: rref.id, no: nos[0], creditNoteNo };
  });
}

// ═══════ MONTH END ═══════

// Idempotent: monthEndEntries() only returns work that has not been done, so a second run
// posts nothing. The guard flags and the monthEnds record are written with the entries, so
// the two can never disagree.
export async function runMonthEnd(month, opts = {}) {
  const s = getState();
  const entries = monthEndEntries(month);

  await runTransaction(db, async tx => {
    const { nos, patch } = await reserveNumbers(tx, entries.length);

    const bumped = { subscriptions: {}, assets: {} };
    entries.forEach((e, i) => {
      tx.set(doc(col('txns')), stamp(e.txn, nos[i]));
      if (e.kind === 'prepaid') {
        const sub = s.subs.find(x => x.id === e.ref);
        bumped.subscriptions[e.ref] = [...(sub.amortized || []), month];
      } else {
        const a = s.assets.find(x => x.id === e.ref);
        bumped.assets[e.ref] = [...(a.depreciated || []), month];
      }
    });
    for (const [id, amortized] of Object.entries(bumped.subscriptions)) tx.update(ref('subscriptions', id), { amortized });
    for (const [id, depreciated] of Object.entries(bumped.assets)) tx.update(ref('assets', id), { depreciated });

    tx.set(ref('monthEnds', month), {
      ranAt: Date.now(),
      ranBy: currentUser?.email || 'unknown',
      entriesPosted: entries.length,
      ...(opts.overrodeReconciliation ? { overrodeReconciliation: true } : {}),
    });
    if (Object.keys(patch).length) tx.set(root(), patch, { merge: true });
  });
  return entries.length;
}

// Bank reconciliation status is the one field allowed to change on a month-end record.
export async function markReconciled(month, reconciled) {
  await updateDoc(ref('monthEnds', month), { reconciled: !!reconciled });
}

// ═══════ INVOICES ═══════

// Used to retry an invoice that failed to generate; save() normally does this inline.
export async function createInvoice(data) {
  const iref = doc(col('invoices'));
  await runTransaction(db, async tx => {
    const snap = await tx.get(root());
    const s = snap.exists() ? snap.data() : defaultSettings();
    const nextNo = num(s.nextInvoiceNo) || 1;
    const invoiceNo = (s.invoicePrefix || '3PIN/') + String(nextNo).padStart(3, '0');
    tx.set(iref, {
      ...data, invoiceNo, status: 'unpaid',
      createdBy: currentUser?.email || 'unknown', createdAt: Date.now(),
    });
    tx.update(root(), { nextInvoiceNo: nextNo + 1 });
  });
  return iref.id;
}

export async function attachInvoicePdf(invoiceId, path, field = 'pdfPath') {
  await updateDoc(ref('invoices', invoiceId), { [field]: path });
}

// ═══════ ATTACHMENTS ═══════
//
// Bills are photographed on a phone, and a phone photo is 3–8 MB. Uploading that over a site
// office's mobile signal is slow, and Vercel refuses request bodies over 4.5 MB outright. So a
// photo is shrunk in the browser first — 1600px on the long edge is more than enough to read
// a receipt — and then sent through the API to Drive. Only a file still over the limit after
// that (a long scanned PDF) takes the direct-to-Google route.

const PROXY_LIMIT = 3.9 * 1024 * 1024;
const HARD_LIMIT = 10 * 1024 * 1024;

const okType = t => /^image\//.test(t || '') || t === 'application/pdf';

async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    // from-image honours the EXIF orientation, so a portrait photo does not come out sideways.
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.2 * 1024 * 1024) { bmp.close?.(); return file; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

async function apiJson(url, init) {
  const token = await window.financeAuth.getIdToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) },
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || data.success === false) {
    throw new Error(data.error || text.slice(0, 200) || `Upload failed (${res.status})`);
  }
  return data;
}

// Returns the attachment record to store on the transaction. `onStatus` is called with a
// short human phrase as the upload moves along, for the row in the Record screen.
export async function uploadAttachment(file, txnId, onStatus = () => { }) {
  const s = getState();
  if (!okType(file.type)) throw new Error('Only photos and PDFs can be attached');

  onStatus('Preparing…');
  const f = await shrinkImage(file);
  if (f.size > HARD_LIMIT) throw new Error('That file is larger than 10 MB');

  if (s.settings.attachmentBackend !== 'drive') return uploadViaStorage(f, txnId, onStatus);

  const fy = fyOf(today(), s.settings.fyStartMonth);
  const base = { backend: 'drive', name: f.name, type: f.type, size: f.size, uploadedAt: Date.now() };

  onStatus('Uploading…');
  if (f.size <= PROXY_LIMIT) {
    const params = new URLSearchParams({ task: 'upload', action: 'put', name: f.name, type: f.type, txnId: txnId || 'unfiled', fy });
    const d = await apiJson('/api/finance?' + params, { method: 'POST', headers: { 'Content-Type': f.type }, body: f });
    return { ...base, path: d.fileId, url: d.url, thumb: d.thumb };
  }

  // Too big to pass through the function: open a session and send the bytes straight to Google.
  const init = await apiJson('/api/finance?task=upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'init', fileName: f.name, mimeType: f.type, txnId: txnId || 'unfiled', fy }),
  });
  const put = await fetch(init.sessionUrl, { method: 'PUT', headers: { 'Content-Type': f.type }, body: f });
  if (!put.ok) throw new Error('Drive refused the upload (' + put.status + ')');
  const uploaded = await put.json();
  const done = await apiJson('/api/finance?task=upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'finish', fileId: uploaded.id }),
  });
  return { ...base, path: done.fileId, url: done.url, thumb: done.thumb };
}

async function uploadViaStorage(f, txnId, onStatus) {
  onStatus('Uploading…');
  const yyyy = today().slice(0, 4);
  const safe = f.name.replace(/[^\w.\-]+/g, '_');
  const path = `finance/${currentTenantId}/${yyyy}/${txnId || 'unfiled'}/${Date.now()}_${safe}`;
  const r = storageRef(storage, path);
  await uploadBytes(r, f, { contentType: f.type });
  const url = await getDownloadURL(r);
  return {
    backend: 'storage', path, url, thumb: f.type.startsWith('image/') ? url : null,
    name: f.name, type: f.type, size: f.size, uploadedAt: Date.now(),
  };
}

export async function deleteAttachment(att) {
  if (att.backend === 'storage') {
    await deleteObject(storageRef(storage, att.path));
  } else {
    await apiJson('/api/finance?task=upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', fileId: att.path }),
    });
  }
}

// Changing the attachment list is the only edit firestore.rules permits on a posted entry,
// alongside marking it reversed.
export async function addAttachments(txnId, attachments) {
  const t = getState().txns.find(x => x.id === txnId);
  await updateDoc(ref('txns', txnId), { attachments: [...(t?.attachments || []), ...attachments] });
}

export async function removeAttachment(txnId, att) {
  const t = getState().txns.find(x => x.id === txnId);
  await updateDoc(ref('txns', txnId), { attachments: (t?.attachments || []).filter(a => a.path !== att.path) });
  await deleteAttachment(att).catch(e => console.warn('attachment file not removed:', e));
}

// ═══════ MASTER DATA ═══════

export async function saveSettings(patch) {
  await setDoc(root(), patch, { merge: true });
}

export async function saveParty(id, data) {
  const r = id ? ref('parties', id) : doc(col('parties'));
  await setDoc(r, { ...data, ...(id ? {} : { createdAt: Date.now() }) }, { merge: true });
  return r.id;
}

export async function saveDeal(id, data) {
  const r = id ? ref('deals', id) : doc(col('deals'));
  await setDoc(r, { ...data, ...(id ? {} : { createdAt: Date.now() }) }, { merge: true });
  return r.id;
}

export async function saveBankStatement(data) {
  const r = doc(col('bankStatements'));
  await setDoc(r, { ...data, importedAt: Date.now(), importedBy: currentUser?.email || 'unknown' });
  return r.id;
}

export async function updateBankStatement(id, data) {
  await updateDoc(ref('bankStatements', id), data);
}

export async function removeDoc(collName, id) {
  await deleteDoc(ref(collName, id));
}

// Merging duplicate parties rewrites every journal line that points at the loser, then
// deletes it. Done in chunks because a Firestore batch caps at 500 writes.
export async function mergeParties(keepId, dropId) {
  const affected = getState().txns.filter(t => t.lines.some(l => l.party === dropId));
  for (let i = 0; i < affected.length; i += 400) {
    const batch = writeBatch(db);
    for (const t of affected.slice(i, i + 400)) {
      batch.update(ref('txns', t.id), { lines: t.lines.map(l => l.party === dropId ? { ...l, party: keepId } : l) });
    }
    await batch.commit();
  }
  await deleteDoc(ref('parties', dropId));
  return affected.length;
}

// ═══════ PROPERTY LOOKUP ═══════

// Deals may link to a property from the dashboard. That collection is flat and scoped by a
// tenantId field (not a subcollection), so it is queried the same way dashboard.html does.
let propertyCache = null;
export async function searchProperties(term) {
  if (!propertyCache) {
    const snap = await getDocs(query(collection(db, 'properties'), where('tenantId', '==', currentTenantId)));
    propertyCache = snap.docs.map(d => ({
      id: d.id,
      propertyCode: d.data().propertyCode || '',
      name: d.data().name || '',
      location: d.data().location || '',
      startingPrice: d.data().startingPrice || '',
      status: d.data().status || '',
    }));
  }
  const q = String(term || '').trim().toLowerCase();
  if (!q) return propertyCache.slice(0, 20);
  return propertyCache
    .filter(p => (p.propertyCode + ' ' + p.name + ' ' + p.location).toLowerCase().includes(q))
    .slice(0, 20);
}

// ═══════ ONE-TIME SEED ═══════

// Writes the chart of accounts and the settings document if they are not there yet. Safe to
// run more than once: existing documents are left exactly as they are.
export async function seedFinance() {
  const snap = await getDoc(root());
  if (!snap.exists()) {
    await setDoc(root(), { ...defaultSettings(), nextTxnNo: 1, seededAt: Date.now() });
  }
  // Always upsert the whole chart: an account added to the code later (the GST heads were)
  // reaches an existing project the next time this runs, and nothing already there is lost.
  for (let i = 0; i < ACCOUNTS.length; i += 400) {
    const batch = writeBatch(db);
    for (const a of ACCOUNTS.slice(i, i + 400)) batch.set(ref('accounts', a.code), a, { merge: true });
    await batch.commit();
  }
  return { settings: !snap.exists(), accounts: ACCOUNTS.length };
}

// ═══════ OPENING BALANCES ═══════

// Used once, when the books start. Posts ONE balanced journal against 3100 Opening balance
// equity, and creates the loan/asset master records the figures imply, all together.
export async function postOpeningBalances({ date, lines, loans = [], assets = [], subscriptions = [] }) {
  const balanced = normalise(lines);
  const dr = balanced.reduce((a, l) => a + num(l.dr), 0);
  const cr = balanced.reduce((a, l) => a + num(l.cr), 0);
  const gap = Math.round((dr - cr) * 100) / 100;
  // Whatever the figures do not account for is the owner's stake on day one — that is
  // exactly what 3100 is for, so the entry always balances.
  if (Math.abs(gap) > 0.005) balanced.push(gap > 0 ? { acc: '3100', cr: gap } : { acc: '3100', dr: -gap });

  return runTransaction(db, async tx => {
    const { nos, patch } = await reserveNumbers(tx, 1);
    const tref = doc(col('txns'));
    tx.set(tref, stamp({ date, event: 'opening', desc: 'Opening balances', lines: balanced, auto: true }, nos[0]));
    for (const l of loans) tx.set(doc(col('loans')), { ...l, hasTxns: true, createdAt: Date.now() });
    for (const a of assets) tx.set(doc(col('assets')), { ...a, hasTxns: true, createdAt: Date.now() });
    for (const s of subscriptions) tx.set(doc(col('subscriptions')), { ...s, createdAt: Date.now() });
    tx.set(root(), { ...patch, openingPosted: true, booksStartDate: date }, { merge: true });
    return tref.id;
  });
}

export { db, auth, storage };
