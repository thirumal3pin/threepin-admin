// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD TAB — renders window.computeDashboardMetrics() output.
//
// Classic script, loaded after crm-assets/app.js, sharing its global scope
// (leads, stages, escapeHtml, timeAgo, channelLabel, waHref, stageById).
// Never fetches leads itself — reuses whatever's already in memory. Only
// Firebase-free computation happens here; the sole network call this file
// ever makes is the lazy, on-demand AI "why did they go cold" lookup.
// ═══════════════════════════════════════════════════════════════════════

let dashRefDate = new Date();      // IST calendar day currently being viewed
let dashMetrics = null;
let dashBuilders = {};             // sectionKey -> () => html string, built lazily on first expand
let dashDeadReasons = {};          // leadId -> reason string (AI, fetched on demand)
let dashDeadReasonsState = 'idle'; // idle | loading | done

function dashDateInputValue(d){
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function dashFmtTime(ts){
  return ts ? new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata' }) : '—';
}
function dashFmtDateTime(ts){
  return ts ? new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata' }) : '—';
}

function dashLeadRow(l, opts){
  opts = opts || {};
  const stage = stageById(l.stageId);
  const wa = waHref(l.phone);
  const rightBits = [];
  if (opts.right) rightBits.push(opts.right);
  return `<div class="dash-row">
    <div class="dash-row-main">
      <div class="dash-row-name">
        ${escapeHtml(l.name || 'Lead')}
        ${stage ? `<span class="stage-pill sm" style="background:${stage.color}22;color:${stage.color}">${escapeHtml(stage.name)}</span>` : ''}
      </div>
      <div class="dash-row-meta">
        ${l.phone ? `<a href="tel:${escapeHtml(l.phone)}" onclick="event.stopPropagation()">📞 ${escapeHtml(l.phone)}</a>` : ''}
        ${wa ? `<a href="${wa}" target="_blank" rel="noopener" onclick="event.stopPropagation()">💬 WhatsApp</a>` : ''}
        ${l.propertyInterest ? `<span>🏠 ${escapeHtml(l.propertyInterest)}</span>` : ''}
        ${l.enquiryType ? `<span>🏷️ ${escapeHtml(l.enquiryType)}</span>` : ''}
      </div>
      ${opts.sub ? `<div class="dash-row-sub">${opts.sub}</div>` : ''}
    </div>
    ${rightBits.length ? `<div class="dash-row-side">${rightBits.join('')}</div>` : ''}
  </div>`;
}

function dashEmpty(label){
  return `<div class="dash-empty">0 — ${escapeHtml(label || 'nothing to report')}</div>`;
}

function dashSection(key, icon, title, count, builderFn){
  dashBuilders[key] = builderFn;
  return `<div class="dash-sec">
    <button class="dash-sec-hdr" onclick="toggleDashSection('${key}')">
      <span class="dash-sec-title">${icon} ${escapeHtml(title)}</span>
      <span class="dash-sec-count">${count}</span>
      <span class="dash-chevron" id="dashChev_${key}">⌄</span>
    </button>
    <div class="dash-sec-body" id="dashBody_${key}" style="display:none"></div>
  </div>`;
}

function toggleDashSection(key){
  const body = document.getElementById('dashBody_'+key);
  const chev = document.getElementById('dashChev_'+key);
  if(!body) return;
  const opening = body.style.display === 'none';
  if(opening){
    if(!body.dataset.built){
      const fn = dashBuilders[key];
      body.innerHTML = fn ? fn() : '';
      body.dataset.built = '1';
    }
    body.style.display = '';
    if(chev) chev.textContent = '︿';
  } else {
    body.style.display = 'none';
    if(chev) chev.textContent = '⌄';
  }
}

function dashStatCard(label, value, key){
  return `<button class="dash-stat" onclick="dashJumpTo('${key}')">
    <div class="dash-stat-val">${value}</div>
    <div class="dash-stat-label">${escapeHtml(label)}</div>
  </button>`;
}
function dashJumpTo(key){
  const body = document.getElementById('dashBody_'+key);
  if(!body) return;
  if(body.style.display === 'none') toggleDashSection(key);
  body.scrollIntoView({ behavior:'smooth', block:'center' });
}

// ── Section body builders (called lazily, once per expand) ──────────────

function buildActionLogBody(){
  const rows = dashMetrics.actionLog.rows;
  if(!rows.length) return dashEmpty();
  return rows.map(r => dashLeadRow(r.lead, {
    sub: `${r.stageFrom ? `${escapeHtml(r.stageFrom)} → ${escapeHtml(r.stageTo)} · ` : ''}“${escapeHtml(r.line)}”`,
    right: `<span class="dash-owner">${escapeHtml(r.lead.updatedBy ? r.lead.updatedBy.split('@')[0] : '—')}</span>`
  })).join('');
}

function buildLeadListBody(leadsArr, opts){
  if(!leadsArr.length) return dashEmpty();
  return leadsArr.map(l => dashLeadRow(l, opts ? opts(l) : {})).join('');
}

function buildOverdueBody(){
  const leadsArr = dashMetrics.overdueFollowUps.leads;
  if(!leadsArr.length) return dashEmpty();
  const now = Date.now();
  return leadsArr.map(l => {
    const daysOverdue = Math.floor((now - l.followUpAt) / 86400000);
    const color = daysOverdue >= 7 ? '#c0392b' : '#e67e22';
    return dashLeadRow(l, {
      sub: `Was due ${dashFmtDateTime(l.followUpAt)}`,
      right: `<span class="dash-badge" style="background:${color}22;color:${color}">${daysOverdue}d overdue</span>`
    });
  }).join('');
}

function buildTomorrowBody(){
  const leadsArr = dashMetrics.followUpsDueTomorrow.leads;
  if(!leadsArr.length) return dashEmpty();
  return leadsArr.map(l => dashLeadRow(l, { right: `<span class="dash-badge">${dashFmtTime(l.followUpAt)}</span>` })).join('');
}

function buildColdBody(){
  const leadsArr = dashMetrics.coldLeads.leads;
  if(!leadsArr.length) return dashEmpty();
  const now = Date.now();
  return leadsArr.map(l => {
    const days = Math.floor((now - (l.updatedAt || l.createdAt || now)) / 86400000);
    return dashLeadRow(l, { right: `<span class="dash-badge">${days}d silent</span>` });
  }).join('');
}

function buildWonBody(){
  const leadsArr = dashMetrics.movedToWonToday.leads;
  if(!leadsArr.length) return dashEmpty();
  const valueLine = dashMetrics.movedToWonToday.totalValueINR > 0
    ? `<div class="dash-sec-headline">${window.formatINR(dashMetrics.movedToWonToday.totalValueINR)} combined value</div>` : '';
  return valueLine + leadsArr.map(l => dashLeadRow(l, { sub: l.budget ? `Budget: ${escapeHtml(l.budget)}` : '' })).join('');
}

function buildDeadBody(){
  const leadsArr = dashMetrics.movedToDeadToday.leads;
  if(!leadsArr.length) return dashEmpty();
  const aiBtn = dashDeadReasonsState === 'done' ? '' : `<button class="dash-ai-btn" id="dashDeadAiBtn" onclick="loadDashDeadReasons()">${dashDeadReasonsState==='loading' ? '⏳ Summarizing…' : '✨ Summarize reasons with AI'}</button>`;
  const rows = leadsArr.map(l => {
    const reason = dashDeadReasons[l.id];
    const noteText = l.lastNote && l.lastNote.text ? l.lastNote.text : '';
    const sub = reason ? `Reason: ${escapeHtml(reason)}` : (noteText ? `Note: “${escapeHtml(noteText)}”` : 'No note on file');
    return `<div id="dashDeadRow_${l.id}">${dashLeadRow(l, { sub })}</div>`;
  }).join('');
  return aiBtn + rows;
}
async function loadDashDeadReasons(){
  if(dashDeadReasonsState === 'loading') return;
  const leadsArr = dashMetrics.movedToDeadToday.leads;
  if(!leadsArr.length) return;
  dashDeadReasonsState = 'loading';
  const btn = document.getElementById('dashDeadAiBtn');
  if(btn){ btn.textContent = '⏳ Summarizing…'; btn.disabled = true; }
  try{
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/dashboard-summary?action=dead-reasons', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+idToken },
      body: JSON.stringify({ items: leadsArr.map(l => ({ id: l.id, note: (l.lastNote && l.lastNote.text) || '' })) })
    });
    const data = await res.json().catch(()=>({}));
    if(res.ok && data.reasons){
      Object.assign(dashDeadReasons, data.reasons);
      leadsArr.forEach(l => {
        const el = document.getElementById('dashDeadRow_'+l.id);
        if(el && dashDeadReasons[l.id]) el.innerHTML = dashLeadRow(l, { sub: `Reason: ${escapeHtml(dashDeadReasons[l.id])}` });
      });
      dashDeadReasonsState = 'done';
    } else {
      dashDeadReasonsState = 'idle';
      showToast('Could not summarize reasons — showing notes as-is');
    }
  } catch(e){
    console.error('loadDashDeadReasons failed:', e);
    dashDeadReasonsState = 'idle';
    showToast('Could not summarize reasons — showing notes as-is');
  }
  const body = document.getElementById('dashBody_movedToDeadToday');
  if(body) body.innerHTML = buildDeadBody();
}

function buildPipelineBody(){
  const rows = dashMetrics.pipelineByStage.stages;
  if(!rows.length) return dashEmpty();
  return `<div class="dash-pipeline-list">${rows.map(s => `
    <div class="dash-pipeline-row">
      <span class="stage-pill" style="background:${s.color}22;color:${s.color}">${escapeHtml(s.name)}</span>
      <div class="dash-pipeline-bar-wrap"><div class="dash-pipeline-bar" style="width:${s.pct}%;background:${s.color}"></div></div>
      <span class="dash-pipeline-count">${s.count} <span class="dash-pipeline-pct">(${s.pct}%)</span></span>
    </div>`).join('')}</div>`;
}

function buildOwnerBody(){
  const owners = dashMetrics.ownerActivity.owners;
  if(!owners.length) return dashEmpty();
  return `<div class="dash-owner-list">${owners.map(o => `
    <div class="dash-owner-row ${o.flagged ? 'flagged' : ''}">
      <div class="dash-owner-name">${escapeHtml(o.owner)}${o.flagged ? ' <span class="dash-flag">⚠️ no action today</span>' : ''}</div>
      <div class="dash-owner-stats">
        <span>Touched today: <b>${o.touchedToday}</b></span>
        <span>Followed up: <b>${o.followedUpToday}</b></span>
        <span>New assigned: <b>${o.newAssigned}</b></span>
        <span>Open leads: <b>${o.openLeads}</b></span>
        <span>Overdue: <b>${o.overdueCount}</b></span>
      </div>
    </div>`).join('')}</div>`;
}

function buildHygieneBody(){
  const h = dashMetrics.dataHygiene;
  const rows = [
    ['Missing phone', h.missingPhone],
    ['Missing budget', h.missingBudget],
    ['No follow-up date set (open leads)', h.noFollowUpDate],
    ['No AI summary', h.noAiSummary]
  ];
  let html = rows.map(([label, sec]) => `
    <div class="dash-hygiene-row">
      <span>${escapeHtml(label)}</span><span class="dash-badge">${sec.count}</span>
    </div>`).join('');
  html += `<div class="dash-hygiene-row"><span>Duplicate phone numbers</span><span class="dash-badge">${h.duplicatePhones.count}</span></div>`;
  if(h.duplicatePhones.count){
    html += h.duplicatePhones.groups.map(g => `
      <div class="dash-row-sub" style="padding:6px 16px">${escapeHtml(g.phone)}: ${g.leads.map(l=>escapeHtml(l.name||'Lead')).join(', ')}</div>`).join('');
  }
  return html;
}

function buildNewTodayBody(){
  const n = dashMetrics.newLeadsToday;
  if(!n.total) return dashEmpty('new leads today');
  const chanRows = n.byChannel.map(c => `<div class="dash-mini-row"><span>${escapeHtml(c.label)}</span><span>${c.count}</span></div>`).join('');
  const typeRows = n.byEnquiryType.map(c => `<div class="dash-mini-row"><span>${escapeHtml(c.label)}</span><span>${c.count}</span></div>`).join('');
  const srcRows = n.bySource.map(c => `<div class="dash-mini-row"><span>${escapeHtml(c.label)}</span><span>${c.count}</span></div>`).join('');
  const trendLabel = n.deltaPct === null ? '' : `${n.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(n.deltaPct)}% vs 7-day avg (${n.trailing7DayAvg}/day)`;
  return `
    <div class="dash-sec-headline">${n.total} new lead${n.total===1?'':'s'} today ${trendLabel ? `· ${trendLabel}` : ''}</div>
    <div class="dash-mini-grid">
      <div><div class="dash-mini-title">By Channel</div>${chanRows}</div>
      <div><div class="dash-mini-title">By Enquiry Type</div>${typeRows}</div>
      <div><div class="dash-mini-title">By Source</div>${srcRows}</div>
    </div>
    <div class="dash-mini-row" style="margin-top:8px"><span>Month-to-date</span><span>${n.monthToDateTotal}</span></div>
    ${buildLeadListBody(n.leads)}`;
}

function buildSiteVisitBody(bucketKey){
  const b = dashMetrics[bucketKey];
  if(!b.leads.length) return dashEmpty();
  return leadsHeadlineThenList(b.movedTodayCount, b.leads);
}
function leadsHeadlineThenList(movedToday, leadsArr){
  const headline = movedToday > 0 ? `<div class="dash-sec-headline">${movedToday} moved in today</div>` : '';
  return headline + buildLeadListBody(leadsArr);
}

// ── Main render ───────────────────────────────────────────────────────

function onDashDateChange(){
  const val = document.getElementById('dashDatePicker').value;
  if(!val) return;
  dashRefDate = new Date(val + 'T12:00:00+05:30');
  renderDashboardView();
}

window.renderDashboardView = function(){
  const el = document.getElementById('dashboardView');
  if(!el) return;
  dashBuilders = {};
  dashMetrics = window.computeDashboardMetrics ? window.computeDashboardMetrics(leads, stages, dashRefDate.getTime()) : null;
  if(!dashMetrics){ el.innerHTML = '<div class="dash-empty">Dashboard engine failed to load — refresh the page.</div>'; return; }
  const m = dashMetrics;

  const stats = [
    dashStatCard('New Today', m.newLeadsToday.total, 'newLeadsToday'),
    dashStatCard('Followed Up', m.followedUpToday.count, 'followedUpToday'),
    dashStatCard('Overdue', m.overdueFollowUps.count, 'overdueFollowUps'),
    dashStatCard('Cold Leads', m.coldLeads.count, 'coldLeads'),
    dashStatCard('Pending Site Visit', m.siteVisitPending.total, 'siteVisitPending'),
    dashStatCard('Site Visit Done', m.siteVisitDone.total, 'siteVisitDone'),
    dashStatCard('Missed Calls', m.missedCalls.total, 'missedCalls'),
    dashStatCard('Closed Today', m.movedToWonToday.count, 'movedToWonToday')
  ].join('');

  el.innerHTML = `
    <div class="dash-wrap">
      <div class="dash-toolbar">
        <input type="date" id="dashDatePicker" value="${dashDateInputValue(dashRefDate)}" onchange="onDashDateChange()">
        <span class="dash-toolbar-label">${escapeHtml(m.meta.dateLabel)} · ${m.meta.totalLeadsScanned} leads scanned</span>
      </div>
      <div class="dash-stats">${stats}</div>

      ${dashSection('followedUpToday', '✅', "Followed Up Today", m.followedUpToday.count, () => buildLeadListBody(m.followedUpToday.leads))}
      ${dashSection('overdueFollowUps', '⚠️', 'Overdue Follow-ups', m.overdueFollowUps.count, buildOverdueBody)}
      ${dashSection('actionLog', '📝', "Today's Action Log", m.actionLog.count, buildActionLogBody)}
      ${dashSection('stageChangesToday', '🔀', 'Stage Changes Today', `${m.stageChangesToday.count} (${m.stageChangesToday.forwardCount} forward)`, () => buildLeadListBody(m.stageChangesToday.leads))}
      ${dashSection('siteVisitPending', '🕓', 'Pending Site Visit', m.siteVisitPending.total, () => buildSiteVisitBody('siteVisitPending'))}
      ${dashSection('siteVisitDone', '🏠', 'Site Visit Done', m.siteVisitDone.total, () => buildSiteVisitBody('siteVisitDone'))}
      ${dashSection('missedCalls', '📵', 'Missed Calls', m.missedCalls.total, () => buildLeadListBody(m.missedCalls.leads))}
      ${dashSection('movedToWonToday', '🎉', 'Moved to Closed Today', m.movedToWonToday.count, buildWonBody)}
      ${dashSection('movedToDeadToday', '🚫', 'Moved to Not Interested / Spam Today', m.movedToDeadToday.count, buildDeadBody)}
      ${dashSection('newLeadsNoActionToday', '🆕', 'New Today, No Action Yet', m.newLeadsNoActionToday.count, () => buildLeadListBody(m.newLeadsNoActionToday.leads))}
      ${dashSection('newLeadsToday', '📈', 'New Leads Today', m.newLeadsToday.total, buildNewTodayBody)}
      ${dashSection('followUpsDueTomorrow', '🌤️', "Tomorrow's Follow-up Plan", m.followUpsDueTomorrow.count, buildTomorrowBody)}
      ${dashSection('coldLeads', '🧊', 'Cold Leads (7+ days silent)', m.coldLeads.count, buildColdBody)}
      ${dashSection('pipelineByStage', '📊', 'Pipeline by Stage', m.pipelineByStage.totalLeads, buildPipelineBody)}
      ${dashSection('ownerActivity', '👤', 'Owner Activity', m.ownerActivity.owners.length, buildOwnerBody)}
      ${dashSection('dataHygiene', '🧹', 'Data Hygiene', m.dataHygiene.missingPhone.count + m.dataHygiene.missingBudget.count + m.dataHygiene.noFollowUpDate.count + m.dataHygiene.noAiSummary.count + m.dataHygiene.duplicatePhones.count, buildHygieneBody)}
    </div>`;
  dashDeadReasonsState = 'idle';
  dashDeadReasons = {};
};
