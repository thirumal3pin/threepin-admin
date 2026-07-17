import crypto from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function getFirstStageId(db) {
  const snap = await db.collection('config').doc('pipeline').get();
  const stages = snap.exists ? (snap.data().stages || []) : [];
  return stages.length ? stages[0].id : 'new';
}

async function fetchLeadFields(leadgenId) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  const res = await fetch(`https://graph.facebook.com/v21.0/${leadgenId}?access_token=${token}`);
  if (!res.ok) {
    throw new Error(`Graph API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const fieldData = {};
  (data.field_data || []).forEach(f => {
    fieldData[f.name] = (f.values && f.values[0]) || '';
  });
  return fieldData;
}

async function processLeadgenEvent(db, value) {
  const leadgenId = value.leadgen_id;
  if (!leadgenId) return;

  const fieldData = await fetchLeadFields(leadgenId);
  const stageId = await getFirstStageId(db);

  const lead = {
    id: 'meta_' + leadgenId,
    name: fieldData.full_name || fieldData.name || 'Meta Lead',
    phone: fieldData.phone_number || fieldData.phone || '',
    email: fieldData.email || '',
    propertyInterest: fieldData.property_interest || fieldData.interested_property || '',
    source: 'meta',
    stageId,
    leadgenId,
    formId: value.form_id || '',
    adId: value.ad_id || '',
    rawFieldData: fieldData,
    notes: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await db.collection('leads').doc(lead.id).set(lead, { merge: true });
}

export async function GET(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifySignature(rawBody, signature, process.env.META_APP_SECRET)) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const db = getDb();
  const jobs = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'leadgen') {
        jobs.push(processLeadgenEvent(db, change.value).catch(e => console.error('Lead processing error:', e)));
      }
    }
  }
  await Promise.all(jobs);

  return new Response('EVENT_RECEIVED', { status: 200 });
}
