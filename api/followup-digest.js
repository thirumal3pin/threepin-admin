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

// Vercel functions run in UTC regardless of who's reading the output, but
// every recipient here is in India — so all display formatting AND the
// "today"/"tomorrow" day-bucket boundaries must be pinned to IST, not the
// server's local (UTC) clock. IST has no DST, so a fixed offset is safe.
const TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// YYYY-MM-DD in IST — used as a per-tenant "already sent today" key so the
// scheduled digest is idempotent: it's safe to trigger the cron endpoint from
// more than one scheduler (Vercel Cron + a GitHub Actions backup) without
// double-emailing, and a run that failed to send can be retried the same day.
function istDateString(ts = Date.now()) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
}

// Buckets: overdue (past due, not yet acted on) + one bucket per calendar
// day for the next 3 days (today, tomorrow, day after) — shown day by day
// rather than lumped into a single "upcoming" pile.
const DAY_MS = 86400000;
const LOOKAHEAD_DAYS = 3;
function bucketLeads(leadsSnap) {
  const now = Date.now();
  // Midnight IST for "today," expressed as a true UTC epoch ms timestamp —
  // works no matter what timezone the server process itself is running in.
  const startOfToday = Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  const overdue = [];
  const days = Array.from({ length: LOOKAHEAD_DAYS }, () => []);
  leadsSnap.forEach(d => {
    const l = d.data();
    if (!l.followUpAt) return;
    if (l.followUpAt < now) { overdue.push(l); return; }
    const dayIndex = Math.floor((l.followUpAt - startOfToday) / DAY_MS);
    if (dayIndex >= 0 && dayIndex < LOOKAHEAD_DAYS) days[dayIndex].push(l);
  });
  overdue.sort((a, b) => a.followUpAt - b.followUpAt);
  days.forEach(arr => arr.sort((a, b) => a.followUpAt - b.followUpAt));
  return { overdue, days, startOfToday };
}
function dayLabel(i, startOfToday) {
  const dateStr = new Date(startOfToday + i * DAY_MS).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });
  if (i === 0) return `Today — ${dateStr}`;
  if (i === 1) return `Tomorrow — ${dateStr}`;
  return dateStr;
}

// Property is always shown so an agent can act without opening the CRM;
// kept in the same position/format across every line so entries line up.
function leadLine(l) {
  return `${l.name || 'Lead'} — ${l.phone || 'no phone'} — ${l.propertyInterest || 'no property noted'}`;
}
function formatDigestText(overdue, days, startOfToday) {
  const lines = ['Follow-up digest', ''];
  if (overdue.length) {
    lines.push(`OVERDUE (${overdue.length}):`);
    overdue.forEach(l => lines.push(`- ${leadLine(l)}`));
    lines.push('');
  }
  days.forEach((arr, i) => {
    if (!arr.length) return;
    lines.push(`${dayLabel(i, startOfToday).toUpperCase()} (${arr.length}):`);
    arr.forEach(l => {
      const time = new Date(l.followUpAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: TZ });
      lines.push(`- ${leadLine(l)} @ ${time}`);
    });
    lines.push('');
  });
  if (!overdue.length && !days.some(a => a.length)) lines.push(`Nothing due in the next ${LOOKAHEAD_DAYS} days.`);
  return lines.join('\n').trim();
}
function formatWhatsAppDigest(overdue, days, startOfToday) {
  const lines = ['📅 *Follow-up digest*', ''];
  if (overdue.length) {
    lines.push(`⚠️ Overdue (${overdue.length}):`);
    overdue.forEach(l => lines.push(`• ${leadLine(l)}`));
    lines.push('');
  }
  days.forEach((arr, i) => {
    if (!arr.length) return;
    lines.push(`📅 ${dayLabel(i, startOfToday)} (${arr.length}):`);
    arr.forEach(l => {
      const time = new Date(l.followUpAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: TZ });
      lines.push(`• ${leadLine(l)} @ ${time}`);
    });
    lines.push('');
  });
  if (!overdue.length && !days.some(a => a.length)) lines.push(`Nothing due in the next ${LOOKAHEAD_DAYS} days. 🎉`);
  return lines.join('\n').trim();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Every section's table uses the same column set/order/widths so Name,
// Phone, and Property line up visually whether you're looking at Overdue
// or any of the day sections.
const COLS = [
  { label: 'Name', width: '26%' },
  { label: 'Phone', width: '20%' },
  { label: 'Property', width: '34%' },
  { label: 'Time', width: '20%' }
];
function leadRowHtml(l, showTime) {
  const time = showTime ? new Date(l.followUpAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600;">${escapeHtml(l.name || 'Lead')}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(l.phone || '—')}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(l.propertyInterest || '—')}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${time}</td>
  </tr>`;
}
function sectionHtml(title, color, rows, showTime) {
  if (!rows.length) return '';
  return `
    <h3 style="color:${color};margin:18px 0 8px;font-family:sans-serif;">${title} (${rows.length})</h3>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;table-layout:fixed;">
      <colgroup>${COLS.map(c => `<col style="width:${c.width}">`).join('')}</colgroup>
      <tr style="text-align:left;color:#888;font-size:11px;text-transform:uppercase;">
        ${COLS.map(c => `<th style="padding:4px 10px;">${c.label}</th>`).join('')}
      </tr>
      ${rows.map(l => leadRowHtml(l, showTime)).join('')}
    </table>`;
}
function formatDigestHtml(overdue, days, startOfToday) {
  let body = sectionHtml('⚠️ Overdue', '#B91C1C', overdue, false);
  days.forEach((arr, i) => { body += sectionHtml(`📅 ${dayLabel(i, startOfToday)}`, i === 0 ? '#B45309' : '#1D4ED8', arr, true); });
  return `<div style="font-family:sans-serif;">
    <h2 style="font-family:sans-serif;">Follow-up digest</h2>
    ${body || `<p style="font-family:sans-serif;color:#888;">Nothing due in the next ${LOOKAHEAD_DAYS} days.</p>`}
  </div>`;
}

async function digestForTenant(db, tenantId) {
  const settingsSnap = await db.collection('settings').doc(tenantId).get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const waRecipients = settings.followupDigestEnabled ? (settings.followupDigestRecipients || []) : [];
  const emailRecipients = settings.followupDigestEmailEnabled ? (settings.followupDigestEmails || []) : [];
  if (!waRecipients.length && !emailRecipients.length) return { tenantId, skipped: true, results: [] };

  const leadsSnap = await db.collection('leads').where('tenantId', '==', tenantId).get();
  const { overdue, days, startOfToday } = bucketLeads(leadsSnap);

  const results = [];
  if (waRecipients.length) {
    const message = formatWhatsAppDigest(overdue, days, startOfToday);
    for (const raw of waRecipients) {
      const to = normalizePhone(raw);
      if (!to) continue;
      const r = await sendWhatsAppText(db, tenantId, to, message);
      results.push({ channel: 'whatsapp', to, ...r });
    }
  }
  if (emailRecipients.length) {
    const triggeredAt = new Date();
    const dateStr = triggeredAt.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ });
    const timeStr = triggeredAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: TZ });
    const subject = `3 PIN Realty Follow up (${dateStr}) ${timeStr}`;
    const text = formatDigestText(overdue, days, startOfToday);
    const html = formatDigestHtml(overdue, days, startOfToday);
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
  const today = istDateString();
  const summary = [];
  let pipelinesSnap;
  try {
    pipelinesSnap = await db.collection('pipelines').get();
  } catch (e) {
    // Total failure to even list tenants — surface it loudly (500) so an
    // uptime check / the Vercel dashboard shows the cron erroring instead of
    // silently returning 200 with nothing sent.
    console.error('followup-digest: failed to list pipelines:', e);
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Each tenant is isolated in its own try/catch + written run-record, so one
  // tenant's failure never aborts the others and every outcome is observable
  // afterwards in settings/{tenantId}.lastDigestRun (also surfaced in the CRM's
  // Follow-up Digest modal).
  for (const doc of pipelinesSnap.docs) {
    const tenantId = doc.id;
    const settingsRef = db.collection('settings').doc(tenantId);
    try {
      const sSnap = await settingsRef.get();
      const s = sSnap.exists ? sSnap.data() : {};
      if (s.lastDigestSentDate === today) { summary.push({ tenantId, skipped: 'already-sent-today' }); continue; }

      const r = await digestForTenant(db, tenantId);
      if (r.skipped) { summary.push({ tenantId, skipped: 'no-recipients' }); continue; }

      // Mark the day AFTER a successful run so a failed send can be retried by
      // a later trigger the same day, while a success blocks a redundant one.
      await settingsRef.set({
        lastDigestSentDate: today,
        lastDigestRun: { at: Date.now(), source: 'cron', date: today, results: r.results }
      }, { merge: true });
      summary.push({ tenantId, sent: r.results });
    } catch (e) {
      console.error('followup-digest: tenant', tenantId, 'failed:', e);
      await settingsRef.set({
        lastDigestRun: { at: Date.now(), source: 'cron', date: today, error: String((e && e.message) || e) }
      }, { merge: true }).catch(() => {});
      summary.push({ tenantId, error: String((e && e.message) || e) });
    }
  }

  return new Response(JSON.stringify({ ranAt: Date.now(), date: today, tenants: summary }), {
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
  // Record manual sends too (for the "last sent" indicator), but deliberately
  // do NOT set lastDigestSentDate — a manual "Send now" and the scheduled
  // daily digest are independent, so neither suppresses the other.
  await db.collection('settings').doc(user.tenantId).set({
    lastDigestRun: { at: Date.now(), source: 'manual', results: r.results }
  }, { merge: true }).catch(() => {});
  return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
