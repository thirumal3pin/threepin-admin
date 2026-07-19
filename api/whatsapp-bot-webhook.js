import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getDb, buildSystemPrompt, UPDATE_LEAD_INFO_TOOL, DEFAULT_BOT_CONFIG, getWhatsAppCreds, getKnowledgeSources, resolveTenantByPhoneNumberId } from './_bot-shared.js';

// Lazily created so a missing ANTHROPIC_API_KEY can't crash the module at
// load time — webhook verification (GET) must never depend on Claude.
let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _anthropic;
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function getBotConfig(db, tenantId) {
  const snap = await db.collection('botConfigs').doc(tenantId).get();
  return snap.exists ? snap.data() : DEFAULT_BOT_CONFIG;
}

async function getFirstStageId(db, tenantId) {
  const snap = await db.collection('pipelines').doc(tenantId).get();
  const stages = snap.exists ? (snap.data().stages || []) : [];
  return stages.length ? stages[0].id : 'new';
}

async function getConversation(db, tenantId, phone) {
  const ref = db.collection('conversations').doc(`${tenantId}_${phone}`);
  const snap = await ref.get();
  if (snap.exists) return { ref, data: snap.data() };
  return {
    ref,
    data: { tenantId, phone, messages: [], extractedInfo: {}, status: 'active', createdAt: Date.now(), updatedAt: Date.now() }
  };
}

async function sendWhatsAppMessage(db, tenantId, to, text) {
  const { phoneNumberId, token } = await getWhatsAppCreds(db, tenantId);
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
  if (!res.ok) {
    throw new Error(`WhatsApp send error ${res.status}: ${await res.text()}`);
  }
}

async function upsertLead(db, tenantId, phone, extractedInfo, contactName) {
  const leadId = 'lead_wa_' + tenantId + '_' + phone.replace(/[^0-9]/g, '');
  const ref = db.collection('leads').doc(leadId);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() : null;
  const stageId = existing ? existing.stageId : await getFirstStageId(db, tenantId);
  const lead = {
    id: leadId,
    tenantId,
    name: extractedInfo.name || (existing && existing.name) || contactName || 'WhatsApp Lead',
    phone,
    email: (existing && existing.email) || '',
    propertyInterest: [extractedInfo.propertyType, extractedInfo.area, extractedInfo.budget].filter(Boolean).join(', '),
    source: 'whatsapp_bot',
    stageId,
    notes: (existing && existing.notes) || [],
    conversationId: phone,
    createdAt: (existing && existing.createdAt) || Date.now(),
    updatedAt: Date.now()
  };
  await ref.set(lead, { merge: true });
}

async function processIncomingMessage(db, tenantId, phone, text, contactName) {
  const [config, knowledge] = await Promise.all([getBotConfig(db, tenantId), getKnowledgeSources(db, tenantId)]);
  const { ref, data: convo } = await getConversation(db, tenantId, phone);

  convo.messages = convo.messages || [];
  convo.messages.push({ role: 'user', content: text, ts: Date.now() });

  const response = await getAnthropic().messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    system: buildSystemPrompt(config, knowledge),
    tools: [UPDATE_LEAD_INFO_TOOL],
    messages: convo.messages.map(m => ({ role: m.role, content: m.content }))
  });

  let replyText = '';
  let extractedInfo = { ...(convo.extractedInfo || {}) };
  for (const block of response.content) {
    if (block.type === 'text') replyText += block.text;
    if (block.type === 'tool_use' && block.name === 'update_lead_info') {
      extractedInfo = { ...extractedInfo, ...block.input };
    }
  }
  if (!replyText.trim()) replyText = 'Thanks for the message! A team member will follow up shortly.';

  convo.messages.push({ role: 'assistant', content: replyText, ts: Date.now() });
  convo.extractedInfo = extractedInfo;
  convo.updatedAt = Date.now();

  await ref.set(convo, { merge: true });
  await upsertLead(db, tenantId, phone, extractedInfo, contactName);
  await sendWhatsAppMessage(db, tenantId, phone, replyText);
}

export async function GET(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
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
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      const contact = (value.contacts && value.contacts[0]) || {};
      const contactName = contact.profile ? contact.profile.name : '';
      const phoneNumberId = (value.metadata || {}).phone_number_id;
      for (const msg of value.messages || []) {
        if (msg.type !== 'text') continue; // v1: text messages only
        const phone = msg.from;
        const text = msg.text.body;
        jobs.push(
          resolveTenantByPhoneNumberId(db, phoneNumberId)
            .then(tenantId => {
              if (!tenantId) {
                console.error('WhatsApp webhook: no tenant registered for phone_number_id', phoneNumberId);
                return;
              }
              return processIncomingMessage(db, tenantId, phone, text, contactName);
            })
            .catch(e => console.error('WhatsApp bot processing error:', e))
        );
      }
    }
  }
  await Promise.all(jobs);

  return new Response('EVENT_RECEIVED', { status: 200 });
}
