import { getDb, verifyCrmUser } from './_bot-shared.js';

// "Click to connect" for a single WhatsApp Business number.
//
// The long-lived access token is a server-only secret (Vercel env
// WHATSAPP_ACCESS_TOKEN) — it never touches the browser or client-readable
// Firestore. The CRM only sends the Phone Number ID; this endpoint verifies it
// against Meta's Graph API, and on success stores the verified display name +
// number in config/whatsappBot so the board can show a green "verified" badge.

const GRAPH_VERSION = 'v21.0';

async function fetchNumberInfo(phoneNumberId, token) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}` +
    `?fields=verified_name,display_phone_number,quality_rating,code_verification_status` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function POST(request) {
  const user = await verifyCrmUser(request);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const phoneNumberId = (body.phoneNumberId || '').trim();
  if (!phoneNumberId) return json({ error: 'Phone Number ID is required' }, 400);

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    // Plug-and-play placeholder: everything is wired, we just need the secret.
    return json({
      connected: false,
      needsSetup: true,
      message: 'Add WHATSAPP_ACCESS_TOKEN in your Vercel project settings to finish connecting. Everything else is ready.'
    }, 200);
  }

  let result;
  try {
    result = await fetchNumberInfo(phoneNumberId, token);
  } catch (e) {
    console.error('whatsapp-connect fetch error:', e);
    return json({ connected: false, error: 'Could not reach Meta. Try again.' }, 502);
  }

  if (!result.ok) {
    const metaMsg = result.data && result.data.error ? result.data.error.message : `HTTP ${result.status}`;
    return json({
      connected: false,
      error: `Meta rejected this Phone Number ID: ${metaMsg}`
    }, 200);
  }

  const info = result.data || {};
  const db = getDb();
  await db.collection('config').doc('whatsappBot').set({
    waPhoneNumberId: phoneNumberId,
    waPhoneNumber: info.display_phone_number || '',
    waVerifiedName: info.verified_name || '',
    waQualityRating: info.quality_rating || '',
    waConnectedAt: Date.now()
  }, { merge: true });

  return json({
    connected: true,
    phoneNumberId,
    displayPhoneNumber: info.display_phone_number || '',
    verifiedName: info.verified_name || '',
    qualityRating: info.quality_rating || ''
  });
}

// Optional: disconnect / clear the stored number.
export async function DELETE(request) {
  const user = await verifyCrmUser(request);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const db = getDb();
  await db.collection('config').doc('whatsappBot').set({
    waPhoneNumberId: '',
    waPhoneNumber: '',
    waVerifiedName: '',
    waQualityRating: '',
    waConnectedAt: null
  }, { merge: true });

  return json({ connected: false });
}
