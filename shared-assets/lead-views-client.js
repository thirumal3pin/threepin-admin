// Lead views in the browser (shared-assets/lead-views.js says what they are and why).
//
//   const views = leadViews(db);
//   views.watch(tenantId, onLeads, onError)   every lead, live — onLeads(list, fromServer): from the
//                                              view documents (a read per ~20 leads), or from the
//                                              leads collection while the views are not built or
//                                              are switched off. fromServer: false while the list
//                                              is still the browser's local copy (automatic writers
//                                              wait for true). One call per change, however many
//                                              documents it touched. Returns the unsubscribe.
//   views.save(tenantId, leadRef, data, mode)  a lead write AND its row in one batch — all or
//                                              nothing. A save never fails because of the views:
//                                              if the row cannot be written (rules not yet live,
//                                              the layout not yet confirmed), the lead is saved
//                                              and its row is put right as soon as it can be.
//   views.heal(tenantId, leadId, shown)        a transaction: the lead read and its row rewritten if
//                                              it differs from what the page shows; a deleted
//                                              lead's row removed
//   views.readAll(tenantId)                    every lead, once
//
// mode, as the lead is written: 'merge' (setDoc merge) · 'update' (updateDoc; keys are field paths)
// · 'paths' (data = [[segments], value] pairs from diffPaths — an update, so it never re-creates a
// lead deleted meanwhile) · 'replace' (setDoc) · 'delete'.

import {
  doc, collection, query, where, onSnapshot, getDoc, getDocs, writeBatch, runTransaction, deleteField, serverTimestamp, FieldPath
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import * as LV from './lead-views.js';

const REFUSED_FOR = 10 * 60000;   // rows refused (rules not live): try them again after this

export function leadViews(db) {
  // meta: the newest layout seen (perhaps from the local copy) — what the page READS.
  // wmeta: the layout the SERVER confirmed — the only one WRITES follow, so a stale local copy can
  // never send a row to a set that was retired.
  let meta = null, wmeta = null, wKnown = false, watching = false, refusedUntil = 0, metaDown = false;
  let waiters = [];
  const pendingHeal = new Map();   // leadId → tenantId: saved without its row, to put right
  const confirm = m => { wmeta = m; wKnown = true; metaDown = false; waiters.forEach(f => f(true)); waiters = []; flushHeals(); };
  // The layout cannot be read (an error, not just slow): nobody waits for it — saves go alone and
  // are put right when it is read again.
  const layoutDown = () => { metaDown = true; waiters.forEach(f => f(false)); waiters = []; };
  // Before the layout is confirmed (a moment after the page opens), a save waits for it — up to
  // 3 s. A page that does not watch asks once.
  async function layoutReady(tenantId) {
    if (wKnown) return true;
    if (metaDown) return false;
    if (!watching) {
      try { const s = await getDoc(doc(db, LV.VIEWS, LV.metaId(tenantId))); if (!s.metadata || !s.metadata.fromCache) { const d = s.exists() ? s.data() : null; confirm(d && d.version && d.shards ? d : null); return true; } }
      catch (e) { /* unreadable: saved without rows, put right later */ }
      return false;
    }
    return new Promise(res => {
      const t = setTimeout(() => res(false), 3000);
      waiters.push(ok => { clearTimeout(t); res(ok); });
    });
  }
  const rowsAllowed = () => wKnown && !!wmeta && Date.now() >= refusedUntil;

  function addRows(batchOrTx, tenantId, leadId, data, mode) {
    for (const tg of LV.targetsOf(wmeta)) {
      const ref = doc(db, LV.VIEWS, LV.shardId(tenantId, tg.version, LV.shardOf(leadId, tg.shards)));
      if (mode === 'delete') batchOrTx.set(ref, { tenantId, rows: { [leadId]: deleteField() } }, { merge: true });
      else if (mode === 'merge') batchOrTx.set(ref, { tenantId, rows: { [leadId]: { ...LV.rowOf(data), [LV.WROTE]: serverTimestamp() } } }, { merge: true });
      else if (mode === 'replace') batchOrTx.set(ref, { tenantId, rows: { [leadId]: { ...LV.rowOf(data), [LV.WROTE]: serverTimestamp() } } }, { mergeFields: ['tenantId', new FieldPath('rows', leadId)] });
      else {
        const pairs = mode === 'paths' ? LV.rowPairs(data) : LV.patchPaths(data);
        if (!pairs.length) continue;
        const nested = LV.nest(pairs); nested[LV.WROTE] = serverTimestamp();
        batchOrTx.set(ref, { tenantId, rows: { [leadId]: nested } },
          { mergeFields: ['tenantId', ...pairs.map(([seg]) => new FieldPath('rows', leadId, ...seg)), new FieldPath('rows', leadId, LV.WROTE)] });
      }
    }
  }
  function addLead(b, ref, data, mode) {
    if (mode === 'paths') {
      const [[s0, v0], ...rest] = data;
      b.update(ref, new FieldPath(...s0), v0, ...rest.flatMap(([s, v]) => [new FieldPath(...s), v]));
    }
    else if (mode === 'update') b.update(ref, data);
    else if (mode === 'merge') b.set(ref, data, { merge: true });
    else if (mode === 'replace') b.set(ref, data);
    else b.delete(ref);
  }
  async function leadOnly(ref, data, mode) { const b = writeBatch(db); addLead(b, ref, data, mode); await b.commit(); }

  async function heal(tenantId, leadId, shown) {
    if (!tenantId || !rowsAllowed()) return 'skipped';
    try {
      return await runTransaction(db, async t => {
        const s = await t.get(doc(db, 'leads', leadId));
        if (!s.exists()) { addRows(t, tenantId, leadId, null, 'delete'); return 'removed'; }
        const lead = s.data();
        if (shown && sameLead(LV.rowOf(lead), LV.rowOf(shown))) return 'same';
        addRows(t, tenantId, leadId, lead, 'replace');
        return 'healed';
      });
    } catch (e) { console.error('Lead view check failed:', e); return 'failed'; }
  }
  let flushing = false;
  async function flushHeals() {
    if (flushing || !pendingHeal.size || !rowsAllowed()) return;
    flushing = true;
    try {
      for (const [leadId, tenantId] of [...pendingHeal]) {
        const r = await heal(tenantId, leadId, null);
        if (r !== 'failed' && r !== 'skipped') pendingHeal.delete(leadId);
      }
    } finally { flushing = false; }
  }

  return {
    meta: () => meta,

    watch(tenantId, onLeads, onError) {
      watching = true;
      let shardUnsubs = [], collUnsub = null, metaUnsub = null, key = '', docs = [], live = [];
      let collList = null, collLive = false, source = null;   // 'views' | 'coll'
      let stopped = false, retry = 0, retryTimer = null, emitTimer = null;
      // One call per change: the documents a change touches (and the local copy being confirmed
      // document by document on open) arrive as separate events within a few milliseconds.
      const emit = () => {
        if (emitTimer) return;
        emitTimer = setTimeout(() => {
          emitTimer = null;
          if (stopped) return;
          // Each emit hands out its own copies: a page that changes a lead in place (a nested map)
          // can never alter the documents this listener keeps, nor the next emit's leads.
          const own = list => (typeof structuredClone === 'function' ? structuredClone(list) : JSON.parse(JSON.stringify(list)));
          if (source === 'views' && docs.length && docs.every(Boolean)) onLeads(own(LV.rowsToLeads(docs)), live.every(Boolean));
          else if (source === 'coll' && collList) onLeads(own(collList), collLive);
        }, 30);
      };
      const stopShards = () => { shardUnsubs.forEach(u => u()); shardUnsubs = []; key = ''; docs = []; };
      const stopColl = () => { if (collUnsub) { collUnsub(); collUnsub = null; } collList = null; };
      // The views could not be read (a network blip, the quota out for the day, rules not live):
      // the leads collection carries the page meanwhile — it is never torn down to retry — and
      // only the layout is asked again, waiting longer each time (30 s … 10 min; an hour when
      // refused outright).
      const again = (refused) => {
        if (stopped || retryTimer) return;
        const wait = refused ? 3600000 : Math.min(600000, 30000 * Math.pow(2, retry++));
        retryTimer = setTimeout(() => { retryTimer = null; if (!stopped) { if (metaUnsub) metaUnsub(); startMeta(); } }, wait);
      };
      const useCollection = () => {
        stopShards();
        source = 'coll';
        if (collUnsub) { emit(); return; }
        let wasLive = null;
        // includeMetadataChanges: told also when the local copy is confirmed by the server with nothing
        // else changed (fromServer turns true); a save's own echo (metadata only) is skipped.
        collUnsub = onSnapshot(query(collection(db, 'leads'), where('tenantId', '==', tenantId)), { includeMetadataChanges: true },
          s => {
            const isLive = !s.metadata.fromCache;
            if (isLive === wasLive && !s.docChanges().length) return;
            wasLive = isLive;
            collList = s.docs.map(d => ({ ...d.data(), id: d.id })); collLive = isLive;
            if (source === 'coll') emit();
          },
          e => { collUnsub = null; if (onError) onError(e); });
      };
      const useViews = m => {
        const k = m.version + ':' + m.shards;
        if (k === key) return;
        stopShards(); key = k;
        docs = new Array(m.shards).fill(null); live = new Array(m.shards).fill(false);
        for (let i = 0; i < m.shards; i++) {
          let was = null;
          shardUnsubs.push(onSnapshot(doc(db, LV.VIEWS, LV.shardId(tenantId, m.version, i)), { includeMetadataChanges: true }, s => {
            if (key !== k) return;
            const isLive = !s.metadata.fromCache;
            // Not in the local copy is "not known yet", not "empty": wait for the server.
            if (!s.exists() && !isLive) return;
            const data = s.exists() ? s.data() : { rows: {} };
            // The rows without their write stamps: a save's own echo (the stamp landing on the
            // server) changes nothing a page shows, so it does not redraw the page again.
            const json = JSON.stringify(data.rows || {}, (k, v) => (k === LV.WROTE ? undefined : v));
            if (was && was.live === isLive && was.json === json) return;
            was = { live: isLive, json };
            docs[i] = data; live[i] = isLive;
            // Every view document in: the views take over from the collection (if it was on).
            if (docs.every(Boolean)) {
              source = 'views';
              if (live.every(Boolean)) { retry = 0; stopColl(); }
              emit();
            }
          }, e => {
            if (key !== k) return;   // this set already given up (one message, not one per document)
            console.error('Lead views failed — reading the leads directly for now:', e);
            useCollection(); again(e && e.code === 'permission-denied');
          }));
        }
      };
      const startMeta = () => {
        let wasLive = null;
        metaUnsub = onSnapshot(doc(db, LV.VIEWS, LV.metaId(tenantId)), { includeMetadataChanges: true }, s => {
          const isLive = !s.metadata.fromCache;
          const d = s.exists() ? s.data() : null;
          const m = d && d.version && d.shards ? d : null;
          if (wasLive === isLive && JSON.stringify(m) === JSON.stringify(meta)) return;
          wasLive = isLive;
          meta = m;
          // Writes follow the views whenever they exist — switched off or not — so switching them
          // on again is safe at any moment; reading follows the switch.
          if (isLive) confirm(m);
          if (meta && !meta.off) useViews(meta); else useCollection();
        }, e => {
          console.error('Lead views unreadable — reading the leads directly for now:', e);
          layoutDown();
          useCollection(); again(e && e.code === 'permission-denied');
        });
      };
      startMeta();
      return () => { stopped = true; clearTimeout(retryTimer); clearTimeout(emitTimer); if (metaUnsub) metaUnsub(); stopShards(); stopColl(); };
    },

    async save(tenantId, ref, data, mode) {
      if (mode === 'paths' && !(data && data.length)) return;   // nothing changed
      const ready = tenantId ? await layoutReady(tenantId) : false;
      if (ready && rowsAllowed()) {
        const b = writeBatch(db);
        addLead(b, ref, data, mode);
        addRows(b, tenantId, ref.id, data, mode);
        try { await b.commit(); return; }
        catch (e) {
          // Refused (rules not yet live) or failed (a view document at a Firestore limit): the
          // lead itself, or only its row? Try the lead alone.
          try { await leadOnly(ref, data, mode); }
          catch (e2) {
            // The lead itself was refused — most likely deleted by someone else meanwhile: its row
            // is checked (and removed if so). The views are fine; nothing is switched off.
            if (mode !== 'replace' && mode !== 'merge') heal(tenantId, ref.id, null);
            throw e2;
          }
          // Only the row failed (the rules not live yet; a view document at a limit): rows rest
          // for a while, and this lead's row is put right when they can be written.
          refusedUntil = Date.now() + REFUSED_FOR;
          setTimeout(flushHeals, REFUSED_FOR + 1000);
          console.error('Lead view rows refused — saving leads alone for now:', e);
          pendingHeal.set(ref.id, tenantId);
          return;
        }
      }
      await leadOnly(ref, data, mode);
      // Saved without its row while views may exist: put right as soon as the layout is known.
      if (tenantId && (!ready || wmeta)) { pendingHeal.set(ref.id, tenantId); flushHeals(); }
    },

    heal: (tenantId, leadId, shown) => heal(tenantId, leadId, shown),

    async readAll(tenantId) {
      const ms = await getDoc(doc(db, LV.VIEWS, LV.metaId(tenantId))).catch(() => null);
      const d = ms && ms.exists() ? ms.data() : null;
      if (d && d.version && d.shards && !d.off) {
        const snaps = await Promise.all(Array.from({ length: d.shards }, (_, i) => getDoc(doc(db, LV.VIEWS, LV.shardId(tenantId, d.version, i))))).catch(() => null);
        if (snaps && snaps.every(s => s.exists())) return LV.rowsToLeads(snaps.map(s => s.data()));
      }
      const q = await getDocs(query(collection(db, 'leads'), where('tenantId', '==', tenantId)));
      return q.docs.map(x => ({ ...x.data(), id: x.id }));
    }
  };
}

// Two copies of a lead the same? (key order and the page-added id aside)
const canon = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, k) => (o[k] = canon(v[k]), o), {}) : Array.isArray(v) ? v.map(canon) : v);
const sameLead = (a, b) => { const x = { ...a }, y = { ...b }; delete x.id; delete y.id; return JSON.stringify(canon(x)) === JSON.stringify(canon(y)); };
