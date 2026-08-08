import crypto from 'node:crypto';

// Shared by brochure-upload-init.js and brochure-ready.js — the two halves
// of a direct-to-Drive upload flow. Files can't pass through either
// function's own body: Vercel hard-caps every Function's request/response
// body at 4.5MB (no runtime exception — confirmed against Vercel's docs),
// so a real brochure PDF (often well over that) would 413 if POSTed
// straight to a function. Instead: init hands back a one-time Google
// resumable-upload URL, the caller PUTs the file bytes directly to Google
// (never touching Vercel), then ready fetches the finished file back from
// Drive server-side (an outbound fetch, not subject to the inbound cap) to
// attach to the email.

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const RATE_LIMIT_PER_MINUTE = 20;

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
export function fail(step, error, status = 500, extra) {
  return json({ success: false, error, step, ...extra }, status);
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function checkAuth(request) {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  return !!process.env.WEBHOOK_SHARED_SECRET && !!token && timingSafeEqualStr(token, process.env.WEBHOOK_SHARED_SECRET);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Service-account JWT-bearer grant — no googleapis SDK, matching this
// codebase's plain-fetch approach to every other third-party API (Meta
// Graph API is called the same way in whatsapp-embedded-signup.js).
export async function getDriveAccessToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  // Service accounts have no Drive storage quota of their own (uploads
  // 403 with storageQuotaExceeded) — domain-wide delegation lets it act as
  // a real Workspace user instead, via the `sub` claim, so uploads use
  // that user's quota and the target folders just need to already be
  // accessible to them.
  const claims = {
    iss: sa.client_email,
    scope: DRIVE_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  if (process.env.GOOGLE_IMPERSONATE_EMAIL) claims.sub = process.env.GOOGLE_IMPERSONATE_EMAIL;
  const signInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  signer.end();
  const signature = signer.sign(sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signInput}.${signature}`
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google token exchange failed (${res.status})`);
  }
  return data.access_token;
}

// Best-effort — a folder already shared with the service account grants
// access to its existing members regardless, so a failure here shouldn't
// fail the whole request, just leave the link only as accessible as the
// folder already is.
export async function makeDriveFilePublic(accessToken, fileId) {
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });
  } catch (e) {
    console.error('brochure: making file public failed (non-fatal):', e);
  }
}

// Per-minute counter in Firestore so the cap holds across warm instances,
// not just within one — these endpoints are public-facing and gated only
// by the shared secret otherwise. Not airtight under races; that's fine
// for a "basic" rate limit against casual abuse, not a precise quota.
export async function checkRateLimit(db, routeName) {
  const bucket = Math.floor(Date.now() / 60000);
  const ref = db.collection('webhookRateLimit').doc(`${routeName}-${bucket}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? snap.data().count : 0;
    if (count >= RATE_LIMIT_PER_MINUTE) return false;
    tx.set(ref, { count: count + 1, updatedAt: Date.now() }, { merge: true });
    return true;
  });
}

export async function logBrochureCall(db, entry) {
  try {
    await db.collection('brochureDeliveryLog').add({ at: Date.now(), ...entry });
  } catch (e) {
    console.error('brochure: log write failed:', e);
  }
}
