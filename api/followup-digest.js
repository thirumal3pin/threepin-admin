import nodemailer from 'nodemailer';
import { getDb, getWhatsAppCreds, verifyCrmUser } from './_bot-shared.js';

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

// Lazy so a missing GMAIL_USER/GMAIL_APP_PASSWORD doesn't crash module load —
// only an actual send should fail if Gmail isn't configured.
let _mailer;
function getMailer() {
  if (!_mailer) {
    _mailer = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
  }
  return _mailer;
}
async function sendDigestEmail(to, subject, text, html) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return { ok: false, error: 'Gmail not configured (GMAIL_USER/GMAIL_APP_PASSWORD missing)' };
  }
  try {
    await getMailer().sendMail({ from: `"3 PIN Realty CRM" <${process.env.GMAIL_USER}>`, to, subject, text, html });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function leadLine(l) {
  return `${l.name || 'Lead'}${l.phone ? ' — ' + l.phone : ''}${l.propertyInterest ? ' (' + l.propertyInterest + ')' : ''}`;
}
function formatDigestText(overdue, today) {
  const lines = ['Follow-up digest', ''];
  if (overdue.length) {
    lines.push(`OVERDUE (${overdue.length}):`);
    overdue.forEach(l => lines.push(`- ${leadLine(l)}`));
    lines.push('');
  }
  if (today.length) {
    lines.push(`DUE TODAY (${today.length}):`);
    today.forEach(l => {
      const time = new Date(l.followUpAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      lines.push(`- ${leadLine(l)} @ ${time}`);
    });
    lines.push('');
  }
  if (!overdue.length && !today.length) lines.push('Nothing due today.');
  return lines.join('\n').trim();
}
function formatWhatsAppDigest(overdue, today) {
  const lines = ['📅 *Follow-up digest*', ''];
  if (overdue.length) {
    lines.push(`⚠️ Overdue (${overdue.length}):`);
    overdue.forEach(l => lines.push(`• ${leadLine(l)}`));
    lines.push('');
  }
  if (today.length) {
    lines.push(`📅 Due today (${today.length}):`);
    today.forEach(l => {
      const time = new Date(l.followUpAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      lines.push(`• ${leadLine(l)} @ ${time}`);
    });
    lines.push('');
  }
  if (!overdue.length && !today.length) lines.push('Nothing due today. 🎉');
  return lines.join('\n').trim();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function leadRowHtml(l, showTime) {
  const time = showTime ? new Date(l.followUpAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600;">${escapeHtml(l.name || 'Lead')}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(l.phone || '—')}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(l.propertyInterest || '—')}</td>
    ${showTime ? `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${time}</td>` : ''}
  </tr>`;
}
function formatDigestHtml(overdue, today) {
  const section = (title, color, rows, showTime) => !rows.length ? '' : `
    <h3 style="color:${color};margin:18px 0 8px;font-family:sans-serif;">${title} (${rows.length})</h3>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;">
      <tr style="text-align:left;color:#888;font-size:11px;text-transform:uppercase;">
        <th style="padding:4px 10px;">Name</th><th style="padding:4px 10px;">Phone</th><th style="padding:4px 10px;">Property</th>${showTime ? '<th style="padding:4px 10px;">Time</th>' : ''}
      </tr>
      ${rows.map(l => leadRowHtml(l, showTime)).join('')}
    </table>`;
  const body = section('⚠️ Overdue', '#B91C1C', overdue, false) + section('📅 Due Today', '#B45309', today, true);
  return `<div style="font-family:sans-serif;">
    <h2 style="font-family:sans-serif;">Follow-up digest</h2>
    ${body || '<p style="font-family:sans-serif;color:#888;">Nothing due today.</p>'}
  </div>`;
}

async function digestForTenant(db, tenantId) {
  const settingsSnap = await db.collection('settings').doc(tenantId).get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const waRecipients = settings.followupDigestEnabled ? (settings.followupDigestRecipients || []) : [];
  const emailRecipients = settings.followupDigestEmailEnabled ? (settings.followupDigestEmails || []) : [];
  if (!waRecipients.length && !emailRecipients.length) return { tenantId, skipped: true, results: [] };

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

  const results = [];
  if (waRecipients.length) {
    const message = formatWhatsAppDigest(overdue, today);
    for (const raw of waRecipients) {
      const to = normalizePhone(raw);
      if (!to) continue;
      const r = await sendWhatsAppText(db, tenantId, to, message);
      results.push({ channel: 'whatsapp', to, ...r });
    }
  }
  if (emailRecipients.length) {
    const subject = `Follow-up digest — ${overdue.length} overdue, ${today.length} due today`;
    const text = formatDigestText(overdue, today);
    const html = formatDigestHtml(overdue, today);
    for (const to of emailRecipients) {
      const r = await sendDigestEmail(to, subject, text, html);
      results.push({ channel: 'email', to, ...r });
    }
  }
  return { tenantId, skipped: false, results };
}

// Triggered by Vercel Cron (see vercel.json) once a day, or manually from
// the CRM's "Send Digest Now" button (POST, Firebase-auth'd, one tenant).
//
// Caveat worth knowing: WhatsApp's Cloud API only allows a freeform text
// send to a number that has messaged the business within the last 24
// hours — otherwise Meta requires a pre-approved message template.
export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const db = getDb();
  const pipelinesSnap = await db.collection('pipelines').get();
  const results = [];
  for (const doc of pipelinesSnap.docs) {
    const r = await digestForTenant(db, doc.id);
    if (!r.skipped) results.push(...r.results.map(x => ({ tenantId: doc.id, ...x })));
  }

  return new Response(JSON.stringify({ sent: results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function POST(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const db = getDb();
  const r = await digestForTenant(db, user.tenantId);
  return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
