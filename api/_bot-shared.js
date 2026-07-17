import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

export function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

export async function verifyCrmUser(request) {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    getDb(); // ensures the default app is initialized before getAuth()
    return await getAuth().verifyIdToken(token);
  } catch {
    return null;
  }
}

export const DEFAULT_BOT_CONFIG = {
  role: 'You are a professional, friendly real estate assistant for 3 PIN Realty, a real estate brokerage in Chennai. You help potential buyers find properties by understanding their requirements through natural conversation.',
  welcomeMessage: "Hi! Thanks for reaching out to 3 PIN Realty 👋 What are you looking for in Chennai — an apartment, villa, or plot?",
  requiredInfo: [
    { id: 'ri1', label: 'Preferred area in Chennai' },
    { id: 'ri2', label: 'Budget' },
    { id: 'ri3', label: 'Property type and configuration (e.g. 2BHK apartment, villa)' },
    { id: 'ri4', label: 'Name' }
  ],
  steps: [
    { id: 's1', title: 'Hook & Qualify', instructions: 'Acknowledge the enquiry immediately. Ask only for what is missing — do not repeat questions already answered. Gather naturally, not like a form.' },
    { id: 's2', title: 'Share Matching Options', instructions: 'Once you have area, budget, and type, let them know a team member will follow up with matching properties. Do not invent specific listings, prices, or availability you were not given.' },
    { id: 's3', title: 'Close & Handoff', instructions: 'Once you have the required info, thank them and let them know a team member will follow up shortly.' }
  ],
  guardrails: [
    'Never invent specific property prices, availability, or details you have not been given.',
    'If asked for legal, financial, or loan advice, say a team member will follow up on that.',
    'If the user seems frustrated, confused, or explicitly asks for a human, stop qualifying and say a team member will take over.',
    'Keep replies short — 1-3 sentences, WhatsApp style, not long paragraphs.'
  ],
  tone: 'Warm, professional, concise. Natural conversation — never sound like filling out a form.'
};

export function buildSystemPrompt(config) {
  const parts = [config.role || '', '', `Tone: ${config.tone || ''}`, ''];
  parts.push('Information you need to collect from the lead:');
  (config.requiredInfo || []).forEach(r => parts.push(`- ${r.label}`));
  parts.push('');
  parts.push('Conversation approach:');
  (config.steps || []).forEach(s => parts.push(`${s.title}: ${s.instructions}`));
  parts.push('');
  parts.push('Guardrails:');
  (config.guardrails || []).forEach(g => parts.push(`- ${g}`));
  parts.push('');
  parts.push('Whenever you learn new information about the lead from their message, call the update_lead_info tool with only the fields you newly learned, in addition to your normal conversational reply. Keep replies short and natural for WhatsApp.');
  return parts.join('\n');
}

export const UPDATE_LEAD_INFO_TOOL = {
  name: 'update_lead_info',
  description: 'Record newly learned information about this lead. Call this whenever the lead reveals their name, preferred area, budget, or property type/configuration. Only include fields you actually learned in this message — omit fields you do not have new information for.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      area: { type: 'string' },
      budget: { type: 'string' },
      propertyType: { type: 'string' },
      readyForHandoff: { type: 'boolean', description: 'true once all required info has been collected' }
    }
  }
};
