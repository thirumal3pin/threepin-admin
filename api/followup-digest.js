import { getDb, getWhatsAppCreds } from './_bot-shared.js';

// wa.me / Cloud API sends need digits only, country code, no leading zeros.
// Recipients here are typed by hand in the CRM, so normalize the same way
// the client does for wa.me links — bare 10-digit numbers assumed +91.
function normalizePhone(raw) {
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  return digits;
}

async function sendWhatsAppText(db, tenantId, to, text) {
  const { phoneNumberId, token } = await getWhatsAppCreds(db, tenantId);
  if (!phoneNumberId || !token) return { ok: false, error: 'No WhatsApp connected for this tenant' };
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
  if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
  return { ok: true };
}

function formatDigest(overdue, today) {
  const lines = ['📅 *Follow-up digest*', ''];
  if (overdue.length) {
    lines.push(`⚠️ Overdue (${overdue.length}):`);
    overdue.forEach(l => lines.push(`• ${l.name || 'Lead'}${l.phone ? ' — ' + l.phone : ''}`));
    lines.push('');
  }
  if (today.length) {
    lines.push(`📅 Due today (${today.length}):`);
    today.forEach(l => {
      const time = new Date(l.followUpAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      lines.push(`• ${l.name || 'Lead'}${l.phone ? ' — ' + l.phone : ''} @ ${time}`);
    });
    lines.push('');
  }
  if (!overdue.length && !today.length) lines.push('Nothing due today. 🎉');
  return lines.join('\n').trim();
}

// Triggered by Vercel Cron (see vercel.json) once a day. Loops every tenant
// that has opted in (settings/{tenantId}.followupDigestEnabled) and messages
// each configured recipient via that tenant's own connected WhatsApp number.
//
// Caveat worth knowing: WhatsApp's Cloud API only allows a freeform text
// send (what this does) to a number that has messaged the business within
// the last 24 hours — otherwise Meta requires a pre-approved message
// template. If a recipient hasn't texted the connected number recently,
// this send can fail; check the response/logs here if a digest silently
// doesn't arrive. Switching to an approved template removes that limit but
// requires setting one up in Meta Business Manager first.
export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const db = getDb();
  const pipelinesSnap = await db.collection('pipelines').get();
  const results = [];

  for (const doc of pipelinesSnap.docs) {
    const tenantId = doc.id;
    const settingsSnap = await db.collection('settings').doc(tenantId).get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const recipients = settings.followupDigestEnabled ? (settings.followupDigestRecipients || []) : [];
    if (!recipients.length) continue;

    const leadsSnap = await db.collection('leads').where('tenantId', '==', tenantId).get();
    const now = Date.now();
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const startOfTomorrow = startOfToday + 86400000;
    const overdue = [];
    const today = [];
    leadsSnap.forEach(d => {
      const l = d.data();
      if (!l.followUpAt) return;
      if (l.followUpAt < now) overdue.push(l);
      else if (l.followUpAt < startOfTomorrow) today.push(l);
    });
    overdue.sort((a, b) => a.followUpAt - b.followUpAt);
    today.sort((a, b) => a.followUpAt - b.followUpAt);

    const message = formatDigest(overdue, today);
    for (const raw of recipients) {
      const to = normalizePhone(raw);
      if (!to) continue;
      const r = await sendWhatsAppText(db, tenantId, to, message);
      results.push({ tenantId, to, ...r });
    }
  }

  return new Response(JSON.stringify({ sent: results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
