// Manually connects a WhatsApp number to a tenant, bypassing the Embedded
// Signup popup entirely. Useful for internal-only use (no reselling to
// external customers) where Meta's business-to-business WABA-sharing
// requirement is unnecessary friction — this does the same three Firestore
// writes api/whatsapp-embedded-signup.js does, just from a token you already
// have (e.g. the temporary token from WhatsApp → API Setup in the Meta App
// Dashboard, or a real long-lived token once you have one).
//
// Usage:
//   node scripts/connect-whatsapp-manual.js --tenantId t_3pinrealty --phoneNumberId 123456789012345 --token EAAxxxx...
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

  console.log(`\nConnected ${phoneNumberId} to tenant ${tenantId}.`);
  console.log('Note: if this is the 24h temporary token from API Setup, re-run this script with a fresh token before it expires (or get a long-lived System User token for a permanent connection).');
}

main().catch(e => {
  console.error('connect-whatsapp-manual failed:', e);
  process.exit(1);
});
