import crypto from 'node:crypto';
import { getDb } from './_bot-shared.js';

// Meta's required "Data Deletion Request Callback" — every app using
// Facebook Login-based flows (which WhatsApp Embedded Signup is built on)
// must provide one before App Review will approve it. Meta POSTs a signed,
// HMAC-verified payload here whenever someone asks Meta to delete their data
// for this app; we must verify it, act on it, and hand back a status URL +
// confirmation code that Meta shows the user.
//
// This app doesn't store anything keyed by a Facebook/Instagram user id —
// Embedded Signup is a business-onboarding flow (it hands us a WhatsApp
// Business Account token), not an end-user consumer login that collects a
// personal FB profile. So there is genuinely nothing to delete per user_id;
// we log the request for an audit trail and report it completed truthfully.

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function parseSignedRequest(signedRequest, secret) {
  const [encodedSig, payload] = (signedRequest || '').split('.');
  if (!encodedSig || !payload) return null;
  const sig = base64UrlDecode(encodedSig);
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest();
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) return null;
  try {
    return JSON.parse(base64UrlDecode(payload).toString('utf8'));
  } catch {
    return null;
  }
}

export async function POST(request) {
  const contentType = request.headers.get('content-type') || '';
  let signedRequest;
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}));
    signedRequest = body.signed_request;
  } else {
    const form = await request.formData().catch(() => null);
    signedRequest = form ? form.get('signed_request') : null;
  }
  if (!signedRequest) {
    return new Response(JSON.stringify({ error: 'Missing signed_request' }), { status: 400 });
  }

  const payload = parseSignedRequest(signedRequest, process.env.META_APP_SECRET);
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
  }

  const confirmationCode = crypto.randomBytes(12).toString('hex');
  const db = getDb();
  await db.collection('dataDeletionRequests').doc(confirmationCode).set({
    metaUserId: payload.user_id || null,
    requestedAt: Date.now(),
    status: 'completed'
  });

  const statusUrl = `${new URL(request.url).origin}/api/data-deletion-status?id=${confirmationCode}`;
  return new Response(JSON.stringify({ url: statusUrl, confirmation_code: confirmationCode }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
