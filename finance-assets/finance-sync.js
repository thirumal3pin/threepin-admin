// ═══════ 3 PIN REALTY — FINANCE FIRESTORE SYNC ═══════
//
// Same Firebase project, tenant and login accounts as crm.html and dashboard.html — log in
// here with the same email/password. Mirrors dashboard-assets/firebase-sync.js: the modular
// v12 SDK straight off the gstatic CDN, tenantId resolved from the Auth custom claim, and a
// window.onFinanceAuthChange hook the page's auth.js implements.
//
// Everything the finance module owns lives under one document, finance/{tenantId}, so it can
// never be confused with CRM or property data. The tenant id IS the document id, which lets
// firestore.rules gate the whole subtree with the ownsTenantDoc() helper it already has.
//
// The whole ledger is cached in memory via onSnapshot and read from there by every view.
// Nothing re-queries Firestore to render — that is what keeps the page usable on a phone
// once there are thousands of transactions.

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
import { EV, PARTY_FIELDS, pidOf } from './finance-events.js';

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

function stamp(t) {
  const s = getState();
  const lines = normalise(t.lines);
  return {
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

// Post a single balanced journal. Throws with a user-facing message if it does not balance.
export async function post(t) {
  validate(t);
  const ref = doc(col('txns'));
  await setDoc(ref, stamp(t));
  return ref.id;
}

// The one entry point the Record screen uses. Materialises any brand-new parties, runs the
// event builder for real, and writes the transaction plus every master record it implies in
// a single batch — so a half-saved deal or subscription can never exist.
export async function save(evKey, values, opts = {}) {
  const ev = EV[evKey];
  if (!ev) throw new Error('Unknown event ' + evKey);

  const batch = writeBatch(db);
  const v = { ...values };

  // 1. Turn "add new" party entries into real documents, and swap their ids into the form
  //    values BEFORE build() runs, so the journal it returns references real parties.
  const partyKeys = PARTY_FIELDS[evKey] || [];
  for (const k of partyKeys) {
    v[k] = resolveParty(v[k], batch);
  }
  // card2emi always books against a lender called "Card EMI"; reuse it rather than making
  // a new party every time a purchase is converted.
  if (evKey === 'card2emi') {
    v.__lender = resolveParty(findPartyByName('Card EMI') || { __new: true, name: 'Card EMI', type: 'lender' }, batch);
  }

  // 2. Build for real. Nothing in here writes — it only describes what should happen.
  const out = ev.build(v);
  if (out.incomplete) throw new Error(out.effects[0] || 'Fill in the form');

  const lines = normalise(out.lines || []);
  if (!lines.length && !(out.docs || []).length && !(out.updates || []).length) {
    throw new Error('Nothing to save');
  }

  // 3. The transaction itself, if this event moves any money.
  let txnId = null;
  if (lines.length) {
    validate({ ...out, date: v.date, lines });
    const tref = doc(col('txns'));
    txnId = tref.id;
    batch.set(tref, stamp({
      ...out, lines, date: v.date, event: evKey,
      meta: stripForMeta(v),
      attachments: opts.attachments || [],
    }));
  }

  // 4. Master records this event creates (a deal, subscription, loan, asset).
  for (const d of out.docs || []) {
    const dref = doc(col(d.coll));
    batch.set(dref, { ...d.data, createdBy: currentUser?.email || 'unknown', createdAt: Date.now() });
  }

  // 5. Master records it changes (marking a deal registered, an EMI paid, a service cancelled).
  for (const u of out.updates || []) {
    batch.update(doc(db, 'finance', currentTenantId, u.coll, u.id), u.data);
  }

  await batch.commit();

  // 6. A GST invoice is numbered in its own transaction, because the sequence has to be read
  //    and incremented atomically and a batch cannot read. If this step fails the journal is
  //    still correct; the Invoices tab shows the entry as "invoice not generated" so it can
  //    be retried without double-counting anything.
  let invoiceId = null;
  if (out.invoice && txnId) {
    invoiceId = await createInvoice({ ...out.invoice, txnId });
  }

  return { txnId, invoiceId };
}

// Party values arrive either as an existing id or as {__new:true, name, phone}. New ones get
// a document id reserved up front so the journal can reference them inside the same batch.
function resolveParty(value, batch) {
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
  batch.set(pref, record);
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
  const s = getState();
  const t = s.txns.find(x => x.id === txnId);
  if (!t) throw new Error('Transaction not found');
  if (t.reversedBy) throw new Error('This entry has already been reversed');

  const batch = writeBatch(db);
  const rref = doc(col('txns'));
  batch.set(rref, stamp({
    date: today(),
    event: 'reverse',
    desc: 'Reversal — ' + t.desc,
    lines: reversalLines(t.lines),
    reversalOf: t.id,
  }));
  batch.update(doc(db, 'finance', currentTenantId, 'txns', t.id), { reversedBy: rref.id });
  await batch.commit();
  return rref.id;
}

// ═══════ MONTH END ═══════

// Idempotent: monthEndEntries() only returns work that has not been done, so a second run
// posts nothing. The guard flags and the monthEnds record are written in the same batch as
// the entries, so the two can never disagree.
export async function runMonthEnd(month, opts = {}) {
  const s = getState();
  const entries = monthEndEntries(month);
  const batch = writeBatch(db);

  const bumped = { subscriptions: {}, assets: {} };
  for (const e of entries) {
    const tref = doc(col('txns'));
    batch.set(tref, stamp(e.txn));
    if (e.kind === 'prepaid') {
      const sub = s.subs.find(x => x.id === e.ref);
      bumped.subscriptions[e.ref] = [...(sub.amortized || []), month];
    } else {
      const a = s.assets.find(x => x.id === e.ref);
      bumped.assets[e.ref] = [...(a.depreciated || []), month];
    }
  }
  for (const [id, amortized] of Object.entries(bumped.subscriptions)) {
    batch.update(doc(db, 'finance', currentTenantId, 'subscriptions', id), { amortized });
  }
  for (const [id, depreciated] of Object.entries(bumped.assets)) {
    batch.update(doc(db, 'finance', currentTenantId, 'assets', id), { depreciated });
  }

  batch.set(doc(db, 'finance', currentTenantId, 'monthEnds', month), {
    ranAt: Date.now(),
    ranBy: currentUser?.email || 'unknown',
    entriesPosted: entries.length,
    ...(opts.overrodeReconciliation ? { overrodeReconciliation: true } : {}),
  });

  await batch.commit();
  return entries.length;
}

// Bank reconciliation status is the one field allowed to change on a month-end record.
export async function markReconciled(month, reconciled) {
  await updateDoc(doc(db, 'finance', currentTenantId, 'monthEnds', month), { reconciled: !!reconciled });
}

// ═══════ INVOICES ═══════

// The invoice number has to be unique and gapless, so the counter is read and written inside
// a Firestore transaction rather than trusting a cached value.
export async function createInvoice(data) {
  const iref = doc(col('invoices'));
  await runTransaction(db, async tx => {
    const snap = await tx.get(root());
    const s = snap.exists() ? snap.data() : defaultSettings();
    const nextNo = num(s.nextInvoiceNo) || 1;
    const invoiceNo = (s.invoicePrefix || '3PIN/') + String(nextNo).padStart(3, '0');
    tx.set(iref, {
      ...data,
      invoiceNo,
      status: 'unpaid',
      createdBy: currentUser?.email || 'unknown',
      createdAt: Date.now(),
    });
    tx.update(root(), { nextInvoiceNo: nextNo + 1 });
  });
  return iref.id;
}

export async function attachInvoicePdf(invoiceId, path, field = 'pdfPath') {
  await updateDoc(doc(db, 'finance', currentTenantId, 'invoices', invoiceId), { [field]: path });
}

// ═══════ ATTACHMENTS ═══════

// Firebase Storage is the default. If the operator has never enabled it, Settings can flip
// attachmentBackend to 'drive' and uploads route through api/finance?task=upload instead,
// reusing the service account the brochure pipeline already uses.
export async function uploadAttachment(file, txnId) {
  const s = getState();
  if (file.size > 10 * 1024 * 1024) throw new Error('That file is larger than 10 MB');
  const ok = file.type.startsWith('image/') || file.type === 'application/pdf';
  if (!ok) throw new Error('Only photos and PDFs can be attached');

  if (s.settings.attachmentBackend === 'drive') return uploadViaDrive(file, txnId);

  const yyyy = today().slice(0, 4);
  const safe = file.name.replace(/[^\w.\-]+/g, '_');
  const path = `finance/${currentTenantId}/${yyyy}/${txnId || 'unfiled'}/${Date.now()}_${safe}`;
  const r = storageRef(storage, path);
  await uploadBytes(r, file, { contentType: file.type });
  return { backend: 'storage', path, url: await getDownloadURL(r), name: file.name, type: file.type };
}

async function uploadViaDrive(file, txnId) {
  const token = await window.financeAuth.getIdToken();
  const s = getState();
  const callApi = (body) => fetch('/api/finance?task=upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  }).then(async r => {
    if (!r.ok) throw new Error((await r.text()) || 'Upload failed');
    return r.json();
  });

  const init = await callApi({
    action: 'init', fileName: file.name, mimeType: file.type,
    txnId: txnId || 'unfiled', fy: fyOf(today(), s.settings.fyStartMonth),
  });
  // The browser sends the bytes straight to Google so they never pass through the 4.5 MB
  // Vercel request-body limit.
  const put = await fetch(init.sessionUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!put.ok) throw new Error('Drive upload failed');
  const uploaded = await put.json();
  const done = await callApi({ action: 'finish', fileId: uploaded.id });
  return { backend: 'drive', path: done.fileId, url: done.webViewLink, name: file.name, type: file.type };
}

export async function deleteAttachment(att) {
  if (att.backend === 'storage') {
    await deleteObject(storageRef(storage, att.path));
  } else {
    const token = await window.financeAuth.getIdToken();
    await fetch('/api/finance?task=upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: 'delete', fileId: att.path }),
    });
  }
}

// Adding a receipt after the fact is the only other change firestore.rules permits on a
// posted transaction, alongside marking it reversed.
export async function addAttachments(txnId, attachments) {
  const t = getState().txns.find(x => x.id === txnId);
  await updateDoc(doc(db, 'finance', currentTenantId, 'txns', txnId), {
    attachments: [...(t?.attachments || []), ...attachments],
  });
}

// ═══════ MASTER DATA ═══════

export async function saveSettings(patch) {
  await setDoc(root(), patch, { merge: true });
}

export async function saveParty(id, data) {
  const ref = id ? doc(db, 'finance', currentTenantId, 'parties', id) : doc(col('parties'));
  await setDoc(ref, { ...data, ...(id ? {} : { createdAt: Date.now() }) }, { merge: true });
  return ref.id;
}

export async function saveDeal(id, data) {
  const ref = id ? doc(db, 'finance', currentTenantId, 'deals', id) : doc(col('deals'));
  await setDoc(ref, { ...data, ...(id ? {} : { createdAt: Date.now() }) }, { merge: true });
  return ref.id;
}

export async function saveBankStatement(data) {
  const ref = doc(col('bankStatements'));
  await setDoc(ref, { ...data, importedAt: Date.now(), importedBy: currentUser?.email || 'unknown' });
  return ref.id;
}

export async function updateBankStatement(id, data) {
  await updateDoc(doc(db, 'finance', currentTenantId, 'bankStatements', id), data);
}

export async function removeDoc(collName, id) {
  await deleteDoc(doc(db, 'finance', currentTenantId, collName, id));
}

// Merging duplicate parties rewrites every journal line that points at the loser, then
// deletes it. Done in chunks because a Firestore batch caps at 500 writes.
export async function mergeParties(keepId, dropId) {
  const s = getState();
  const affected = s.txns.filter(t => t.lines.some(l => l.party === dropId));
  for (let i = 0; i < affected.length; i += 400) {
    const batch = writeBatch(db);
    for (const t of affected.slice(i, i + 400)) {
      batch.update(doc(db, 'finance', currentTenantId, 'txns', t.id), {
        lines: t.lines.map(l => l.party === dropId ? { ...l, party: keepId } : l),
      });
    }
    await batch.commit();
  }
  await deleteDoc(doc(db, 'finance', currentTenantId, 'parties', dropId));
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
    await setDoc(root(), { ...defaultSettings(), seededAt: Date.now() });
  }
  const accounts = await getDocs(query(col('accounts'), limit(1)));
  if (accounts.empty) {
    for (let i = 0; i < ACCOUNTS.length; i += 400) {
      const batch = writeBatch(db);
      for (const a of ACCOUNTS.slice(i, i + 400)) {
        batch.set(doc(db, 'finance', currentTenantId, 'accounts', a.code), a);
      }
      await batch.commit();
    }
  }
  return { settings: !snap.exists(), accounts: accounts.empty ? ACCOUNTS.length : 0 };
}

// ═══════ OPENING BALANCES ═══════

// Used once, when the books start. Posts ONE balanced journal against 3100 Opening balance
// equity, and creates the loan/asset master records the figures imply, all in one batch.
export async function postOpeningBalances({ date, lines, loans = [], assets = [], subscriptions = [] }) {
  const balanced = normalise(lines);
  const dr = balanced.reduce((a, l) => a + num(l.dr), 0);
  const cr = balanced.reduce((a, l) => a + num(l.cr), 0);
  const gap = Math.round((dr - cr) * 100) / 100;
  // Whatever the figures do not account for is the owner's stake on day one — that is
  // exactly what 3100 is for, so the entry always balances.
  if (Math.abs(gap) > 0.005) {
    balanced.push(gap > 0 ? { acc: '3100', cr: gap } : { acc: '3100', dr: -gap });
  }

  const batch = writeBatch(db);
  const tref = doc(col('txns'));
  batch.set(tref, stamp({
    date, event: 'opening', desc: 'Opening balances', lines: balanced, auto: true,
  }));
  for (const l of loans) batch.set(doc(col('loans')), { ...l, hasTxns: true, createdAt: Date.now() });
  for (const a of assets) batch.set(doc(col('assets')), { ...a, hasTxns: true, createdAt: Date.now() });
  for (const s of subscriptions) batch.set(doc(col('subscriptions')), { ...s, createdAt: Date.now() });
  batch.set(root(), { openingPosted: true, booksStartDate: date }, { merge: true });
  await batch.commit();
  return tref.id;
}

export { db, auth, storage };
