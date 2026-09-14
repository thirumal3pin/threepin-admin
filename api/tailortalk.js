// The TailorTalk integration's single HTTP route (the Hobby plan allows 12 functions and this
// project uses all of them — see api/finance.js). Lead automation lives here too, behind
// ?action=, because its input is TailorTalk's conversations.
//
//   POST /api/tailortalk?action=webhook&key=<TAILORTALK_WEBHOOK_KEY>
//        TailorTalk → Developer → Webhooks. Tick First Message, Every Message, On Warm,
//        On Hot and On Converted on ONE webhook pointing here (NOT Custom — TailorTalk sends
//        one request per update, so a custom match on that webhook is indistinguishable
//        from an ordinary message).
//
//   POST /api/tailortalk?action=webhook&key=…&signal=<name>
//        One webhook per Custom trigger condition, only Custom ticked. The signal name is
//        how the CRM knows which condition fired (see SIGNALS in _tailortalk-shared.js).
//
// TailorTalk does not sign its webhooks, so the only proof a call is genuine is the secret key
// in the URL. It retries on 5xx and drops the event for good on 4xx, which is why a storage
// failure answers 500 and a useless payload is dead-lettered with 200 instead of a 400.
//
//   GET  /api/tailortalk?action=sync     Vercel Cron (Bearer CRON_SECRET), once a day: pulls
//        every lead TailorTalk has touched since the last completed sync (minus a day of
//        overlap) and applies it exactly like a webhook — anything a webhook missed is fixed.
//   POST /api/tailortalk?action=sync     the CRM's "Sync TailorTalk" button (Firebase login):
//        one page per call, { startAfter } → { next, done }; the page walks every lead.
//   POST /api/tailortalk?action=refresh  the CRM on open and every few minutes (login): the
//        newest page of TailorTalk leads, then whatever lead automation is due.
//   POST /api/tailortalk?action=ai-lead  "Re-check" on a lead page (login): { leadId }.
//   POST /api/tailortalk?action=admin-ai maintenance (Bearer CRM_ADMIN_KEY): preview or apply
//        lead automation over many leads, { apply, leadIds?, cursor?, limit? }.
//
// Lead automation (when settings/{tenant}.leadAutomation.enabled): after a webhook the lead is
// queued; more messages push its read back until the chat has been quiet for 2 minutes (at most
// 10 minutes after the first unread message). Every webhook, CRM refresh and the nightly sync
// reads whatever is due (api/_lead-automation.js), after the webhook has already been answered
// (waitUntil), so TailorTalk never waits on the AI.
//
// Environment (Vercel → Settings → Environment Variables):
//   TAILORTALK_WEBHOOK_KEY   a long random string; the same one goes in the webhook URL
//   TAILORTALK_TENANT_ID     the CRM tenant these leads belong to (e.g. t_3pinrealty)
//   TAILORTALK_AGENT_TOKEN   TailorTalk → Developer → API Keys (for the pull)
//   ANTHROPIC_API_KEY        Claude, for lead automation (already set for AI summaries)
//   CRM_ADMIN_KEY            maintenance actions only
//   CRON_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON  already set for the other functions

import { createHash, timingSafeEqual } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { applyTailorTalkEvent, pullTailorTalkPage } from './_tailortalk-sync.js';
import { normaliseSignal } from './_tailortalk-shared.js';
import {
  automationSettings, runLeadAutomation, queueLeadAutomation, drainQueue
} from './_lead-automation.js';

export const maxDuration = 60;
const SYNC_BUDGET_MS = 40000;
const SYNC_OVERLAP_MS = 24 * 3600000;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

function keyMatches(given, expected) {
  const a = createHash('sha256').update(String(given || '')).digest();
  const b = createHash('sha256').update(String(expected || '')).digest();
  return timingSafeEqual(a, b);
}

let _anthropic;
function claude() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}
// Several CRM tabs refresh every few minutes; TailorTalk is pulled at most this often per tenant.
const REFRESH_PULL_EVERY_MS = 2 * 60000;

// After the webhook has been answered: queue this lead (it is read once its chat goes quiet) and
// read a few leads whose chats already have. Nothing sleeps waiting for a quiet period — the next
// webhook, the CRM's refresh or the nightly sync picks this lead up.
function scheduleAutomation(db, tenantId, leadId, model) {
  waitUntil((async () => {
    await queueLeadAutomation(db, tenantId, leadId, { now: Date.now() });
    await drainQueue(db, tenantId, { client: claude(), model, budgetMs: 30000, maxRuns: 3, trigger: 'webhook' });
  })().catch(e => console.error('lead automation after webhook failed:', leadId, e)));
}

async function webhookPost(request, url) {
  const expected = process.env.TAILORTALK_WEBHOOK_KEY;
  const tenantId = process.env.TAILORTALK_TENANT_ID;
  if (!expected || !tenantId) {
    // Not configured yet: a 5xx so TailorTalk keeps retrying for a while instead of dropping.
    console.error('tailortalk webhook: TAILORTALK_WEBHOOK_KEY or TAILORTALK_TENANT_ID is not set');
    return json({ ok: false, error: 'Not configured' }, 503);
  }
  if (!keyMatches(url.searchParams.get('key'), expected)) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  const db = getDb();
  const text = await request.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    await db.collection('ttDeadLetters').add({
      tenantId, at: Date.now(), reason: 'Body is not JSON', body: text.slice(0, 50000)
    }).catch(e => console.error('tailortalk dead-letter write failed:', e));
    return json({ ok: false, deadLettered: true });
  }

  let result;
  try {
    // A malformed signal name is ignored rather than refused: the update itself is still good.
    const signal = normaliseSignal(url.searchParams.get('signal'));
    result = await applyTailorTalkEvent(db, tenantId, envelope, { signal });
  } catch (e) {
    console.error('tailortalk webhook failed:', e);
    return json({ ok: false, error: 'Temporary failure, please retry' }, 500);
  }

  if (result.ok && result.leadId && !result.test && !result.unchanged) {
    try {
      const auto = await automationSettings(db, tenantId);
      if (auto.enabled) scheduleAutomation(db, tenantId, result.leadId, auto.model);
    } catch (e) {
      console.error('lead automation scheduling failed:', e);
    }
  }
  return json(result);
}

// The daily run: as many pages as fit in the time budget, newest first, stopping at leads that
// have not messaged since a day before the last completed sync.
async function syncCron(request) {
  const auth = request.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return json({ ok: false, error: 'Unauthorized' }, 401);
  const tenantId = process.env.TAILORTALK_TENANT_ID;
  const token = process.env.TAILORTALK_AGENT_TOKEN;
  if (!tenantId || !token) return json({ ok: false, error: 'TAILORTALK_TENANT_ID or TAILORTALK_AGENT_TOKEN is not set' }, 503);

  const db = getDb();
  const started = Date.now();
  const stateRef = db.collection('ttState').doc(tenantId);
  const st = (await stateRef.get()).data() || {};
  const stopBefore = st.lastSyncCompletedAt ? st.lastSyncCompletedAt - SYNC_OVERLAP_MS : null;

  const total = { pages: 0, processed: 0, created: 0, updated: 0, unchanged: 0, failed: 0, errors: [] };
  const changed = [];
  let startAfter = null, done = false;
  try {
    while (!done && Date.now() - started < SYNC_BUDGET_MS) {
      const page = await pullTailorTalkPage(db, tenantId, token, { startAfter, pageSize: 50, stopBefore, now: Date.now() });
      total.pages++; total.processed += page.processed; total.created += page.created; total.updated += page.updated; total.unchanged += page.unchanged; total.failed += page.failed;
      total.errors.push(...page.errors.slice(0, 5));
      changed.push(...page.changedLeadIds);
      done = page.done; startAfter = page.next;
    }
  } catch (e) {
    console.error('tailortalk sync failed:', e);
    await stateRef.set({ lastSyncAt: started, lastSyncError: String((e && e.message) || e).slice(0, 300) }, { merge: true });
    return json({ ok: false, error: 'Sync failed', ...total }, 500);
  }
  // Queue what changed, then read what is due with the time left, so the morning digest sees
  // fresh reads; anything left over is read by the first CRM refresh.
  let queued = 0, aiRan = 0;
  const auto = await automationSettings(db, tenantId);
  if (auto.enabled) {
    for (const leadId of changed) { await queueLeadAutomation(db, tenantId, leadId, { now: Date.now(), quietMs: 0 }); queued++; }
    const left = 52000 - (Date.now() - started);
    if (left > 5000) aiRan = (await drainQueue(db, tenantId, { client: claude(), model: auto.model, budgetMs: left - 5000, trigger: 'nightly' })).ran;
  }
  await stateRef.set({
    lastSyncAt: started,
    lastSyncError: null,
    lastSyncResult: { ...total, errors: total.errors.slice(0, 10), done, aiQueued: queued, aiRan },
    ...(done ? { lastSyncCompletedAt: started } : {})
  }, { merge: true });
  return json({ ok: true, done, ...total, aiQueued: queued, aiRan });
}

async function crmUser(request) {
  const user = await verifyCrmUser(request);
  const tenantId = process.env.TAILORTALK_TENANT_ID;
  return user && user.tenantId && user.tenantId === tenantId ? user : null;
}

// One page for the CRM's button; the page loops on `next` until `done`.
async function syncPost(request) {
  const user = await crmUser(request);
  if (!user) return json({ ok: false, error: 'Unauthorized' }, 401);
  const tenantId = user.tenantId;
  const token = process.env.TAILORTALK_AGENT_TOKEN;
  if (!token) return json({ ok: false, error: 'TAILORTALK_AGENT_TOKEN is not set in Vercel' }, 503);

  let body = {};
  try { body = await request.json(); } catch { /* first page */ }
  const startAfter = typeof body.startAfter === 'string' && !Number.isNaN(Date.parse(body.startAfter)) ? body.startAfter : null;
  const db = getDb();
  const started = Date.now();
  try {
    const page = await pullTailorTalkPage(db, tenantId, token, { startAfter, pageSize: 25, now: started });
    // Queue, don't read: a full sync can change many leads and the refresh drains the queue.
    const auto = await automationSettings(db, tenantId);
    if (auto.enabled) for (const leadId of page.changedLeadIds) await queueLeadAutomation(db, tenantId, leadId, { now: Date.now(), quietMs: 0 });
    if (page.done) {
      await db.collection('ttState').doc(tenantId).set({ lastSyncAt: started, lastSyncCompletedAt: started, lastSyncError: null, lastSyncBy: user.email || null }, { merge: true });
    }
    const { changedLeadIds, ...rest } = page;
    return json({ ok: true, ...rest, changed: changedLeadIds.length });
  } catch (e) {
    console.error('tailortalk sync page failed:', e);
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 502);
  }
}

async function claimRefreshPull(db, tenantId, now) {
  const ref = db.collection('ttState').doc(tenantId);
  return db.runTransaction(async t => {
    const snap = await t.get(ref);
    const last = (snap.exists && snap.data().lastRefreshPullAt) || 0;
    if (now - last < REFRESH_PULL_EVERY_MS) return false;
    t.set(ref, { lastRefreshPullAt: now }, { merge: true });
    return true;
  });
}

// The CRM calls this when it opens and every few minutes: fresh TailorTalk data, then due AI runs.
async function refreshPost(request) {
  const user = await crmUser(request);
  if (!user) return json({ ok: false, error: 'Unauthorized' }, 401);
  const tenantId = user.tenantId;
  const token = process.env.TAILORTALK_AGENT_TOKEN;
  const db = getDb();
  const started = Date.now();
  const out = { ok: true };
  try {
    const auto = await automationSettings(db, tenantId);
    out.automation = auto.enabled;
    // Webhooks already deliver changes as they happen; the pull only catches a missed one, so
    // several open tabs share one pull every couple of minutes.
    if (token && await claimRefreshPull(db, tenantId, started)) {
      const page = await pullTailorTalkPage(db, tenantId, token, { pageSize: 25, now: started });
      out.pulled = page.processed; out.created = page.created; out.updated = page.updated;
      if (auto.enabled) for (const leadId of page.changedLeadIds) await queueLeadAutomation(db, tenantId, leadId, { now: Date.now(), quietMs: 0 });
    }
    if (auto.enabled) {
      const drained = await drainQueue(db, tenantId, { client: claude(), model: auto.model, budgetMs: Math.max(0, 42000 - (Date.now() - started)), trigger: 'refresh' });
      out.aiDue = drained.due; out.aiRan = drained.ran; out.rateLimited = !!drained.rateLimited;
      out.moved = drained.results.filter(r => r.moved).length;
    }
    return json(out);
  } catch (e) {
    console.error('tailortalk refresh failed:', e);
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 502);
  }
}

// "Re-check" on one lead.
async function aiLeadPost(request) {
  const user = await crmUser(request);
  if (!user) return json({ ok: false, error: 'Unauthorized' }, 401);
  let body = {};
  try { body = await request.json(); } catch { /* validated below */ }
  if (!body.leadId || typeof body.leadId !== 'string') return json({ ok: false, error: 'leadId required' }, 400);
  const db = getDb();
  const auto = await automationSettings(db, user.tenantId);
  try {
    // A person asked for a fresh read, so it is made even if nothing new has been said.
    const r = await runLeadAutomation(db, user.tenantId, body.leadId, { client: claude(), model: auto.model, force: true, trigger: `recheck:${(user.email || '').split('@')[0]}` });
    return json({ ok: r.ok !== false, ...r });
  } catch (e) {
    console.error('ai-lead failed:', e);
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 502);
  }
}

// Maintenance: preview or apply automation over many leads, within one request's time budget.
async function adminAiPost(request) {
  const auth = request.headers.get('authorization') || '';
  const key = process.env.CRM_ADMIN_KEY;
  if (!key || !keyMatches(auth.replace(/^Bearer\s+/i, ''), key)) return json({ ok: false, error: 'Unauthorized' }, 401);
  const tenantId = process.env.TAILORTALK_TENANT_ID;
  let body = {};
  try { body = await request.json(); } catch { /* defaults */ }
  const apply = body.apply === true;
  const limit = Math.min(Math.max(Number(body.limit) || 8, 1), 25);
  const db = getDb();
  const auto = await automationSettings(db, tenantId);
  const model = typeof body.model === 'string' && body.model ? body.model : auto.model;
  const started = Date.now();

  let ids;
  if (Array.isArray(body.leadIds) && body.leadIds.length) {
    ids = body.leadIds.slice(0, limit);
  } else {
    const snap = await db.collection('leads').where('tenantId', '==', tenantId).get();
    const all = snap.docs.map(d => d.data()).filter(l => l.tt && l.tt.id).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const after = typeof body.cursor === 'string' ? body.cursor : '';
    ids = all.filter(l => String(l.id) > after).slice(0, limit).map(l => l.id);
  }

  const results = [];
  let cursor = typeof body.cursor === 'string' ? body.cursor : null;
  let rateLimited = null;
  for (const leadId of ids) {
    if (Date.now() - started > 45000) break;
    let r;
    try {
      // A preview always asks; a backfill skips leads already read on the same evidence unless
      // { force: true } (e.g. after a prompt change the evidence key changes anyway).
      r = await runLeadAutomation(db, tenantId, leadId, { client: claude(), model, apply, force: !apply || body.force === true, trigger: apply ? 'backfill' : 'preview' });
    } catch (e) {
      r = { leadId, ok: false, error: String((e && e.message) || e).slice(0, 300) };
    }
    // Rate limited: stop here and leave the cursor before this lead, so the next call resumes it.
    if (r.retry) { rateLimited = { leadId, retryAfterMs: r.retryAfterMs || 60000 }; break; }
    results.push(r);
    cursor = leadId;
  }
  const finished = results.length === ids.length;
  return json({ ok: true, apply, model, count: results.length, cursor, rateLimited, done: finished && ids.length < limit && !(Array.isArray(body.leadIds) && body.leadIds.length), results });
}

export async function POST(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'webhook';
  if (action === 'webhook') return webhookPost(request, url);
  if (action === 'sync') return syncPost(request);
  if (action === 'refresh') return refreshPost(request);
  if (action === 'ai-lead') return aiLeadPost(request);
  if (action === 'admin-ai') return adminAiPost(request);
  return json({ ok: false, error: 'Unknown action' }, 404);
}

// ?action=sync is the daily cron. Without it, lets someone confirm the route is deployed from a
// browser — it says nothing about configuration.
export async function GET(request) {
  const action = request ? new URL(request.url).searchParams.get('action') : null;
  if (action === 'sync') return syncCron(request);
  return json({ ok: true, service: 'tailortalk' });
}
