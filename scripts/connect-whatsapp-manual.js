// Manually connects a WhatsApp number to a tenant, bypassing the Embedded
// Signup popup entirely. Useful for internal-only use (no reselling to
// external customers) where Meta's business-to-business WABA-sharing
// requirement is unnecessary friction — this does the same three Firestore
// writes api/whatsapp-embedded-signup.js does, just from a token you already
// have (e.g. the temporary token from WhatsApp → API Setup in the Meta App
// Dashboard, or a real long-lived token once you have one).
//
// Usage:
//   node scripts/connect-whatsapp-manual.js --tenantId t_3pinrealty --phoneNumberId 123456789012345 --wabaId 987654321 --token EAAxxxx...
//
// Note on --wabaId: Embedded Signup automatically subscribes your app to
// receive that WABA's webhook events; a manual connect does not, so this
// script does it explicitly via POST /{waba-id}/subscribed_apps. Without
// --wabaId this step is skipped and Meta will silently never call your
// webhook for this number (it may still be subscribed to some OTHER app,
// e.g. Meta's own default test-number app, instead of yours).
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const GRAPH_VERSION = 'v21.0';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
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

async function subscribeAppToWaba(wabaId, token) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error ? data.error.message : `Could not subscribe app to WABA webhooks (${res.status})`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenantId || !args.phoneNumberId || !args.token) {
    console.error('Usage: node scripts/connect-whatsapp-manual.js --tenantId t_3pinrealty --phoneNumberId 123456789012345 --token EAAxxxx...');
    process.exit(1);
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url);
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();

  const { tenantId, phoneNumberId, token, wabaId } = args;

  console.log('Verifying token against Meta Graph API...');
  const info = await fetchNumberInfo(phoneNumberId, token);
  console.log('Verified:', info.verified_name || '(unnamed)', '—', info.display_phone_number);

  await Promise.all([
    db.collection('botConfigs').doc(tenantId).set({
      waPhoneNumberId: phoneNumberId,
      waPhoneNumber: info.display_phone_number || '',
      waVerifiedName: info.verified_name || '',
      waQualityRating: info.quality_rating || '',
      waConnectedAt: Date.now()
    }, { merge: true }),
    db.collection('waSecrets').doc(tenantId).set({
      token,
      updatedAt: Date.now()
    }),
    db.collection('waNumbers').doc(phoneNumberId).set({
      tenantId,
      wabaId: wabaId || null,
      connectedAt: Date.now()
    })
  ]);

  if (wabaId) {
    console.log('Subscribing your app to this WABA\'s webhook events...');
    await subscribeAppToWaba(wabaId, token);
    console.log('Subscribed — Meta will now deliver webhook events for this number to your app.');
  } else {
    console.log('\nWARNING: no --wabaId given, so I could NOT subscribe your app to this WABA\'s webhooks.');
    console.log('Meta will not call your webhook for this number until this is done — pass --wabaId and re-run,');
    console.log('or run: curl -X POST "https://graph.facebook.com/v21.0/{waba-id}/subscribed_apps?access_token={token}"');
  }

  console.log(`\nConnected ${phoneNumberId} to tenant ${tenantId}.`);
  console.log('Note: if this is the 24h temporary token from API Setup, re-run this script with a fresh token before it expires (or get a long-lived System User token for a permanent connection).');
}

main().catch(e => {
  console.error('connect-whatsapp-manual failed:', e);
  process.exit(1);
});
