// The TailorTalk integration's single HTTP route (the Hobby plan allows 12 functions and this
// project uses all of them — see api/finance.js). Later actions (sync, templates, send,
// convert) join this file behind ?action= rather than becoming routes of their own.
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
//
// Environment (Vercel → Settings → Environment Variables):
//   TAILORTALK_WEBHOOK_KEY   a long random string; the same one goes in the webhook URL
//   TAILORTALK_TENANT_ID     the CRM tenant these leads belong to (e.g. t_3pinrealty)
//   TAILORTALK_AGENT_TOKEN   TailorTalk → Developer → API Keys (for the pull)
//   CRON_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON  already set for the other functions

import { createHash, timingSafeEqual } from 'node:crypto';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { applyTailorTalkEvent, pullTailorTalkPage } from './_tailortalk-sync.js';
import { normaliseSignal } from './_tailortalk-shared.js';

export const maxDuration = 60;
const SYNC_BUDGET_MS = 45000;
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

  try {
    // A malformed signal name is ignored rather than refused: the update itself is still good.
    const signal = normaliseSignal(url.searchParams.get('signal'));
    const result = await applyTailorTalkEvent(db, tenantId, envelope, { signal });
    return json(result);
  } catch (e) {
    console.error('tailortalk webhook failed:', e);
    return json({ ok: false, error: 'Temporary failure, please retry' }, 500);
  }
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
  let startAfter = null, done = false;
  try {
    while (!done && Date.now() - started < SYNC_BUDGET_MS) {
      const page = await pullTailorTalkPage(db, tenantId, token, { startAfter, pageSize: 50, stopBefore, now: Date.now() });
      total.pages++; total.processed += page.processed; total.created += page.created; total.updated += page.updated; total.unchanged += page.unchanged; total.failed += page.failed;
      total.errors.push(...page.errors.slice(0, 5));
      done = page.done; startAfter = page.next;
    }
  } catch (e) {
    console.error('tailortalk sync failed:', e);
    await stateRef.set({ lastSyncAt: started, lastSyncError: String((e && e.message) || e).slice(0, 300) }, { merge: true });
    return json({ ok: false, error: 'Sync failed', ...total }, 500);
  }
  await stateRef.set({
    lastSyncAt: started,
    lastSyncError: null,
    lastSyncResult: { ...total, errors: total.errors.slice(0, 10), done },
    ...(done ? { lastSyncCompletedAt: started } : {})
  }, { merge: true });
  return json({ ok: true, done, ...total });
}

// One page for the CRM's button; the page loops on `next` until `done`.
async function syncPost(request) {
  const user = await verifyCrmUser(request);
  const tenantId = process.env.TAILORTALK_TENANT_ID;
  if (!user || !user.tenantId || user.tenantId !== tenantId) return json({ ok: false, error: 'Unauthorized' }, 401);
  const token = process.env.TAILORTALK_AGENT_TOKEN;
  if (!token) return json({ ok: false, error: 'TAILORTALK_AGENT_TOKEN is not set in Vercel' }, 503);

  let body = {};
  try { body = await request.json(); } catch { /* first page */ }
  const startAfter = typeof body.startAfter === 'string' && !Number.isNaN(Date.parse(body.startAfter)) ? body.startAfter : null;
  const db = getDb();
  const started = Date.now();
  try {
    const page = await pullTailorTalkPage(db, tenantId, token, { startAfter, pageSize: 25, now: started });
    if (page.done) {
      await db.collection('ttState').doc(tenantId).set({ lastSyncAt: started, lastSyncCompletedAt: started, lastSyncError: null, lastSyncBy: user.email || null }, { merge: true });
    }
    return json({ ok: true, ...page });
  } catch (e) {
    console.error('tailortalk sync page failed:', e);
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 502);
  }
}

export async function POST(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'webhook';
  if (action === 'webhook') return webhookPost(request, url);
  if (action === 'sync') return syncPost(request);
  return json({ ok: false, error: 'Unknown action' }, 404);
}

// ?action=sync is the daily cron. Without it, lets someone confirm the route is deployed from a
// browser — it says nothing about configuration.
export async function GET(request) {
  const action = request ? new URL(request.url).searchParams.get('action') : null;
  if (action === 'sync') return syncCron(request);
  return json({ ok: true, service: 'tailortalk' });
}
