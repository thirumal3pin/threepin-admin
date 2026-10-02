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
    // Today's completed visits, NOT the all-time size of the stage — this is a
    // report on one day's activity, so a standing total belongs nowhere in it.
    ['Site Visits Today', m.siteVisitDone.movedTodayCount],
    ['Needs Action', m.needsAction.total],
    ['Closed Today', m.movedToWonToday.count]
  ];
  return `<div style="display:table;width:100%;border-collapse:collapse;margin-bottom:16px;">` +
    Array.from({ length: Math.ceil(stats.length / 2) }, (_, row) => `
      <div style="display:table-row;">
        ${stats.slice(row * 2, row * 2 + 2).map(([label, val]) => `
          <div style="display:table-cell;width:50%;padding:6px;">
            <div style="${CARD}">
              <div style="font-size:24px;font-weight:700;letter-spacing:-.02em;">${val}</div>
              <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(label)}</div>
            </div>
          </div>`).join('')}
      </div>`).join('') + `</div>`;
}

function sectionWrap(title, headline, bodyHtml) {
  return `
    <div style="margin:22px 0 8px;">
      <h3 style="margin:0 0 4px;font-family:sans-serif;color:#0A0A0A;font-size:16px;">${title}</h3>
      ${headline ? `<div style="font-size:20px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px;">${headline}</div>` : ''}
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

function siteVisitsTodaySection(m) {
  const leadsArr = m.siteVisitDone.movedTodayLeads;
  if (!leadsArr.length) return sectionWrap('🏠 Site Visits Done Today', null, emptyLine());
  const { shown, extraLine } = rowsWithCap(leadsArr, 25);
  const body = shown.map(l => `<tr>
    <td style="${TD}font-weight:600;">${escapeHtml(l.name || 'Lead')}</td>
    <td style="${TD}">${escapeHtml(l.phone || '—')}</td>
    <td style="${TD}">${escapeHtml(l.propertyInterest || '—')}</td>
    <td style="${TD}">${escapeHtml(l.updatedBy ? l.updatedBy.split('@')[0] : '—')}</td>
  </tr>`).join('');
  return sectionWrap('🏠 Site Visits Done Today', String(leadsArr.length),
    tableWrap(['Name', 'Phone', 'Property', 'By'], body) + extraLine);
}

// Property Enquiry leads are grouped by property; everything else by enquiry
// type. Both sides share the metrics engine's group shape, so one pair of
// renderers covers them — see finishGroups() in dashboardMetrics.js.
function groupTodaySection(section, icon, title, colLabel) {
  const rows = section.newTodayRows;
  if (!rows.length) return sectionWrap(`${icon} ${title}`, null, emptyLine());
  const body = rows.map(r => `<tr>
    <td style="${TD}font-weight:600;">${escapeHtml(r.label)}</td>
    <td style="${TD}">${r.newToday}</td>
    <td style="${TD}">${r.total}</td>
  </tr>`).join('');
  return sectionWrap(`${icon} ${title}`, String(section.newTodayTotal),
    tableWrap([colLabel, 'New today', 'Total (excl. spam)'], body));
}

function groupPerformanceSection(section, icon, title, colLabel, note) {
  const rows = section.rows;
  if (!rows.length) return sectionWrap(`${icon} ${title}`, null, emptyLine());
  const { shown, extraLine } = rowsWithCap(rows, 15);
  const body = shown.map(r => `<tr>
    <td style="${TD}font-weight:600;">${escapeHtml(r.label)}</td>
    <td style="${TD}">${r.total}</td>
    <td style="${TD}">${r.open}</td>
    <td style="${TD}">${r.siteVisitDone}</td>
    <td style="${TD}">${r.won}</td>
    <td style="${TD}">${r.conversionPct === null ? '—' : r.conversionPct + '%'}</td>
    <td style="${TD}">${r.pipelineValueINR ? formatINR(r.pipelineValueINR) : '—'}</td>
  </tr>`).join('');
  return sectionWrap(`${icon} ${title}`, `${rows.length}`,
    `<p style="font-family:sans-serif;font-size:12px;color:#888;margin:0 0 6px;">${escapeHtml(note)}</p>`
    + tableWrap([colLabel, 'Total', 'Open', 'Visits', 'Closed', 'Conv.', 'Pipeline'], body) + extraLine);
}

function journeySection(m) {
  const body = m.journey.map(s => `<tr>
    <td style="${TD}font-weight:600;">${escapeHtml(s.label)}</td>
    <td style="${TD}">${s.count}</td>
    <td style="${TD}">${s.pct === null ? '—' : s.pct + '%'}</td>
    <td style="${TD}">${s.medianDays == null ? '—' : s.medianDays + 'd'}</td>
  </tr>`).join('');
  return sectionWrap('🚀 Lead Journey', null, tableWrap(['Milestone reached', 'Leads', '% of all', 'Typical days in'], body));
}

function mixSection(m) {
  const list = (title, rows) => rows.length
    ? `<div style="display:table-cell;width:33%;vertical-align:top;padding-right:8px;">
         <div style="font-size:11px;color:#888;text-transform:uppercase;margin-bottom:4px;">${title}</div>
         ${rows.map(r => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:2px 0;"><span>${escapeHtml(r.label)}</span><span>${r.count}</span></div>`).join('')}
       </div>`
    : '';
  return sectionWrap('🧭 Lead Mix (all-time)', null,
    `<div style="display:table;width:100%;"><div style="display:table-row;">
       ${list('By Channel', m.mix.byChannel)}
       ${list('By Source', m.mix.bySource)}
       ${list('By Budget', m.mix.byBudgetBand)}
     </div></div>`);
}

function kpiSection(m) {
  const k = m.kpis;
  const rows = [
    ['Total leads (excl. spam)', String(k.nonSpamTotal)],
    ['Open pipeline value', formatINR(k.openPipelineValueINR)],
    ['Open leads', String(k.openLeads)],
    ['Conversion rate', k.conversionPct === null ? '—' : k.conversionPct + '%'],
    ['Site-visit rate', k.siteVisitConversionPct === null ? '—' : k.siteVisitConversionPct + '%'],
    ['Details shared (open leads)', k.detailsSentPct === null ? '—' : k.detailsSentPct + '%'],
    ['Overdue (open leads)', k.overduePct === null ? '—' : k.overduePct + '%'],
    ['New leads / day (14-day avg)', String(k.avgNewLeadsPerDay)],
    ['New leads month-to-date', String(k.newLeadsMTD)]
  ];
  const body = rows.map(([label, value]) => `<tr><td style="${TD}">${escapeHtml(label)}</td><td style="${TD}font-weight:600;">${escapeHtml(value)}</td></tr>`).join('');
  return sectionWrap('📌 Portfolio KPIs', null, tableWrap(['Metric', 'Value'], body));
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

// ── ESCALATIONS — first thing in the report ─────────────────────────────
// TailorTalk escalates a chat when its AI hands the customer to a person. Since 23 Sep 2026 the
// escalation clears when someone on the team replies in TailorTalk (verified against the data:
// every clear followed a human reply; nothing clears on a timer). The owner reads the day's
// escalations first — each one answered or not — and the older backlog after.
// Everything here reads fields the TailorTalk sync keeps on lead.tt; no extra reads.
const HOUR = 3600000;
function ago(ms) {
  if (ms == null || ms < 0) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60 && h < 3 ? ' ' + (m % 60) + 'm' : '');
  const d = Math.floor(h / 24), rh = h % 24;
  return d + 'd' + (rh && d < 3 ? ' ' + rh + 'h' : '');
}
const isVendor = l => !!(l.tt && l.tt.category && String(l.tt.category).toLowerCase() !== 'sales');
// When TailorTalk began clearing an escalation on a human reply (first clear seen in the data).
const CLEAR_ON_REPLY_FROM = Date.parse('2026-09-23T06:30:00Z');
const istDayStart = now => { const d = new Date(now + 5.5 * HOUR); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 5.5 * HOUR; };

export const ESCALATION_WINDOW_DAYS = 3;
export function escalationMetrics(leads, now = Date.now()) {
  const dayStart = istDayStart(now) - (ESCALATION_WINDOW_DAYS - 1) * 24 * HOUR;
  const tt = leads.filter(l => l && l.tt);
  const vendorsOpen = tt.filter(l => l.tt.escalated && isVendor(l)).length;
  const sales = tt.filter(l => !isVendor(l));

  // One row per escalation the window is about: still open, or closed inside the window.
  const rows = [];
  for (const l of sales) {
    const t = l.tt;
    if (t.escalated) {
      // Answered while still showing escalated: a person replied after it opened (TailorTalk
      // clears it shortly — the CRM hears at the next event). One open since before tracking
      // began (13 Sep import) whose last human reply predates clear-on-reply is probably stale:
      // the team talked to them, but there is no proof the reply came after the escalation.
      const stale = !t.escalatedAt && t.lastHumanAt && t.lastHumanAt < CLEAR_ON_REPLY_FROM;
      const replyAt = t.escalationReplyAt || null;
      const last = t.latestAsk;
      rows.push({ lead: l, at: t.escalatedAt || null, replyAt: replyAt || (stale ? t.lastHumanAt : null), by: (replyAt || stale) ? t.lastHumanBy : null,
        answered: !!replyAt, stale: !!stale, status: replyAt ? 'replied-open' : stale ? 'stale' : 'waiting',
        stillWriting: !replyAt && !!(last && last.at > (t.escalatedAt || 0) && last.at > (t.lastHumanAt || 0)),
        lastAskAt: last && last.at, why: t.escalationAsk && t.escalationAsk.text, pending: t.stage });
    } else if (t.escalationClearedAt >= dayStart) {
      const e = t.lastEscalation || {};
      rows.push({ lead: l, at: e.at || null, replyAt: e.replyAt || null, by: t.lastHumanBy, answered: true, status: 'cleared',
        why: null, pending: t.stage });
    }
  }
  rows.forEach(r => { r.today = r.at != null && r.at >= dayStart; r.waitMs = r.at ? (r.replyAt || now) - r.at : null; });
  // r.today means "inside the window" (the last ESCALATION_WINDOW_DAYS days).
  const byWait = (a, b) => (b.stillWriting - a.stillWriting) || ((a.at ?? 0) - (b.at ?? 0));
  // Not answered first (the work), then answered; newest first within each.
  const today = rows.filter(r => r.today).sort((a, b) => (a.answered - b.answered) || ((b.at || 0) - (a.at || 0)));
  const olderWaiting = rows.filter(r => !r.today && !r.answered && !r.stale).sort(byWait);
  const stale = rows.filter(r => r.stale).sort((a, b) => (b.replyAt || 0) - (a.replyAt || 0));
  const olderAnswered = rows.filter(r => !r.today && r.answered).sort((a, b) => (b.replyAt || 0) - (a.replyAt || 0));
  const replyTimes = today.filter(r => r.answered && r.waitMs != null && r.waitMs >= 0).map(r => r.waitMs).sort((a, b) => a - b);
  const aging = { '1–3 days': 0, '3–7 days': 0, 'Over 7 days': 0, 'Before 13 Sep (start unknown)': 0 };
  olderWaiting.forEach(r => { const age = r.at ? now - r.at : null; aging[age == null ? 'Before 13 Sep (start unknown)' : age < 72 * HOUR ? '1–3 days' : age < 168 * HOUR ? '3–7 days' : 'Over 7 days']++; });
  return {
    today, olderWaiting, olderAnswered, stale, windowStart: dayStart,
    todayAnswered: today.filter(r => r.answered).length,
    todayWaiting: today.filter(r => !r.answered).length,
    medianReplyMsToday: replyTimes.length ? replyTimes[Math.floor((replyTimes.length - 1) / 2)] : null,
    aging, vendorsOpen
  };
}

function escalationSection(e, now) {
  const tile = (v, label, color) => `<div style="display:table-cell;width:25%;padding:4px;"><div style="${CARD}text-align:center;margin:0;">
      <div style="font-size:22px;font-weight:700;color:${color || '#0A0A0A'};">${v}</div>
      <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.04em;">${label}</div></div></div>`;
  const what = `<p style="font-family:sans-serif;font-size:12px;color:#666;margin:0 0 10px;line-height:1.5;">
    <b>Escalation</b> = TailorTalk's AI handed the chat to a person (it could not answer, or the customer asked for someone).
    It clears once someone on the team <b>replies in TailorTalk</b> — it never clears by waiting.</p>`;
  const tiles = `<div style="display:table;width:100%;margin-bottom:10px;"><div style="display:table-row;">
      ${tile(e.today.length, 'Escalated · last 3 days')}
      ${tile(e.todayAnswered, 'Answered', '#067647')}
      ${tile(e.todayWaiting, 'Not answered', e.todayWaiting ? '#B42318' : '#067647')}
      ${tile(e.medianReplyMsToday == null ? '—' : ago(e.medianReplyMsToday), 'Median reply time')}
    </div></div>`;
  const sub = (txt, color) => `<div style="font-family:sans-serif;font-size:13px;font-weight:700;margin:14px 0 4px;color:${color};">${txt}</div>`;
  const who = r => `<b>${escapeHtml(r.lead.name || 'Lead')}</b><br><span style="color:#888;font-size:12px;">${escapeHtml(r.lead.phone || '—')}</span>`;
  const about = r => `${r.why ? '“' + escapeHtml(truncate(r.why, 110)) + '”' : '<span style="color:#888;">—</span>'}${r.pending ? '<br><span style="color:#666;">Pending: ' + escapeHtml(truncate(r.pending, 120)) + '</span>' : ''}`;
  const state = r => r.answered
    ? `<span style="color:#067647;font-weight:600;">✓ Answered</span><br><span style="font-size:11px;color:#555;">${escapeHtml(r.by ? r.by.split('@')[0] : 'team')} · ${r.waitMs == null ? '' : 'in ' + ago(r.waitMs)}</span>${r.status === 'replied-open' ? '<br><span style="font-size:11px;color:#A85C00;">still escalated in TailorTalk</span>' : ''}`
    : `<span style="color:#B42318;font-weight:600;">✗ Not answered</span><br><span style="font-size:11px;color:#555;">waiting ${ago(r.waitMs)}</span>${r.stillWriting ? '<br><span style="font-size:11px;color:#B42318;">wrote again ' + ago(now - r.lastAskAt) + ' ago</span>' : ''}`;

  // 1. The last 3 days' escalations — every one, answered or not, with when it was escalated.
  let todayHtml;
  if (!e.today.length) todayHtml = `<p style="font-family:sans-serif;color:#888;font-size:13px;">No escalations in the last 3 days.</p>`;
  else {
    const body = e.today.map(r => `<tr>
        <td style="${TD}vertical-align:top;">${who(r)}</td>
        <td style="${TD}vertical-align:top;white-space:nowrap;">${fmtDateTime(r.at)}</td>
        <td style="${TD}vertical-align:top;">${state(r)}</td>
        <td style="${TD}vertical-align:top;font-size:12px;">${about(r)}</td></tr>`).join('');
    todayHtml = tableWrap(['Customer', 'Escalated on', 'Status', 'Why · what is pending'], body);
  }

  // 2. Older escalations nobody has answered yet — the backlog, longest waiting first.
  let olderHtml = '';
  if (e.olderWaiting.length) {
    const agingRow = Object.entries(e.aging).filter(([, n]) => n).map(([k, n]) => `<b>${n}</b> ${escapeHtml(k)}`).join(' · ');
    const { shown, extraLine } = rowsWithCap(e.olderWaiting, 25);
    const body = shown.map(r => `<tr>
        <td style="${TD}vertical-align:top;">${who(r)}</td>
        <td style="${TD}vertical-align:top;white-space:nowrap;">${r.at ? '<b>' + ago(now - r.at) + '</b><br><span style="color:#888;font-size:11px;">since ' + fmtDateTime(r.at) + '</span>' : '<span style="color:#888;">before 13 Sep</span>'}${r.stillWriting ? '<br><span style="color:#B42318;font-size:11px;">wrote ' + ago(now - r.lastAskAt) + ' ago</span>' : ''}</td>
        <td style="${TD}vertical-align:top;font-size:12px;">${about(r)}</td></tr>`).join('');
    olderHtml = sub(`Older than 3 days, still not answered — ${e.olderWaiting.length}`, '#B42318')
      + `<div style="font-family:sans-serif;font-size:12px;color:#444;margin:0 0 6px;">${agingRow}</div>`
      + tableWrap(['Customer', 'Waiting', 'Why · what is pending'], body) + extraLine;
  }

  // 3. Earlier escalations that have had a reply (cleared today, or replied but still flagged).
  let answeredHtml = '';
  if (e.olderAnswered.length) {
    const { shown, extraLine } = rowsWithCap(e.olderAnswered, 15);
    const body = shown.map(r => `<tr>
        <td style="${TD}"><b>${escapeHtml(r.lead.name || 'Lead')}</b></td>
        <td style="${TD}">${escapeHtml(r.by ? r.by.split('@')[0] : '—')}</td>
        <td style="${TD}">${r.replyAt ? fmtDateTime(r.replyAt) : '—'}</td>
        <td style="${TD}font-size:12px;">${r.status === 'cleared' ? '<span style="color:#067647;">Cleared today</span>' : '<span style="color:#A85C00;">Replied, still escalated in TailorTalk — clear it there</span>'}</td></tr>`).join('');
    answeredHtml = sub(`Older than 3 days, answered — ${e.olderAnswered.length}`, '#067647')
      + tableWrap(['Customer', 'Replied by', 'When', 'Status'], body) + extraLine;
  }
  // 4. Probably stale: open since before tracking, the team did talk to them — clean-up, not work.
  let staleHtml = '';
  if (e.stale.length) {
    const names = e.stale.slice(0, 12).map(r => `${escapeHtml(r.lead.name || 'Lead')} <span style="color:#999;">(last reply ${r.replyAt ? fmtDate(r.replyAt) : '—'})</span>`).join(', ');
    staleHtml = `<p style="font-family:sans-serif;font-size:12px;color:#666;margin:14px 0 0;line-height:1.5;"><b>${e.stale.length} probably stale:</b>
      escalated before 13 Sep and the team has replied to them since, but before TailorTalk cleared escalations on a reply — so they still show escalated.
      Clear them in TailorTalk: ${names}${e.stale.length > 12 ? ` and ${e.stale.length - 12} more` : ''}.</p>`;
  }
  const foot = e.vendorsOpen ? `<p style="font-family:sans-serif;font-size:11px;color:#999;margin-top:6px;">Vendor and collaboration chats are left out (${e.vendorsOpen} escalated).</p>` : '';
  return sectionWrap('🚨 Escalations — last 3 days', null, what + tiles + todayHtml + olderHtml + answeredHtml + staleHtml + foot);
}

export async function renderDashboardEmailHtml(m, dateStr, esc) {
  const wonHeadline = m.movedToWonToday.count
    ? `${m.movedToWonToday.count}${m.movedToWonToday.totalValueINR > 0 ? ` · ${formatINR(m.movedToWonToday.totalValueINR)} combined value` : ''}`
    : null;
  const body = [
    esc ? escalationSection(esc, Date.now()) : '',
    statCardsHtml(m),
    actionLogSection(m),
    newLeadsTodaySection(m),
    groupTodaySection(m.propertyPerformance, '📍', 'Property-wise Leads Today', 'Property'),
    groupTodaySection(m.enquiryPerformance, '🏷️', 'Other Enquiries Today (by type)', 'Enquiry type'),
    siteVisitsTodaySection(m),
    leadTableSection('Overdue Follow-ups', '⚠️', m.overdueFollowUps, 15, [{ label: 'Was due', value: l => fmtDateTime(l.followUpAt) }]),
    leadTableSection("Tomorrow's Follow-up Plan", '🌤️', m.followUpsDueTomorrow, 25, [{ label: 'Time', value: l => fmtTime(l.followUpAt) }]),
    sectionWrap('🎉 Moved to Closed Today', wonHeadline, m.movedToWonToday.count ? tableWrap(['Name', 'Phone', 'Budget'], m.movedToWonToday.leads.map(l => `<tr><td style="${TD}font-weight:600;">${escapeHtml(l.name || 'Lead')}</td><td style="${TD}">${escapeHtml(l.phone || '—')}</td><td style="${TD}">${escapeHtml(l.budget || '—')}</td></tr>`).join('')) : emptyLine()),
    await movedToDeadSection(m),
    leadTableSection('Cold Leads (7+ days silent)', '🧊', m.coldLeads, 10, []),
    kpiSection(m),
    journeySection(m),
    mixSection(m),
    groupPerformanceSection(m.propertyPerformance, '🏘️', 'Property Performance', 'Property', 'Property Enquiry leads only, grouped by property. All-time, spam excluded.'),
    groupPerformanceSection(m.enquiryPerformance, '📁', 'Enquiry Type Performance', 'Enquiry type', 'Everything that is not a Property Enquiry, grouped by type. All-time, spam excluded.'),
    pipelineSection(m),
    ownerSection(m),
    hygieneSection(m)
  ].join('');

  return `<div style="max-width:600px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;color:#1C1917;">
    <div style="text-align:center;padding:10px 0 20px;border-bottom:3px solid #FE8D00;margin-bottom:18px;">
      <div style="font-size:22px;font-weight:700;letter-spacing:-.03em;color:#0A0A0A;">3 PIN Realty</div>
      <div style="font-size:11px;color:#A85C00;font-weight:700;text-transform:uppercase;letter-spacing:.12em;margin-top:4px;">EOD Dashboard Summary — ${dateStr}</div>
    </div>
    ${body}
    <p style="text-align:center;color:#aaa;font-size:11px;margin-top:24px;">Generated 21:30 IST, ${dateStr} • Data window 00:00–23:59 IST • 3 PIN Realty CRM</p>
  </div>`;
}

function renderDashboardEmailText(m, dateStr, esc) {
  const lines = [`3 PIN Realty — EOD Dashboard Summary — ${dateStr}`, ''];
  if (esc) {
    const now = Date.now();
    lines.push(`ESCALATIONS, LAST 3 DAYS: ${esc.today.length} · answered ${esc.todayAnswered} · not answered ${esc.todayWaiting}`);
    lines.push('(Escalation = TailorTalk handed the chat to a person; it clears once someone replies in TailorTalk.)');
    esc.today.forEach(r => lines.push(`- ${r.answered ? 'ANSWERED' : 'NOT ANSWERED'} ${fmtDateTime(r.at)}: ${r.lead.name || 'Lead'} — ${r.lead.phone || '—'}${r.answered ? ' by ' + (r.by ? r.by.split('@')[0] : 'team') : ''}${r.why ? ' — "' + truncate(r.why, 90) + '"' : ''}`));
    if (esc.olderWaiting.length) {
      lines.push(`OLDER THAN 3 DAYS, STILL NOT ANSWERED (${esc.olderWaiting.length}):`);
      esc.olderWaiting.slice(0, 25).forEach(r => lines.push(`- ${r.at ? ago(now - r.at) : 'before 13 Sep'}: ${r.lead.name || 'Lead'} — ${r.lead.phone || '—'}${r.why ? ' — "' + truncate(r.why, 90) + '"' : ''}`));
    }
    lines.push('');
  }
  lines.push(`New today: ${m.newLeadsToday.total} | Followed up: ${m.followedUpToday.count} | Overdue: ${m.overdueFollowUps.count} | Cold: ${m.coldLeads.count}`);
  lines.push(`Pending site visit: ${m.siteVisitPending.total} | Site visits done today: ${m.siteVisitDone.movedTodayCount} | Needs action: ${m.needsAction.total} | Closed today: ${m.movedToWonToday.count}`);
  lines.push('');
  const k = m.kpis;
  lines.push(`Total leads (excl. spam): ${k.nonSpamTotal} | Open pipeline: ${formatINR(k.openPipelineValueINR)} | Conversion: ${k.conversionPct === null ? '—' : k.conversionPct + '%'}`);
  lines.push('');
  if (m.propertyPerformance.newTodayRows.length) {
    lines.push(`PROPERTY-WISE LEADS TODAY (${m.propertyPerformance.newTodayTotal}):`);
    m.propertyPerformance.newTodayRows.forEach(r => lines.push(`- ${r.label}: ${r.newToday} new (${r.total} total)`));
    lines.push('');
  }
  if (m.siteVisitDone.movedTodayCount) {
    lines.push(`SITE VISITS DONE TODAY (${m.siteVisitDone.movedTodayCount}):`);
    m.siteVisitDone.movedTodayLeads.slice(0, 25).forEach(l => lines.push(`- ${l.name || 'Lead'} — ${l.phone || '—'} — ${l.propertyInterest || '—'}`));
    lines.push('');
  }
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
  const esc = escalationMetrics(leadsArr, Date.now());
  const dateStr = fmtDate(Date.now());
  const subjectPrefix = opts.resend ? '[RE-SENT] ' : '';
  const subject = `${subjectPrefix}3 PIN Realty — EOD Dashboard Summary — ${dateStr}`;
  const html = await renderDashboardEmailHtml(metrics, dateStr, esc);
  const text = renderDashboardEmailText(metrics, dateStr, esc);

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
