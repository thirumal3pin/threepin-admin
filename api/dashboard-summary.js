import { getDb, verifyCrmUser, sendEmail } from './_bot-shared.js';
import { computeDashboardMetrics, formatINR } from '../crm-assets/dashboardMetrics.js';
import { summarizeDeadReasons } from './_dashboard-ai-shared.js';

const TZ = 'Asia/Kolkata';

function istDateString(ts = Date.now()) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ });
}
function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
}
function fmtDateTime(ts) {
  return ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function truncate(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── HTML building blocks (inline CSS, ≤600px, single column) ────────────
const CARD = 'background:#fff;border:1px solid #eee;border-radius:10px;padding:14px 16px;margin-bottom:12px;';
const TABLE_HEAD = 'text-align:left;color:#888;font-size:11px;text-transform:uppercase;';
const TD = 'padding:6px 8px;border-bottom:1px solid #eee;';

function statCardsHtml(m) {
  const stats = [
    ['New Today', m.newLeadsToday.total],
    ['Followed Up', m.followedUpToday.count],
    ['Overdue', m.overdueFollowUps.count],
    ['Cold Leads', m.coldLeads.count],
    ['Pending Site Visit', m.siteVisitPending.total],
    ['Site Visit Done', m.siteVisitDone.total],
    ['Missed Calls', m.missedCalls.total],
    ['Closed Today', m.movedToWonToday.count]
  ];
  return `<div style="display:table;width:100%;border-collapse:collapse;margin-bottom:16px;">` +
    Array.from({ length: Math.ceil(stats.length / 2) }, (_, row) => `
      <div style="display:table-row;">
        ${stats.slice(row * 2, row * 2 + 2).map(([label, val]) => `
          <div style="display:table-cell;width:50%;padding:6px;">
            <div style="${CARD}">
              <div style="font-size:22px;font-weight:700;font-family:Georgia,serif;">${val}</div>
              <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(label)}</div>
            </div>
          </div>`).join('')}
      </div>`).join('') + `</div>`;
}

function sectionWrap(title, headline, bodyHtml) {
  return `
    <div style="margin:22px 0 8px;">
      <h3 style="margin:0 0 4px;font-family:sans-serif;color:#1C1917;">${title}</h3>
      ${headline ? `<div style="font-size:20px;font-weight:700;font-family:Georgia,serif;margin-bottom:8px;">${headline}</div>` : ''}
      ${bodyHtml}
    </div>`;
}
function emptyLine() { return `<p style="font-family:sans-serif;color:#888;font-size:13px;">0 — nothing to report</p>`; }

function rowsWithCap(rows, cap) {
  const shown = rows.slice(0, cap);
    const extra = rows.length - shown.length;
  return { shown, extraLine: extra > 0 ? `<p style="font-family:sans-serif;color:#888;font-size:12px;">+ ${extra} more</p>` : '' };
}
function tableWrap(headers, bodyRows) {
  return `<div style="overflow-x:auto;"><table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;">
    <tr style="${TABLE_HEAD}">${headers.map(h => `<th style="padding:4px 8px;">${h}</th>`).join('')}</tr>
    ${bodyRows}
  </table></div>`;
}

function actionLogSection(m) {
  if (!m.actionLog.count) return sectionWrap("📝 Today's Action Log", null, emptyLine());
  const { shown, extraLine } = rowsWithCap(m.actionLog.rows, 25);
  const body = shown.map(r => `<tr>
    <td style="${TD}font-weight:600;">${escapeHtml(r.lead.name || 'Lead')}</td>
    <td style="${TD}">${escapeHtml(r.lead.phone || '—')}</td>
    <td style="${TD}">${escapeHtml(r.lead.propertyInterest || '—')}</td>
    <td style="${TD}">${r.stageFrom ? `${escapeHtml(r.stageFrom)} → ${escapeHtml(r.stageTo)}` : escapeHtml(r.stageTo)}</td>
    <td style="${TD}">${escapeHtml(r.line)}</td>
    <td style="${TD}">${escapeHtml(r.lead.updatedBy ? r.lead.updatedBy.split('@')[0] : '—')}</td>
  </tr>`).join('');
  return sectionWrap("📝 Today's Action Log", String(m.actionLog.count), tableWrap(['Name', 'Phone', 'Property', 'Stage', 'Action', 'By'], body) + extraLine);
}

function leadTableSection(title, icon, section, cap, extraCols) {
  const leadsArr = section.leads;
  if (!leadsArr.length) return sectionWrap(`${icon} ${title}`, null, emptyLine());
  const { shown, extraLine } = rowsWithCap(leadsArr, cap);
  const cols = ['Name', 'Phone', 'Property', ...(extraCols ? extraCols.map(c => c.label) : [])];
  const body = shown.map(l => `<tr>
    <td style="${TD}font-weight:600;">${escapeHtml(l.name || 'Lead')}</td>
    <td style="${TD}">${escapeHtml(l.phone || '—')}</td>
    <td style="${TD}">${escapeHtml(l.propertyInterest || '—')}</td>
    ${extraCols ? extraCols.map(c => `<td style="${TD}">${c.value(l)}</td>`).join('') : ''}
  </tr>`).join('');
  return sectionWrap(`${icon} ${title}`, String(leadsArr.length), tableWrap(cols, body) + extraLine);
}

function newLeadsTodaySection(m) {
  const n = m.newLeadsToday;
  if (!n.total) return sectionWrap('📈 New Leads Today', null, emptyLine());
  const trend = n.deltaPct === null ? '' : ` (${n.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(n.deltaPct)}% vs 7-day avg of ${n.trailing7DayAvg}/day)`;
  const miniList = (rows) => rows.map(r => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:2px 0;"><span>${escapeHtml(r.label || r.key)}</span><span>${r.count}</span></div>`).join('');
  return sectionWrap('📈 New Leads Today', `${n.total}${trend}`, `
    <div style="display:table;width:100%;">
      <div style="display:table-row;">
        <div style="display:table-cell;width:33%;vertical-align:top;padding-right:8px;"><div style="font-size:11px;color:#888;text-transform:uppercase;margin-bottom:4px;">By Channel</div>${miniList(n.byChannel)}</div>
        <div style="display:table-cell;width:33%;vertical-align:top;padding-right:8px;"><div style="font-size:11px;color:#888;text-transform:uppercase;margin-bottom:4px;">By Enquiry Type</div>${miniList(n.byEnquiryType)}</div>
        <div style="display:table-cell;width:34%;vertical-align:top;"><div style="font-size:11px;color:#888;text-transform:uppercase;margin-bottom:4px;">By Source</div>${miniList(n.bySource)}</div>
      </div>
    </div>
    <p style="font-family:sans-serif;font-size:12px;color:#888;margin-top:8px;">Month-to-date: ${n.monthToDateTotal}</p>`);
}

function pipelineSection(m) {
  const rows = m.pipelineByStage.stages;
  if (!rows.length) return sectionWrap('📊 Pipeline by Stage', null, emptyLine());
  const body = rows.map(s => `<tr>
    <td style="${TD}"><span style="background:${s.color}22;color:${s.color};border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;">${escapeHtml(s.name)}</span></td>
    <td style="${TD}">${s.count}</td>
    <td style="${TD}">${s.pct}%</td>
  </tr>`).join('');
  return sectionWrap('📊 Pipeline by Stage', null, tableWrap(['Stage', 'Leads', '% of total'], body));
}

function ownerSection(m) {
  const owners = m.ownerActivity.owners;
  if (!owners.length) return sectionWrap('👤 Owner Activity', null, emptyLine());
  const body = owners.map(o => `<tr>
    <td style="${TD}font-weight:600;">${escapeHtml(o.owner)}${o.flagged ? ' ⚠️' : ''}</td>
    <td style="${TD}">${o.touchedToday}</td>
    <td style="${TD}">${o.followedUpToday}</td>
    <td style="${TD}">${o.newAssigned}</td>
    <td style="${TD}">${o.openLeads}</td>
    <td style="${TD}">${o.overdueCount}</td>
  </tr>`).join('');
  return sectionWrap('👤 Owner Activity', null, tableWrap(['Owner', 'Touched', 'Followed Up', 'New', 'Open', 'Overdue'], body));
}

function hygieneSection(m) {
  const h = m.dataHygiene;
  const rows = [
    ['Missing phone', h.missingPhone.count],
    ['Missing budget', h.missingBudget.count],
    ['No follow-up date (open leads)', h.noFollowUpDate.count],
    ['No AI summary', h.noAiSummary.count],
    ['Duplicate phone numbers', h.duplicatePhones.count]
  ];
  const body = rows.map(([label, count]) => `<tr><td style="${TD}">${escapeHtml(label)}</td><td style="${TD}">${count}</td></tr>`).join('');
  return sectionWrap('🧹 Data Hygiene', null, tableWrap(['Check', 'Count'], body));
}

async function movedToDeadSection(m) {
  const leadsArr = m.movedToDeadToday.leads;
  if (!leadsArr.length) return sectionWrap('🚫 Moved to Not Interested / Spam Today', null, emptyLine());
  // Single batched Haiku call for the whole section (see _dashboard-ai-shared.js
  // guardrails) — never per-lead, fails soft to the raw note text on any error.
  let reasons = new Map();
  try {
    reasons = await summarizeDeadReasons(leadsArr.map(l => ({ id: l.id, note: (l.lastNote && l.lastNote.text) || '' })));
  } catch { /* non-fatal — falls back to raw notes below */ }
  const { shown, extraLine } = rowsWithCap(leadsArr, 15);
  const body = shown.map(l => `<tr>
    <td style="${TD}font-weight:600;">${escapeHtml(l.name || 'Lead')}</td>
    <td style="${TD}">${escapeHtml(l.phone || '—')}</td>
    <td style="${TD}">${escapeHtml(l.propertyInterest || '—')}</td>
    <td style="${TD}">${escapeHtml(reasons.get(l.id) || (l.lastNote && l.lastNote.text) || '—')}</td>
  </tr>`).join('');
  return sectionWrap('🚫 Moved to Not Interested / Spam Today', String(leadsArr.length), tableWrap(['Name', 'Phone', 'Property', 'Reason'], body) + extraLine);
}

async function renderDashboardEmailHtml(m, dateStr) {
  const wonHeadline = m.movedToWonToday.count
    ? `${m.movedToWonToday.count}${m.movedToWonToday.totalValueINR > 0 ? ` · ${formatINR(m.movedToWonToday.totalValueINR)} combined value` : ''}`
    : null;
  const body = [
    statCardsHtml(m),
    actionLogSection(m),
    newLeadsTodaySection(m),
    leadTableSection('Overdue Follow-ups', '⚠️', m.overdueFollowUps, 15, [{ label: 'Was due', value: l => fmtDateTime(l.followUpAt) }]),
    leadTableSection("Tomorrow's Follow-up Plan", '🌤️', m.followUpsDueTomorrow, 25, [{ label: 'Time', value: l => fmtTime(l.followUpAt) }]),
    sectionWrap('🎉 Moved to Closed Today', wonHeadline, m.movedToWonToday.count ? tableWrap(['Name', 'Phone', 'Budget'], m.movedToWonToday.leads.map(l => `<tr><td style="${TD}font-weight:600;">${escapeHtml(l.name || 'Lead')}</td><td style="${TD}">${escapeHtml(l.phone || '—')}</td><td style="${TD}">${escapeHtml(l.budget || '—')}</td></tr>`).join('')) : emptyLine()),
    await movedToDeadSection(m),
    leadTableSection('Cold Leads (7+ days silent)', '🧊', m.coldLeads, 10, []),
    pipelineSection(m),
    ownerSection(m),
    hygieneSection(m)
  ].join('');

  return `<div style="max-width:600px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;color:#1C1917;">
    <div style="text-align:center;padding:10px 0 18px;">
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:700;">3 PIN Realty</div>
      <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.06em;">EOD Dashboard Summary — ${dateStr}</div>
    </div>
    ${body}
    <p style="text-align:center;color:#aaa;font-size:11px;margin-top:24px;">Generated 21:30 IST, ${dateStr} • Data window 00:00–23:59 IST • 3 PIN Realty CRM</p>
  </div>`;
}

function renderDashboardEmailText(m, dateStr) {
  const lines = [`3 PIN Realty — EOD Dashboard Summary — ${dateStr}`, ''];
  lines.push(`New today: ${m.newLeadsToday.total} | Followed up: ${m.followedUpToday.count} | Overdue: ${m.overdueFollowUps.count} | Cold: ${m.coldLeads.count}`);
  lines.push(`Pending site visit: ${m.siteVisitPending.total} | Site visit done: ${m.siteVisitDone.total} | Missed calls: ${m.missedCalls.total} | Closed today: ${m.movedToWonToday.count}`);
  lines.push('');
  if (m.overdueFollowUps.count) {
    lines.push(`OVERDUE (${m.overdueFollowUps.count}):`);
    m.overdueFollowUps.leads.slice(0, 15).forEach(l => lines.push(`- ${l.name || 'Lead'} — ${l.phone || '—'} — ${l.propertyInterest || '—'} — was due ${fmtDateTime(l.followUpAt)}`));
    lines.push('');
  }
  if (m.followUpsDueTomorrow.count) {
    lines.push(`TOMORROW'S PLAN (${m.followUpsDueTomorrow.count}):`);
    m.followUpsDueTomorrow.leads.slice(0, 25).forEach(l => lines.push(`- ${l.name || 'Lead'} — ${l.phone || '—'} @ ${fmtTime(l.followUpAt)}`));
    lines.push('');
  }
  lines.push(`Generated 21:30 IST, ${dateStr} · Data window 00:00–23:59 IST · 3 PIN Realty CRM`);
  return lines.join('\n');
}

async function dashboardSummaryForTenant(db, tenantId, opts) {
  opts = opts || {};
  const settingsSnap = await db.collection('settings').doc(tenantId).get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const recipients = settings.dashboardEmailEnabled ? (settings.dashboardEmailRecipients || []) : [];
  if (!recipients.length) return { tenantId, skipped: true, results: [] };

  const [leadsSnap, pipelineSnap] = await Promise.all([
    db.collection('leads').where('tenantId', '==', tenantId).get(),
    db.collection('pipelines').doc(tenantId).get()
  ]);
  const leadsArr = leadsSnap.docs.map(d => d.data());
  const stages = pipelineSnap.exists ? (pipelineSnap.data().stages || []) : [];

  const metrics = computeDashboardMetrics(leadsArr, stages, Date.now());
  const dateStr = fmtDate(Date.now());
  const subjectPrefix = opts.resend ? '[RE-SENT] ' : '';
  const subject = `${subjectPrefix}3 PIN Realty — EOD Dashboard Summary — ${dateStr}`;
  const html = await renderDashboardEmailHtml(metrics, dateStr);
  const text = renderDashboardEmailText(metrics, dateStr);

  const results = [];
  for (const to of recipients) {
    const r = await sendEmail(to, subject, text, html);
    results.push({ channel: 'email', to, ...r });
  }
  return { tenantId, skipped: false, results, leadsScanned: metrics.meta.totalLeadsScanned };
}

// Triggered by Vercel Cron (see vercel.json) at 21:30 IST daily, or manually
// from the CRM's "Send Now" button (POST). Mirrors api/followup-digest.js's
// multi-tenant loop, idempotency, and per-tenant error isolation exactly.
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
    console.error('dashboard-summary: failed to list pipelines:', e);
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  for (const doc of pipelinesSnap.docs) {
    const tenantId = doc.id;
    const settingsRef = db.collection('settings').doc(tenantId);
    try {
      const sSnap = await settingsRef.get();
      const s = sSnap.exists ? sSnap.data() : {};
      if (s.lastDashboardSentDate === today) { summary.push({ tenantId, skipped: 'already-sent-today' }); continue; }

      const r = await dashboardSummaryForTenant(db, tenantId);
      if (r.skipped) { summary.push({ tenantId, skipped: 'no-recipients' }); continue; }

      // Mark the day AFTER a successful run so a failed send can be retried by
      // a later trigger the same day, while a success blocks a redundant one —
      // same pattern as followup-digest.js.
      await settingsRef.set({
        lastDashboardSentDate: today,
        lastDashboardRun: { at: Date.now(), source: 'cron', date: today, results: r.results, leadsScanned: r.leadsScanned }
      }, { merge: true });
      summary.push({ tenantId, sent: r.results });
    } catch (e) {
      console.error('dashboard-summary: tenant', tenantId, 'failed:', e);
      await settingsRef.set({
        lastDashboardRun: { at: Date.now(), source: 'cron', date: today, error: String((e && e.message) || e) }
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

  // Folded in here (rather than its own api/dashboard-dead-reasons.js file)
  // to stay under the Hobby plan's 12-serverless-function-per-deployment cap
  // — same auth, same underlying summarizeDeadReasons() helper, just routed
  // by a query param instead of a separate path. Called on-demand by the
  // Dashboard tab's "Moved to Dead" drill-down; does no Firestore read.
  const url = new URL(request.url);
  if (url.searchParams.get('action') === 'dead-reasons') {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const items = Array.isArray(body && body.items) ? body.items.map(i => ({ id: i && i.id, note: i && i.note })) : [];
    const map = await summarizeDeadReasons(items);
    return new Response(JSON.stringify({ reasons: Object.fromEntries(map) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const db = getDb();
  // Manual "Send Now" is independent of the scheduled run — it never sets
  // lastDashboardSentDate, so it can't suppress (or be suppressed by) the
  // 21:30 IST cron, and always uses the [RE-SENT] subject prefix.
  const r = await dashboardSummaryForTenant(db, user.tenantId, { resend: true });
  await db.collection('settings').doc(user.tenantId).set({
    lastDashboardRun: { at: Date.now(), source: 'manual', results: r.results, leadsScanned: r.leadsScanned }
  }, { merge: true }).catch(() => {});
  return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
