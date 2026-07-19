import { getDb, verifyCrmUser } from './_bot-shared.js';

// Meta's WhatsApp Embedded Signup: the customer clicks "Connect WhatsApp" in
// the CRM, a Facebook Login popup (config_id-driven) hands back an
// authorization `code`, and this endpoint exchanges it server-side for a
// long-lived System User access token scoped to THEIR WhatsApp Business
// Account — never a shared token, never typed in by hand.
//
// Requires env vars: META_APP_ID, META_APP_SECRET (already set for webhook
// signature verification, reused here for the token exchange).
//
// Needs App Review approval for whatsapp_business_management to work for
// real, unaffiliated customers — works today for testers/test numbers added
// in the Meta App Dashboard while that review is pending.

const GRAPH_VERSION = 'v21.0';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function exchangeCodeForToken(code) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token` +
    `?client_id=${encodeURIComponent(process.env.META_APP_ID)}` +
    `&client_secret=${encodeURIComponent(process.env.META_APP_SECRET)}` +
    `&code=${encodeURIComponent(code)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ? data.error.message : `Token exchange failed (${res.status})`);
  }
  return data.access_token;
}

async function exchangeForLongLivedToken(shortLivedToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(process.env.META_APP_ID)}` +
    `&client_secret=${encodeURIComponent(process.env.META_APP_SECRET)}` +
    `&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ? data.error.message : `Long-lived token exchange failed (${res.status})`);
  }
  return data.access_token;
}

async function fetchNumberInfo(phoneNumberId, token) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}` +
    `?fields=verified_name,display_phone_number,quality_rating` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ? data.error.message : `Could not fetch phone number info (${res.status})`);
  }
  return data;
}

export async function POST(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const { code, phoneNumberId, wabaId } = body;
  if (!code || !phoneNumberId) {
    return json({ error: 'Missing code or phoneNumberId from the Meta signup popup.' }, 400);
  }

  try {
    const shortLivedToken = await exchangeCodeForToken(code);
    const longLivedToken = await exchangeForLongLivedToken(shortLivedToken);
    const info = await fetchNumberInfo(phoneNumberId, longLivedToken);

    const db = getDb();
    const tenantId = user.tenantId;

    await Promise.all([
      db.collection('botConfigs').doc(tenantId).set({
        waPhoneNumberId: phoneNumberId,
        waPhoneNumber: info.display_phone_number || '',
        waVerifiedName: info.verified_name || '',
        waQualityRating: info.quality_rating || '',
        waConnectedAt: Date.now()
      }, { merge: true }),
      db.collection('waSecrets').doc(tenantId).set({
        token: longLivedToken,
        updatedAt: Date.now()
      }),
      db.collection('waNumbers').doc(phoneNumberId).set({
        tenantId,
        wabaId: wabaId || null,
        connectedAt: Date.now()
      })
    ]);

    return json({
      connected: true,
      phoneNumberId,
      displayPhoneNumber: info.display_phone_number || '',
      verifiedName: info.verified_name || '',
      qualityRating: info.quality_rating || ''
    });
  } catch (e) {
    console.error('whatsapp-embedded-signup error:', e);
    return json({ connected: false, error: String(e.message || e) }, 200);
  }
}

// Disconnect: clears this tenant's connection so the CRM shows the
// "Connect WhatsApp" button again. Leaves the waSecrets token in place
// (Meta doesn't require revocation to reconnect) but removes the routing
// entry so the webhook no longer delivers messages for this number.
export async function DELETE(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);

  const db = getDb();
  const tenantId = user.tenantId;

  const botSnap = await db.collection('botConfigs').doc(tenantId).get();
  const phoneNumberId = botSnap.exists ? botSnap.data().waPhoneNumberId : null;

  const jobs = [
    db.collection('botConfigs').doc(tenantId).set({
      waPhoneNumberId: '',
      waPhoneNumber: '',
      waVerifiedName: '',
      waQualityRating: '',
      waConnectedAt: null
    }, { merge: true })
  ];
  if (phoneNumberId) jobs.push(db.collection('waNumbers').doc(phoneNumberId).delete());
  await Promise.all(jobs);

  return json({ connected: false });
}
