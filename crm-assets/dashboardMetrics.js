// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD METRICS ENGINE — single source of truth.
//
// Pure, dependency-free, side-effect-free. Never reads Firebase itself —
// callers pass in the leads array (one bulk read) and the pipeline stages
// array (one small doc read). Used UNMODIFIED by both the Dashboard tab
// (loaded as an ES module in crm.html) and the Dashboard Summary Email
// (imported directly by api/dashboard-summary.js) so the two can never
// drift apart — it's literally the same file, not a re-implementation.
//
// Never mutates the leads/stages arrays or their elements.
// ═══════════════════════════════════════════════════════════════════════

const DAY_MS = 86400000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const COLD_DAYS = 7;
const ACTION_LINE_MAX = 90;

// Stage classification is by NAME (trimmed/lowercased) — stages are fully
// user-editable via "Manage Pipeline Stages", so nothing here is an id.
// Anything not matched is "open" (neither won nor dead) — no broader
// "active pipeline" concept is computed by design (kept intentionally lean).
const WON_STAGE_NAMES = ['closed'];
const DEAD_STAGE_NAMES = ['not interested', 'spam'];
// Spam is a strict subset of "dead": the property-wise totals below exclude
// ONLY spam (junk that was never a real enquiry), while genuinely lost leads
// still count towards a property's demand.
const SPAM_STAGE_NAMES = ['spam'];
const SITE_VISIT_DONE_NAME = 'site visit done';
const SITE_VISIT_PENDING_NAME = 'site visit';
const MISSED_CALLS_NAME = 'missed calls';
// Days of daily new-lead history returned for the trend chart. The existing
// 7-day average is derived from the same buckets, so the two can never drift.
const TREND_DAYS = 14;

function normName(s) { return String(s || '').trim().toLowerCase(); }

function classifyStage(stageName) {
  const n = normName(stageName);
  if (WON_STAGE_NAMES.includes(n)) return 'won';
  if (DEAD_STAGE_NAMES.includes(n)) return 'dead';
  return 'open';
}

// Midnight-to-midnight IST window containing `referenceDate` (epoch ms or
// Date; defaults to now), expressed as true UTC epoch ms — matches the
// fixed-offset technique already used in api/followup-digest.js. IST has
// no DST so a fixed +5:30 offset is safe.
function istDayBounds(referenceDate) {
  const ts = referenceDate instanceof Date ? referenceDate.getTime() : (referenceDate || Date.now());
  const startOfDay = Math.floor((ts + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return { start: startOfDay, end: startOfDay + DAY_MS - 1 };
}

function istDateLabel(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function normPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}

function ownerLabel(email) {
  if (!email) return 'Unassigned';
  const at = String(email).indexOf('@');
  return at > 0 ? email.slice(0, at) : String(email);
}

function truncate(s, max) {
  if (!s) return '';
  const t = String(s).trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// ---- Budget parsing ----------------------------------------------------
// Free text like "3 to 4 Cr", "4.90 Crores", "1.5 Cr", "85 L", "50 Lakhs".
// Returns a numeric INR value (average of a range) or null if unparseable —
// never coerced to 0, so unparseable budgets are excluded from sums rather
// than silently zeroing them out.
export function parseBudgetToINR(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  let unit = null;
  // Real-world budgets are typed by hand with no consistent spacing/spelling
  // ("4crs", "6cre", "8.5crs", "2 cr", "4 to 5 Crores") — match the unit
  // wherever it appears rather than requiring a leading word boundary, since
  // a digit immediately followed by a letter has no \b between them.
  if (/crore|cr[es]?(?![a-z])/.test(s)) unit = 1e7;
  else if (/lakh|lac|l(?![a-z])/.test(s)) unit = 1e5;
  if (!unit) return null;
  const nums = s.match(/\d+(\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const values = nums.map(Number).filter(n => !Number.isNaN(n));
  if (!values.length) return null;
  return (values.reduce((a, b) => a + b, 0) / values.length) * unit;
}

export function formatINR(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, '')} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

const CHANNEL_LABELS = { whatsapp: 'WhatsApp', instagram: 'Instagram', call: 'Direct Call', website: 'Website' };
const CHANNEL_ORDER = ['whatsapp', 'instagram', 'call', 'website'];

// A short, human line describing whatever the lead's last recorded action
// was. Derived entirely from denormalized fields already on the lead doc
// (lastActionType/lastNote) — never re-fetches notes, never calls AI.
function actionLineFor(l, stageNameOf) {
  const type = l.lastActionType;
  if ((type === 'note' || type === 'followed-up') && l.lastNote && l.lastNote.text) {
    return truncate(l.lastNote.text, ACTION_LINE_MAX);
  }
  if (type === 'stage') return truncate(`Stage changed to ${stageNameOf(l.stageId)}`, ACTION_LINE_MAX);
  if (type === 'followup-removed') return 'Follow-up removed';
  if (type === 'details-sent') return `Sent details: ${l.detailsSent ? 'Yes' : 'No'}`;
  if (type === 'field') return 'Lead details edited';
  if (type === 'created') return 'Lead created';
  if (l.lastNote && l.lastNote.text) return truncate(l.lastNote.text, ACTION_LINE_MAX);
  return '—';
}

export function computeDashboardMetrics(leads, stages, referenceDate, opts) {
  leads = Array.isArray(leads) ? leads : [];
  stages = Array.isArray(stages) ? stages : [];
  opts = opts || {};

  const { start: dayStart, end: dayEnd } = istDayBounds(referenceDate);
  const tomorrowStart = dayStart + DAY_MS;
  const tomorrowEnd = dayEnd + DAY_MS;
  const monthStartLabel = istDateLabel(dayStart).slice(0, 7); // YYYY-MM
  const now = Date.now();
  const isToday = (ts) => typeof ts === 'number' && ts >= dayStart && ts <= dayEnd;

  const stageById = new Map(stages.map(s => [s.id, s]));
  const stageOrder = new Map(stages.map((s, i) => [s.id, i]));
  const stageNameOf = (stageId) => { const s = stageById.get(stageId); return s ? s.name : (stageId || 'Unknown'); };
  const kindOf = (stageId) => { const s = stageById.get(stageId); return s ? classifyStage(s.name) : 'open'; };

  const stageCounts = new Map(); // stageId -> count
  const ownerMap = new Map();    // ownerLabel -> stats
  const channelCounts = new Map();
  const enquiryTypeCountsNewToday = new Map();
  const enquiryTypeCountsAll = new Map();
  const sourceCountsNewToday = new Map();
  const phoneGroups = new Map(); // normalized phone -> leads[]
  const propertyMap = new Map(); // normalized property -> stats
  // Daily new-lead counts, oldest first; the last slot is the reference day.
  const dailyNewBuckets = new Array(TREND_DAYS).fill(0);

  const followedUpToday = [];
  const overdueFollowUps = [];
  const actionTodayLeads = [];
  const stageChangesToday = [];
  let stageChangesForward = 0;
  const siteVisitDoneLeads = [];
  const siteVisitDoneMovedToday = [];
  const siteVisitPendingLeads = [];
  const siteVisitPendingMovedToday = [];
  const missedCallsLeads = [];
  const movedToWonToday = [];
  const movedToDeadToday = [];
  const newLeadsNoActionToday = [];
  const followUpsDueTomorrow = [];
  const coldLeads = [];
  const newLeadsToday = [];
  let monthToDateTotal = 0;

  const missingPhone = [];
  const missingBudget = [];
  const noFollowUpDate = [];
  const noAiSummary = [];

  function ensureOwner(owner) {
    if (!ownerMap.has(owner)) {
      ownerMap.set(owner, { owner, touchedToday: 0, followedUpToday: 0, newAssigned: 0, openLeads: 0, overdueCount: 0 });
    }
    return ownerMap.get(owner);
  }

  // Properties are free text ("3BHK in Adyar"), so they're grouped
  // case-insensitively on the trimmed string and displayed using the first
  // spelling seen. Nothing is normalized away beyond case/whitespace — two
  // genuinely different descriptions stay two rows.
  function ensureProperty(l) {
    const raw = String(l.propertyInterest || '').trim();
    const key = normName(raw) || '__unspecified__';
    if (!propertyMap.has(key)) {
      propertyMap.set(key, {
        key, property: raw || 'Unspecified',
        total: 0, newToday: 0, open: 0, won: 0, lost: 0, spam: 0,
        siteVisitDone: 0, siteVisitDoneToday: 0, siteVisitPending: 0,
        detailsSent: 0, overdue: 0, pipelineValueINR: 0, wonValueINR: 0,
        lastActivityAt: 0
      });
    }
    return propertyMap.get(key);
  }

  let spamCount = 0;
  let openLeadCount = 0;
  let wonLeadCount = 0;
  let deadLeadCount = 0;
  let detailsSentOpenCount = 0;
  let openPipelineValueINR = 0;
  let wonValueINR = 0;

  for (const l of leads) {
    const kind = kindOf(l.stageId);
    const isOpen = kind === 'open';
    const isSpam = SPAM_STAGE_NAMES.includes(normName(stageNameOf(l.stageId)));

    stageCounts.set(l.stageId, (stageCounts.get(l.stageId) || 0) + 1);
    enquiryTypeCountsAll.set(l.enquiryType || 'Unspecified', (enquiryTypeCountsAll.get(l.enquiryType || 'Unspecified') || 0) + 1);

    const updOwner = ensureOwner(ownerLabel(l.updatedBy));
    if (isOpen) updOwner.openLeads++;

    const np = normPhone(l.phone);
    if (np) {
      if (!phoneGroups.has(np)) phoneGroups.set(np, []);
      phoneGroups.get(np).push(l);
    }

    if (!l.phone) missingPhone.push(l);
    if (!l.budget) missingBudget.push(l);
    if (!l.aiSummary) noAiSummary.push(l);
    if (isOpen && !l.followUpAt) noFollowUpDate.push(l);

    if (isOpen && l.followUpAt && l.followUpAt <= now) {
      overdueFollowUps.push(l);
      updOwner.overdueCount++;
    }
    if (l.followUpAt && l.followUpAt >= tomorrowStart && l.followUpAt <= tomorrowEnd) {
      followUpsDueTomorrow.push(l);
    }

    const lastTouch = l.updatedAt || l.createdAt || 0;
    if (isOpen && lastTouch && (now - lastTouch) >= COLD_DAYS * DAY_MS) {
      coldLeads.push(l);
    }

    if (isToday(l.updatedAt)) {
      actionTodayLeads.push(l);
      updOwner.touchedToday++;
      if (l.lastActionType === 'followed-up') {
        followedUpToday.push(l);
        updOwner.followedUpToday++;
      }
    } else if (l.lastActionType === 'followed-up' && l.lastNote && isToday(l.lastNote.createdAt)) {
      // Legacy safety net for leads saved before lastActionType existed.
      followedUpToday.push(l);
      updOwner.followedUpToday++;
    }

    if (isToday(l.stageChangedAt)) {
      stageChangesToday.push(l);
      const fromIdx = stageOrder.get(l.prevStageId);
      const toIdx = stageOrder.get(l.stageId);
      if (fromIdx !== undefined && toIdx !== undefined && toIdx > fromIdx) stageChangesForward++;
      if (kind === 'won') movedToWonToday.push(l);
      if (kind === 'dead') movedToDeadToday.push(l);
    }

    const sName = normName(stageNameOf(l.stageId));
    if (sName === SITE_VISIT_DONE_NAME) {
      siteVisitDoneLeads.push(l);
      if (isToday(l.stageChangedAt)) siteVisitDoneMovedToday.push(l);
    }
    if (sName === SITE_VISIT_PENDING_NAME) {
      siteVisitPendingLeads.push(l);
      if (isToday(l.stageChangedAt)) siteVisitPendingMovedToday.push(l);
    }
    if (sName === MISSED_CALLS_NAME) missedCallsLeads.push(l);

    // ── Portfolio KPIs + per-property rollup ──
    const budgetINR = parseBudgetToINR(l.budget);
    const countsForValue = budgetINR !== null && l.enquiryType !== 'Rental Enquiry';
    if (isSpam) spamCount++;
    if (isOpen) {
      openLeadCount++;
      if (l.detailsSent === true) detailsSentOpenCount++;
      if (countsForValue) openPipelineValueINR += budgetINR;
    }
    if (kind === 'won') { wonLeadCount++; if (countsForValue) wonValueINR += budgetINR; }
    if (kind === 'dead') deadLeadCount++;

    const p = ensureProperty(l);
    if (isSpam) {
      p.spam++;
    } else {
      // "Total leads for that property" deliberately excludes spam — every
      // other per-property number below is a subset of this same total.
      p.total++;
      if (isOpen) {
        p.open++;
        if (countsForValue) p.pipelineValueINR += budgetINR;
        if (l.followUpAt && l.followUpAt <= now) p.overdue++;
      }
      if (kind === 'won') { p.won++; if (countsForValue) p.wonValueINR += budgetINR; }
      if (kind === 'dead') p.lost++;
      if (sName === SITE_VISIT_DONE_NAME) {
        p.siteVisitDone++;
        if (isToday(l.stageChangedAt)) p.siteVisitDoneToday++;
      }
      if (sName === SITE_VISIT_PENDING_NAME) p.siteVisitPending++;
      if (l.detailsSent === true) p.detailsSent++;
      if (isToday(l.createdAt)) p.newToday++;
      const touched = l.updatedAt || l.createdAt || 0;
      if (touched > p.lastActivityAt) p.lastActivityAt = touched;
    }

    if (isToday(l.createdAt)) {
      newLeadsToday.push(l);
      const chan = CHANNEL_LABELS[l.channel] ? l.channel : '__other__';
      channelCounts.set(chan, (channelCounts.get(chan) || 0) + 1);
      enquiryTypeCountsNewToday.set(l.enquiryType || 'Unspecified', (enquiryTypeCountsNewToday.get(l.enquiryType || 'Unspecified') || 0) + 1);
      sourceCountsNewToday.set(l.source || 'Unspecified', (sourceCountsNewToday.get(l.source || 'Unspecified') || 0) + 1);
      const creatorOwner = ensureOwner(ownerLabel(l.createdBy));
      creatorOwner.newAssigned++;
      const untouched = l.lastActionType ? l.lastActionType === 'created' : ((l.updatedAt || 0) <= (l.createdAt || 0));
      if (untouched) newLeadsNoActionToday.push(l);
    }
    // Daily buckets for the trend chart. dayStart is an IST midnight, so a
    // whole-day offset from it lands cleanly on IST calendar days; slot
    // TREND_DAYS-1 is the reference day, and anything after it (possible when
    // viewing a past date) falls outside the window and is dropped.
    if (typeof l.createdAt === 'number') {
      const idx = TREND_DAYS - 1 + Math.floor((l.createdAt - dayStart) / DAY_MS);
      if (idx >= 0 && idx < TREND_DAYS) dailyNewBuckets[idx]++;
    }
    if (typeof l.createdAt === 'number' && istDateLabel(l.createdAt).slice(0, 7) === monthStartLabel && l.createdAt <= dayEnd) {
      monthToDateTotal++;
    }
  }

  // The 7 days strictly BEFORE the reference day — the last slot is today.
  const trailing7Buckets = dailyNewBuckets.slice(TREND_DAYS - 8, TREND_DAYS - 1);
  const trailing7DayAvg = trailing7Buckets.reduce((a, b) => a + b, 0) / 7;
  let newLeadsDeltaPct = null;
  if (trailing7DayAvg > 0) newLeadsDeltaPct = ((newLeadsToday.length - trailing7DayAvg) / trailing7DayAvg) * 100;

  const dailyTrend = dailyNewBuckets.map((count, i) => {
    const ts = dayStart - (TREND_DAYS - 1 - i) * DAY_MS;
    return {
      date: istDateLabel(ts),
      label: new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }),
      weekday: new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Asia/Kolkata' }),
      count
    };
  });

  const byChannel = CHANNEL_ORDER.map(key => ({ key, label: CHANNEL_LABELS[key], count: channelCounts.get(key) || 0 }));
  const otherChannelCount = channelCounts.get('__other__') || 0;
  if (otherChannelCount > 0) byChannel.push({ key: 'other', label: 'Other', count: otherChannelCount });

  function topNPlusOther(map, n) {
    const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, n).map(([label, count]) => ({ label, count }));
    const rest = entries.slice(n).reduce((sum, [, c]) => sum + c, 0);
    if (rest > 0) top.push({ label: 'Other', count: rest });
    return top;
  }

  const totalLeads = leads.length;
  const pipelineByStage = stages.map(s => ({
    id: s.id, name: s.name, color: s.color || '#999',
    count: stageCounts.get(s.id) || 0,
    pct: totalLeads ? Math.round(((stageCounts.get(s.id) || 0) / totalLeads) * 1000) / 10 : 0
  }));
  // Stage ids present on leads but no longer in the current stage config
  // (renamed/deleted) — never dropped silently, bucketed as "Other".
  const knownStageIds = new Set(stages.map(s => s.id));
  const orphanCount = leads.reduce((sum, l) => sum + (knownStageIds.has(l.stageId) ? 0 : 1), 0);
  if (orphanCount > 0) pipelineByStage.push({ id: '__other__', name: 'Other (unrecognized stage)', color: '#999', count: orphanCount, pct: totalLeads ? Math.round((orphanCount / totalLeads) * 1000) / 10 : 0 });

  const ownerActivity = Array.from(ownerMap.values())
    .map(o => ({ ...o, flagged: o.openLeads > 0 && o.touchedToday === 0 }))
    .sort((a, b) => a.owner.localeCompare(b.owner));

  const duplicatePhoneGroups = Array.from(phoneGroups.entries())
    .filter(([, arr]) => arr.length > 1)
    .map(([phone, arr]) => ({ phone, leads: arr }));

  const propertyRows = Array.from(propertyMap.values())
    .map(p => ({
      ...p,
      // Of the leads this property ever attracted (spam excluded), how many
      // reached Closed. Zero-total rows (spam-only) report null, never 0%,
      // so "no data" is never mistaken for "0% conversion".
      conversionPct: p.total ? Math.round((p.won / p.total) * 1000) / 10 : null,
      siteVisitPct: p.total ? Math.round((p.siteVisitDone / p.total) * 1000) / 10 : null
    }))
    .filter(p => p.total > 0)
    .sort((a, b) => b.total - a.total || a.property.localeCompare(b.property));

  const propertyNewTodayRows = propertyRows
    .filter(p => p.newToday > 0)
    .slice()
    .sort((a, b) => b.newToday - a.newToday || a.property.localeCompare(b.property));

  const nonSpamTotal = totalLeads - spamCount;
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

  return {
    meta: {
      generatedAt: now,
      dateLabel: istDateLabel(dayStart),
      referenceDayStart: dayStart,
      referenceDayEnd: dayEnd,
      totalLeadsScanned: totalLeads
    },
    followedUpToday: { count: followedUpToday.length, leads: followedUpToday },
    overdueFollowUps: { count: overdueFollowUps.length, leads: overdueFollowUps.slice().sort((a, b) => a.followUpAt - b.followUpAt) },
    actionToday: { count: actionTodayLeads.length, leads: actionTodayLeads },
    stageChangesToday: { count: stageChangesToday.length, forwardCount: stageChangesForward, leads: stageChangesToday },
    siteVisitDone: { total: siteVisitDoneLeads.length, leads: siteVisitDoneLeads, movedTodayCount: siteVisitDoneMovedToday.length, movedTodayLeads: siteVisitDoneMovedToday },
    siteVisitPending: { total: siteVisitPendingLeads.length, leads: siteVisitPendingLeads, movedTodayCount: siteVisitPendingMovedToday.length, movedTodayLeads: siteVisitPendingMovedToday },
    missedCalls: { total: missedCallsLeads.length, leads: missedCallsLeads },
    movedToWonToday: {
      count: movedToWonToday.length, leads: movedToWonToday,
      totalValueINR: movedToWonToday.reduce((sum, l) => {
        if (l.enquiryType === 'Rental Enquiry') return sum; // never mix rental with sale value
        const v = parseBudgetToINR(l.budget);
        return v === null ? sum : sum + v;
      }, 0)
    },
    movedToDeadToday: { count: movedToDeadToday.length, leads: movedToDeadToday },
    newLeadsNoActionToday: { count: newLeadsNoActionToday.length, leads: newLeadsNoActionToday },
    followUpsDueTomorrow: { count: followUpsDueTomorrow.length, leads: followUpsDueTomorrow.slice().sort((a, b) => a.followUpAt - b.followUpAt) },
    coldLeads: { count: coldLeads.length, leads: coldLeads.slice().sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0)) },

    actionLog: {
      count: actionTodayLeads.length,
      rows: actionTodayLeads.map(l => ({
        lead: l,
        stageFrom: isToday(l.stageChangedAt) && l.prevStageId ? stageNameOf(l.prevStageId) : null,
        stageTo: stageNameOf(l.stageId),
        line: actionLineFor(l, stageNameOf)
      }))
    },

    newLeadsToday: {
      total: newLeadsToday.length,
      leads: newLeadsToday,
      byChannel,
      byEnquiryType: Array.from(enquiryTypeCountsNewToday.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      bySource: topNPlusOther(sourceCountsNewToday, 5),
      trailing7DayAvg: Math.round(trailing7DayAvg * 10) / 10,
      deltaPct: newLeadsDeltaPct === null ? null : Math.round(newLeadsDeltaPct),
      monthToDateTotal,
      // Oldest → newest, last entry = the reference day. Drives the trend chart.
      dailyTrend
    },

    // Property-wise view of the book: what came in today, and the standing
    // demand + conversion each property has accumulated (spam excluded).
    propertyPerformance: {
      totalProperties: propertyRows.length,
      newTodayTotal: propertyNewTodayRows.reduce((s, p) => s + p.newToday, 0),
      newTodayRows: propertyNewTodayRows,
      rows: propertyRows
    },

    kpis: {
      totalLeads,
      spamCount,
      nonSpamTotal,
      openLeads: openLeadCount,
      wonLeads: wonLeadCount,
      deadLeads: deadLeadCount,
      conversionPct: pct(wonLeadCount, nonSpamTotal),
      siteVisitConversionPct: pct(siteVisitDoneLeads.length, nonSpamTotal),
      detailsSentPct: pct(detailsSentOpenCount, openLeadCount),
      overduePct: pct(overdueFollowUps.length, openLeadCount),
      coldPct: pct(coldLeads.length, openLeadCount),
      openPipelineValueINR,
      wonValueINR,
      avgNewLeadsPerDay: Math.round((dailyNewBuckets.reduce((a, b) => a + b, 0) / TREND_DAYS) * 10) / 10,
      newLeadsMTD: monthToDateTotal
    },

    // Trimmed per product decision: simple counts by enquiry type, no detail
    // tables/AI-summary rows/locality analysis for this pass.
    enquiryTypeCounts: Array.from(enquiryTypeCountsAll.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),

    pipelineByStage: { stages: pipelineByStage, totalLeads },

    ownerActivity: { owners: ownerActivity },

    dataHygiene: {
      missingPhone: { count: missingPhone.length, leads: missingPhone },
      missingBudget: { count: missingBudget.length, leads: missingBudget },
      noFollowUpDate: { count: noFollowUpDate.length, leads: noFollowUpDate },
      noAiSummary: { count: noAiSummary.length, leads: noAiSummary },
      duplicatePhones: { count: duplicatePhoneGroups.length, groups: duplicatePhoneGroups }
    }
  };
}
