import crypto from 'node:crypto';
import { getDb } from './_bot-shared.js';
import {
  processLeadgenEvent,
  reconcile,
  cronAuthorized,
  normalizeBudget,
  phoneKey,
  fetchLead
} from './_meta-shared.js';

// Facebook / Instagram Lead Ads — the single HTTP route for the integration.
//
// This handles THREE jobs, because the Hobby plan caps a deployment at 12
// Serverless Functions and the project is at that ceiling. Splitting these into
// separate files is the obvious design and is what the deleted 60c2d78 version
// did — it cost a function slot that does not exist. All the actual logic lives
// in _meta-shared.js (underscore = not routed by Vercel).
//
//   GET  ?hub.mode=subscribe   Meta's webhook verification handshake
//   GET  (anything else)       daily reconciliation — CRON_SECRET required
//   POST                       inbound leadgen events — HMAC required
//
// The two GET paths cannot collide: Meta's handshake always carries hub.* query
// params, and the cron never does.
//
// See docs/META-LEAD-ADS.md for setup and field mapping.

// Re-exported so scripts/check-meta-lead-ads.js and the unit tests can import
// the mapping helpers from the route they actually exercise.
export { processLeadgenEvent, normalizeBudget, phoneKey, fetchLead, reconcile };

// Meta signs the RAW body. Any re-serialisation (parse → stringify) breaks the
// comparison, so the body is read once as text and parsed only afterwards.
function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function GET(request) {
  const url = new URL(request.url);

  // 1. Meta's subscription handshake.
  if (url.searchParams.get('hub.mode') === 'subscribe') {
    const token = url.searchParams.get('hub.verify_token');
    if (token && token === process.env.META_VERIFY_TOKEN) {
      return new Response(url.searchParams.get('hub.challenge'), { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // 2. Reconciliation (Vercel cron, or by hand with the secret).
  if (!cronAuthorized(request)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '', 10) || 7));
  const dryRun = url.searchParams.get('dryRun') === '1' || url.searchParams.get('dryRun') === 'true';
  try {
    return json(await reconcile({ days, dryRun }));
  } catch (e) {
    console.error('meta-reconcile failed:', e);
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}

export async function POST(request) {
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers.get('x-hub-signature-256'), process.env.META_APP_SECRET)) {
    console.error('meta-webhook: signature verification failed');
    return new Response('Invalid signature', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const db = getDb();
  const results = [];

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      try {
        results.push(await processLeadgenEvent(db, change.value));
      } catch (e) {
        // Swallow per-lead so one bad lead cannot fail the batch. Meta retries
        // non-200s, and a retry storm on a permanently-broken lead is worse
        // than a logged miss the reconciliation sweep will pick up.
        console.error('meta-webhook: lead processing error:', e);
        results.push({ error: String(e && e.message ? e.message : e) });
      }
    }
  }

  console.log('meta-webhook processed:', JSON.stringify(results));
  return new Response('EVENT_RECEIVED', { status: 200 });
}
