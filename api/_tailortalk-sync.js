// TailorTalk → CRM: the Firestore half of the sync. planUpdate() in _tailortalk-shared.js
// decides what to write; this finds the lead, reads what it needs and writes it atomically.
//
// Takes `db` as an argument (never imports firebase-admin itself) so the test suite can run it
// against an in-memory Firestore.
//
// Where things live:
//   leads/{id}                       the lead; TailorTalk's snapshot is the small `tt` map
//   leads/{id}/tailortalk/state      AI profile, bookings, payments, full conversation
//   leads/{id}/history, /notes       the same threads the team writes to, by "TailorTalk"
//   ttState/{tenantId}               server-only bookkeeping (last event, last test, backfill)
//   ttSignalEvents/{lead_signal_sec} every custom-trigger firing, append-only, for automations
//   ttDeadLetters/{auto}             payloads that could not be used, kept for a look later

import {
  planUpdate, isTestEnvelope, contactParts, phoneKey, ttLeadDocId, isBusinessCategory, BUSINESS_ENQUIRY_TYPE
} from './_tailortalk-shared.js';

// Stages and enquiry types change rarely; a warm function re-reading them on every chat
// message would double its reads for nothing.
const CONFIG_TTL_MS = 5 * 60 * 1000;
const configCache = new Map();

async function tenantConfig(db, tenantId, now) {
  const hit = configCache.get(tenantId);
  if (hit && now - hit.at < CONFIG_TTL_MS) return hit;
  const [pipe, settings] = await Promise.all([
    db.collection('pipelines').doc(tenantId).get(),
    db.collection('settings').doc(tenantId).get()
  ]);
  const stages = pipe.exists ? (pipe.data().stages || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)) : [];
  const enquiryTypes = settings.exists && Array.isArray(settings.data().enquiryTypes)
    ? settings.data().enquiryTypes
    : ['Property Enquiry', 'Seller Listing', 'General'];
  const entry = { at: now, stages, enquiryTypes };
  configCache.set(tenantId, entry);
  return entry;
}

export function _clearConfigCache() { configCache.clear(); }

// Leads typed in before this integration have no stored phoneKey, so the first time a
// TailorTalk number is not found we read the tenant's leads once, stamp phoneKey on the ones
// missing it, and remember that it was done. After that a lookup is one indexed query; the
// CRM page writes phoneKey on every save from now on.
async function findLeadRefByPhone(db, tenantId, key, now) {
  if (!key) return null;
  const leads = db.collection('leads');
  // One number is one person, so any lead on it is the lead — including one already carrying a
  // different TailorTalk conversation (planUpdate merges the two). If the team has typed the
  // number in twice, prefer the lead TailorTalk already feeds, then the most recently worked.
  const pick = docs => {
    const pool = docs.slice().sort((a, b) =>
      (Number(!!(b.data().tt && b.data().tt.id)) - Number(!!(a.data().tt && a.data().tt.id)))
      || ((b.data().updatedAt || 0) - (a.data().updatedAt || 0)));
    return pool[0] ? pool[0].ref : null;
  };

  const q = await leads.where('tenantId', '==', tenantId).where('phoneKey', '==', key).get();
  if (!q.empty) { const found = pick(q.docs); if (found) return found; }

  const stateRef = db.collection('ttState').doc(tenantId);
  const st = await stateRef.get();
  if (st.exists && st.data().phoneKeysBackfilledAt) return null;

  const all = await leads.where('tenantId', '==', tenantId).get();
  const matches = [];
  let batch = db.batch();
  let pending = 0;
  for (const doc of all.docs) {
    const l = doc.data();
    const k = phoneKey(l.phone);
    if (k && !l.phoneKey) {
      batch.update(doc.ref, { phoneKey: k });
      if (++pending === 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (k && k === key) matches.push(doc);
  }
  if (pending) await batch.commit();
  await stateRef.set({ phoneKeysBackfilledAt: now }, { merge: true });
  return matches.length ? pick(matches) : null;
}

// The lead a payload belongs to: by its TailorTalk id (a lead may hold several — tt.ids), then
// by phone number, else a new document. A live webhook carries no id, so it goes straight to the
// phone lookup; a lead first created that way is named after its number (contact_…).
async function resolveLeadRef(db, tenantId, ttId, key, contact, now) {
  const leads = db.collection('leads');
  if (ttId) {
    const own = leads.doc(ttLeadDocId(tenantId, ttId));
    if ((await own.get()).exists) return own;
    const inIds = await leads.where('tenantId', '==', tenantId).where('tt.ids', 'array-contains', ttId).limit(1).get();
    if (!inIds.empty) return inIds.docs[0].ref;
    const legacy = await leads.where('tenantId', '==', tenantId).where('tt.id', '==', ttId).limit(1).get();
    if (!legacy.empty) return legacy.docs[0].ref;
  }
  const byPhone = await findLeadRefByPhone(db, tenantId, key, now);
  if (byPhone) return byPhone;
  return leads.doc(ttLeadDocId(tenantId, ttId || placeholderId(key, contact)));
}
const placeholderId = (key, contact) => `contact_${key || String(contact || '').replace(/^@/, '')}`;

// ── "did anything actually change?" ──
// Key order is not guaranteed on a document read back from Firestore, so compare canonically.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
// Fields that record when/how an update was delivered rather than what the lead is.
const TT_DELIVERY = ['syncedAt', 'lastEventAt', 'lastTrigger'];
const STATE_DELIVERY = ['updatedAt', 'lastEventAt'];
const without = (obj, keys) => { const o = { ...(obj || {}) }; keys.forEach(k => delete o[k]); return o; };
const state0 = snap => (snap.exists ? snap.data() : null);

function sameAsStored(lead, leadWrite, state, stateWrite) {
  if (!lead || !state) return false;
  for (const [k, v] of Object.entries(leadWrite)) {
    const a = k === 'tt' ? without(v, TT_DELIVERY) : v;
    const b = k === 'tt' ? without(lead.tt, TT_DELIVERY) : lead[k];
    if (canonical(a) !== canonical(b)) return false;
  }
  return canonical(without(stateWrite, STATE_DELIVERY)) === canonical(without(state, STATE_DELIVERY));
}

let idSeq = 0;
function eventId(prefix, now) {
  idSeq = (idSeq + 1) % 1e6;
  return `${prefix}${now}tt${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Applies one webhook envelope. Throws only on a storage failure — the caller turns that into
 * a 5xx so TailorTalk retries. Anything wrong with the payload itself is dead-lettered.
 */
export async function applyTailorTalkEvent(db, tenantId, envelope, { now = Date.now(), signal = null } = {}) {
  const d = envelope && envelope.data;

  if (isTestEnvelope(envelope)) {
    await db.collection('ttState').doc(tenantId).set({
      lastTestAt: now,
      lastTestTrigger: (envelope && envelope.webhook_trigger) || null,
      lastTestSignal: signal || null
    }, { merge: true });
    return { ok: true, test: true, signal: signal || undefined };
  }

  const hadId = !!(d && d.id);
  if (!d || typeof d !== 'object' || (!hadId && !d.lead_contact)) {
    await db.collection('ttDeadLetters').add({
      tenantId, at: now, reason: 'No lead id or contact in the payload',
      body: JSON.stringify(envelope || null).slice(0, 50000)
    });
    return { ok: false, deadLettered: true };
  }

  const config = await tenantConfig(db, tenantId, now);
  const { stages } = config;
  // Vendors and collaborations need their enquiry type to exist before a lead can carry it —
  // add it to the tenant's list the first time one arrives (the Add/Edit form reads that list).
  if (isBusinessCategory(d.category) && !config.enquiryTypes.includes(BUSINESS_ENQUIRY_TYPE)) {
    config.enquiryTypes = [...config.enquiryTypes, BUSINESS_ENQUIRY_TYPE];
    await db.collection('settings').doc(tenantId).set({ enquiryTypes: config.enquiryTypes }, { merge: true });
  }
  const { enquiryTypes } = config;
  const { phoneKey: key } = contactParts(d.lead_contact);
  const ref = await resolveLeadRef(db, tenantId, hadId ? String(d.id) : null, key, d.lead_contact, now);
  const stateRef = ref.collection('tailortalk').doc('state');

  const result = await db.runTransaction(async t => {
    const [leadSnap, stateSnap] = [await t.get(ref), await t.get(stateRef)];
    const lead = leadSnap.exists ? leadSnap.data() : null;
    if (lead && lead.tenantId !== tenantId) throw new Error(`Lead ${ref.id} is not in tenant ${tenantId}`);
    // No id on the payload: it is the conversation this lead already has.
    if (!hadId) d.id = (lead && lead.tt && lead.tt.id) || placeholderId(key, d.lead_contact);

    const plan = planUpdate({
      envelope, lead, state: stateSnap.exists ? stateSnap.data() : null,
      leadId: ref.id, tenantId, stages, enquiryTypes, now, signal
    });

    // TailorTalk resends the whole lead on every update, and the daily sync re-reads it. When
    // nothing but the delivery bookkeeping differs, write nothing: no churn, no duplicate
    // history, and "Updated from TailorTalk" keeps meaning the last real change.
    if (!plan.isNew && !plan.history.length && sameAsStored(lead, plan.leadWrite, state0(stateSnap), plan.stateWrite)) {
      return { leadId: ref.id, created: false, stale: plan.stale, unchanged: true, history: 0 };
    }

    if (plan.isNew) t.set(ref, plan.leadWrite);
    else t.set(ref, plan.leadWrite, { merge: true });
    t.set(stateRef, plan.stateWrite);

    plan.history.forEach((h, i) => {
      const at = h.at || now + i;
      const id = eventId('h', at);
      t.set(ref.collection('history').doc(id), { id, type: h.type, text: h.text, at, by: 'TailorTalk' });
    });

    // Append-only log of custom-trigger firings, one document per moment — what automations,
    // alerts and reports ("unmet demand this month") are built on. The id is derived from the
    // moment, so a webhook retry rewrites the same document instead of adding a second.
    if (plan.signalEvent) {
      const e = plan.signalEvent;
      const eventRef = db.collection('ttSignalEvents').doc(`${ref.id}_${e.signal}_${Math.floor(e.at / 1000)}`);
      t.set(eventRef, { tenantId, leadId: ref.id, ...e, receivedAt: now, handledAt: null });
    }

    return { leadId: ref.id, created: plan.isNew, stale: plan.stale, history: plan.history.length };
  });

  if (envelope.webhook_trigger !== 'sync') {
    await db.collection('ttState').doc(tenantId).set({
      lastEventAt: now,
      lastTrigger: envelope.webhook_trigger || null,
      lastLeadId: result.leadId
    }, { merge: true });
  }

  return { ok: true, ...result };
}

// ─── pull: import, daily sync, "Sync TailorTalk" ─────────────────────────────
//
// get_leads returns the whole lead object — the same shape a webhook carries — so a pulled lead
// goes through exactly the same planUpdate as a live event. It is stamped with the time it was
// fetched: what TailorTalk returned at that moment is the newest truth, so it outranks any
// webhook that happened before it, and a webhook retry from before it cannot roll it back.

const GET_LEADS = 'https://api.tailortalk.ai/api/v1/get_leads';

/**
 * Fetches one page of leads (newest messages first) and applies each.
 *
 * @param {object} db
 * @param {string} tenantId
 * @param {string} token              TailorTalk agent token
 * @param {object} o
 * @param {?string} o.startAfter      ISO time from the previous page's `next`; null = newest
 * @param {number}  o.pageSize        ≤ 200
 * @param {?number} o.stopBefore      ms — stop at leads whose last message is older (daily sync)
 * @param {Function} o.fetchImpl      for tests
 * @returns {{ processed, created, updated, failed, errors, next, done }}
 */
export async function pullTailorTalkPage(db, tenantId, token, { startAfter = null, pageSize = 25, stopBefore = null, now = Date.now(), fetchImpl = fetch } = {}) {
  const body = { limit: Math.min(Math.max(pageSize, 1), 200) };
  if (startAfter) body.start_after = startAfter;
  const res = await fetchImpl(GET_LEADS, {
    method: 'POST',
    headers: { Authorization: `Agent ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TailorTalk get_leads answered ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const leads = (json && json.data && json.data.leads) || [];

  let processed = 0, created = 0, updated = 0, unchanged = 0, failed = 0, reachedOld = false;
  const errors = [];
  const changedLeadIds = [];
  for (const lead of leads) {
    const lastMsg = Date.parse(lead.last_message_time) || 0;
    if (stopBefore && lastMsg && lastMsg < stopBefore) { reachedOld = true; break; }
    try {
      const r = await applyTailorTalkEvent(db, tenantId, { webhook_trigger: 'sync', event_type: 'lead', occurred_at: new Date(now).toISOString(), data: lead }, { now });
      processed++;
      if (r.created) created++; else if (r.unchanged) unchanged++; else if (r.ok) updated++;
      if (r.ok && r.leadId && !r.unchanged) changedLeadIds.push(r.leadId);
    } catch (e) {
      failed++;
      errors.push({ id: lead.id, error: String((e && e.message) || e).slice(0, 200) });
    }
  }

  // get_leads returns leads who messaged BEFORE start_after. Leads sharing the boundary second
  // would be skipped, so the next page starts one second later — re-applying the last lead
  // of this page is harmless (every write is idempotent).
  const last = leads[leads.length - 1];
  const lastTime = last && Date.parse(last.last_message_time);
  const next = lastTime ? new Date(lastTime + 1000).toISOString() : null;
  const done = reachedOld || leads.length < body.limit || !next || (startAfter && next >= startAfter);
  return { processed, created, updated, unchanged, failed, errors, changedLeadIds, next: done ? null : next, done: !!done, fetched: leads.length };
}
