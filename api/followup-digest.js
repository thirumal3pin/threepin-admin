import { getDb, getWhatsAppCreds, verifyCrmUser, sendEmail } from './_bot-shared.js';
import { computeAttention, SEVERITY_RANK } from '../crm-assets/leadAttention.js';
import { openMentionsFor, displayName } from '../crm-assets/mentions.js';

// What needs a person right now — the same rule book the board and action queue use, so the
// morning digest never lists something the CRM does not show, or misses something it does.
const ACTION_LIMIT = 30;
function actionItems(leadsSnap, stages, now = Date.now()) {
  const items = [];
  leadsSnap.forEach(d => {
    const l = d.data();
    const top = computeAttention(l, { stages, now })[0];
    if (top && SEVERITY_RANK[top.severity] >= SEVERITY_RANK.high) items.push({ lead: l, top });
  });
  return items.sort((a, b) => (SEVERITY_RANK[b.top.severity] - SEVERITY_RANK[a.top.severity]) || ((a.top.at || 0) - (b.top.at || 0)));
}
function actionLine(item, stages) {
  const stage = stages.find(s => s.id === item.lead.stageId);
  return `${item.lead.name || 'Lead'} — ${item.top.label}${item.top.detail ? ' (' + item.top.detail + ')' : ''} — ${stage ? stage.name : 'no stage'} — ${item.lead.phone || 'no phone'}`;
}

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

// Who last touched the lead, as the local part of their login email — the
// same short form the CRM shows on cards and in the action log, so a name in
// the digest matches what the agent sees in the app.
function updatedByLabel(l) {
  const email = l.updatedBy || l.createdBy;
  if (!email) return '—';
  const at = String(email).indexOf('@');
  return at > 0 ? String(email).slice(0, at) : String(email);
}

// Property is always shown so an agent can act without opening the CRM;
// kept in the same position/format across every line so entries line up.
function leadLine(l) {
  return `${l.name || 'Lead'} — ${l.phone || 'no phone'} — ${l.propertyInterest || 'no property noted'} — last updated by ${updatedByLabel(l)}`;
}
function formatDigestText(overdue, days, startOfToday, actions = [], stages = [], mentions = []) {
  const lines = ['Follow-up digest', ''];
  if (mentions.length) {
    lines.push(`MENTIONED YOU (${mentions.length}):`);
    mentions.slice(0, ACTION_LIMIT).forEach(({ lead, mention }) => lines.push(`- ${lead.name || 'Lead'} — ${displayName(mention.by || '') || 'A teammate'}: “${mention.text || ''}”`));
    lines.push('');
  }
  if (actions.length) {
    lines.push(`NEEDS ACTION NOW (${actions.length}):`);
    actions.slice(0, ACTION_LIMIT).forEach(a => lines.push(`- ${actionLine(a, stages)}`));
    if (actions.length > ACTION_LIMIT) lines.push(`- …and ${actions.length - ACTION_LIMIT} more in the CRM`);
    lines.push('');
  }
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
function formatWhatsAppDigest(overdue, days, startOfToday, actions = [], stages = []) {
  const lines = ['📅 *Follow-up digest*', ''];
  if (actions.length) {
    lines.push(`🔴 Needs action now (${actions.length}):`);
    actions.slice(0, ACTION_LIMIT).forEach(a => lines.push(`• ${actionLine(a, stages)}`));
    if (actions.length > ACTION_LIMIT) lines.push(`• …and ${actions.length - ACTION_LIMIT} more in the CRM`);
    lines.push('');
  }
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
  { label: 'Name', width: '20%' },
  { label: 'Phone', width: '16%' },
  { label: 'Property', width: '26%' },
  { label: 'Last Updated By', width: '23%' },
  { label: 'Time', width: '15%' }
];
function leadRowHtml(l, showTime) {
  const time = showTime ? new Date(l.followUpAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600;">${escapeHtml(l.name || 'Lead')}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(l.phone || '—')}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(l.propertyInterest || '—')}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(updatedByLabel(l))}</td>
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
function actionSectionHtml(actions, stages) {
  if (!actions.length) return '';
  const rows = actions.slice(0, ACTION_LIMIT).map(a => {
    const stage = stages.find(s => s.id === a.lead.stageId);
    const color = a.top.severity === 'critical' ? '#B91C1C' : '#B45309';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600;">${escapeHtml(a.lead.name || 'Lead')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:${color};">${escapeHtml(a.top.label)}${a.top.detail ? `<div style="color:#888;font-size:12px;">${escapeHtml(a.top.detail)}</div>` : ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(stage ? stage.name : '—')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(a.lead.phone || '—')}</td>
    </tr>`;
  }).join('');
  const more = actions.length > ACTION_LIMIT ? `<p style="font-family:sans-serif;color:#888;font-size:12px;">…and ${actions.length - ACTION_LIMIT} more in the CRM.</p>` : '';
  return `
    <h3 style="color:#B91C1C;margin:18px 0 8px;font-family:sans-serif;">🔴 Needs action now (${actions.length})</h3>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;table-layout:fixed;">
      <colgroup><col style="width:22%"><col style="width:44%"><col style="width:17%"><col style="width:17%"></colgroup>
      <tr style="text-align:left;color:#888;font-size:11px;text-transform:uppercase;"><th style="padding:4px 10px;">Name</th><th style="padding:4px 10px;">What to do</th><th style="padding:4px 10px;">Stage</th><th style="padding:4px 10px;">Phone</th></tr>
      ${rows}
    </table>${more}`;
}
// Notes where a teammate @mentioned this recipient, still open (crm-assets/mentions.js).
function mentionSectionHtml(mentions) {
  if (!mentions.length) return '';
  const rows = mentions.slice(0, ACTION_LIMIT).map(({ lead, mention }) => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600;">${escapeHtml(lead.name || 'Lead')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;"><b>${escapeHtml(displayName(mention.by || '') || 'A teammate')}</b>: “${escapeHtml(mention.text || '')}”</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(lead.phone || '—')}</td>
    </tr>`).join('');
  return `
    <h3 style="color:#6D28D9;margin:18px 0 8px;font-family:sans-serif;">@ Mentioned you (${mentions.length})</h3>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;table-layout:fixed;">
      <colgroup><col style="width:22%"><col style="width:61%"><col style="width:17%"></colgroup>
      ${rows}
    </table>`;
}
function formatDigestHtml(overdue, days, startOfToday, actions = [], stages = [], mentions = []) {
  let body = mentionSectionHtml(mentions) + actionSectionHtml(actions, stages);
  body += sectionHtml('⚠️ Overdue', '#B91C1C', overdue, false);
  days.forEach((arr, i) => { body += sectionHtml(`📅 ${dayLabel(i, startOfToday)}`, i === 0 ? '#B45309' : '#1D4ED8', arr, true); });
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#0A0A0A;">
    <div style="padding:0 0 14px;border-bottom:3px solid #FE8D00;margin-bottom:6px;">
      <div style="font-size:20px;font-weight:700;letter-spacing:-.03em;">3 PIN Realty</div>
      <div style="font-size:11px;color:#A85C00;font-weight:700;text-transform:uppercase;letter-spacing:.12em;margin-top:3px;">Follow-up digest</div>
    </div>
    ${body || `<p style="font-family:sans-serif;color:#888;">Nothing due in the next ${LOOKAHEAD_DAYS} days.</p>`}
  </div>`;
}

async function digestForTenant(db, tenantId) {
  const settingsSnap = await db.collection('settings').doc(tenantId).get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const waRecipients = settings.followupDigestEnabled ? (settings.followupDigestRecipients || []) : [];
  const emailRecipients = settings.followupDigestEmailEnabled ? (settings.followupDigestEmails || []) : [];
  if (!waRecipients.length && !emailRecipients.length) return { tenantId, skipped: true, results: [] };

  const [leadsSnap, pipelineSnap] = await Promise.all([
    db.collection('leads').where('tenantId', '==', tenantId).get(),
    db.collection('pipelines').doc(tenantId).get()
  ]);
  const stages = pipelineSnap.exists ? (pipelineSnap.data().stages || []) : [];
  const { overdue, days, startOfToday } = bucketLeads(leadsSnap);
  const actions = actionItems(leadsSnap, stages);

  const results = [];
  if (waRecipients.length) {
    const message = formatWhatsAppDigest(overdue, days, startOfToday, actions, stages);
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
    const allLeads = leadsSnap.docs.map(d => d.data());
    for (const to of emailRecipients) {
      // The same digest for everyone, plus the notes that mention this recipient.
      const mine = openMentionsFor(allLeads, to);
      const text = formatDigestText(overdue, days, startOfToday, actions, stages, mine);
      const html = formatDigestHtml(overdue, days, startOfToday, actions, stages, mine);
      const r = await sendEmail(to, mine.length ? `${subject} · ${mine.length} mention${mine.length === 1 ? '' : 's'}` : subject, text, html);
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
