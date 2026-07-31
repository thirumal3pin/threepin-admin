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
// Site visits DONE is read two different ways and the difference matters:
// "today" is the day's actual activity (what the daily report reports), the
// standing total is the all-time size of that stage. Both are shown, today's
// first, so neither can be mistaken for the other.
function buildSiteVisitDoneBody(){
  const b = dashMetrics.siteVisitDone;
  const today = b.movedTodayLeads;
  const todayBlock = `<div class="dash-sec-headline">${today.length} site visit${today.length===1?'':'s'} done today</div>`
    + (today.length ? buildLeadListBody(today) : dashEmpty('no site visits completed today'));
  // Nothing to add when today IS the whole stage — repeating the identical
  // list under an "all-time" heading just reads as a duplicate.
  if(b.total <= today.length) return todayBlock;
  return todayBlock
    + `<div class="dash-sec-note" style="margin-top:12px">All-time in this stage — ${b.total} lead${b.total===1?'':'s'}</div>`
    + buildLeadListBody(b.leads);
}

// ── Charts ────────────────────────────────────────────────────────────
// Almost every chart here is a single-series magnitude plot, so it uses ONE
// hue rather than a categorical palette — identity never rides on colour, and
// there is nothing for a colour-blind reader to tell apart. Text always wears
// the ink tokens; only marks carry the hue.
//
// This is the brand orange stepped down to #D47300, which clears the 3:1
// floor for non-text marks on white — the logo's own #FE8D00 is 2.3:1 and
// would leave bars washed out against the card.
const CHART_HUE = '#D47300';
const CHART_HUE_SOFT = '#FBE4C8';

// Axis ticks land on 1/2/5×10ⁿ so the labels read as round numbers.
function dashNiceStep(max, targetTicks){
  const raw = Math.max(1, max) / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

let dashTrendData = [];
let dashTrendShowTable = false;

function dashTrendChartHtml(trend){
  dashTrendData = trend || [];
  if(!dashTrendData.length) return dashEmpty('no lead history yet');
  if(dashTrendShowTable) return dashTrendTableHtml();

  const W = 720, H = 190, PL = 34, PR = 14, PT = 14, PB = 30;
  const iw = W - PL - PR, ih = H - PT - PB;
  const n = dashTrendData.length;
  const max = Math.max(1, ...dashTrendData.map(d => d.count));
  const step = dashNiceStep(max, 4);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = [];
  for(let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));

  const px = i => PL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const py = v => PT + ih - (v / top) * ih;
  const pts = dashTrendData.map((d, i) => [px(i), py(d.count)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length-1][0].toFixed(1)},${PT+ih} L${pts[0][0].toFixed(1)},${PT+ih} Z`;

  const grid = ticks.map(v => `
    <line x1="${PL}" y1="${py(v).toFixed(1)}" x2="${W-PR}" y2="${py(v).toFixed(1)}" stroke="#E4E0D8" stroke-width="1" vector-effect="non-scaling-stroke"/>
    <text x="${PL-8}" y="${(py(v)+4).toFixed(1)}" text-anchor="end" class="dash-chart-tick">${v}</text>`).join('');

  // Only first / middle / last get an x label — 14 dates would collide.
  const xLabelIdx = new Set([0, Math.floor((n-1)/2), n-1]);
  const xLabels = dashTrendData.map((d, i) => xLabelIdx.has(i)
    ? `<text x="${px(i).toFixed(1)}" y="${H-9}" text-anchor="${i===0?'start':(i===n-1?'end':'middle')}" class="dash-chart-tick">${escapeHtml(d.label)}</text>`
    : '').join('');

  // Full-height hit bands, wider than the marks, so hovering anywhere in a
  // day's column reveals it (see interaction guidance on hit targets). The
  // first and last bands are clamped to the plot area — a half-band hanging
  // off each end would widen the SVG's scrollable box and push the whole page
  // sideways on a phone.
  const band = iw / Math.max(1, n - 1);
  const hits = dashTrendData.map((d, i) => {
    const x0 = Math.max(PL, px(i) - band/2);
    const x1 = Math.min(W - PR, px(i) + band/2);
    return `<rect x="${x0.toFixed(1)}" y="${PT}" width="${(x1-x0).toFixed(1)}" height="${ih}" fill="transparent"
      onmousemove="dashTrendHover(event,${i})" onmouseleave="dashTrendHoverOut()"></rect>`;
  }).join('');

  const last = pts[pts.length - 1];
  const lastVal = dashTrendData[n-1].count;

  return `<div class="dash-chart-wrap" id="dashTrendWrap">
    <svg viewBox="0 0 ${W} ${H}" class="dash-chart-svg" role="img" aria-label="New leads per day for the last ${n} days">
      ${grid}
      <path d="${area}" fill="${CHART_HUE}" fill-opacity="0.10"/>
      <path d="${line}" fill="none" stroke="${CHART_HUE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4.5" fill="${CHART_HUE}" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <text x="${(last[0]-8).toFixed(1)}" y="${(last[1]-10).toFixed(1)}" text-anchor="end" class="dash-chart-endlabel">${lastVal}</text>
      ${xLabels}
      ${hits}
    </svg>
    <div class="dash-chart-tip" id="dashTrendTip" style="display:none"></div>
  </div>`;
}

function dashTrendTableHtml(){
  return `<div class="dash-chart-table"><table>
    <thead><tr><th>Date</th><th>Day</th><th>New leads</th></tr></thead>
    <tbody>${dashTrendData.map(d => `<tr><td>${escapeHtml(d.label)}</td><td>${escapeHtml(d.weekday)}</td><td>${d.count}</td></tr>`).join('')}</tbody>
  </table></div>`;
}
function toggleDashTrendTable(){
  dashTrendShowTable = !dashTrendShowTable;
  const host = document.getElementById('dashTrendBody');
  const btn = document.getElementById('dashTrendTableBtn');
  if(host) host.innerHTML = dashTrendChartHtml(dashTrendData);
  if(btn) btn.textContent = dashTrendShowTable ? '📈 Chart' : '⊞ Table';
}
function dashTrendHover(ev, i){
  const tip = document.getElementById('dashTrendTip');
  const wrap = document.getElementById('dashTrendWrap');
  const d = dashTrendData[i];
  if(!tip || !wrap || !d) return;
  tip.innerHTML = `<b>${escapeHtml(d.weekday)} ${escapeHtml(d.label)}</b><br>${d.count} new lead${d.count===1?'':'s'}`;
  tip.style.display = '';
  const r = wrap.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  tip.style.left = Math.max(4, Math.min(x + 12, r.width - tip.offsetWidth - 4)) + 'px';
  tip.style.top = Math.max(4, y - tip.offsetHeight - 10) + 'px';
}
function dashTrendHoverOut(){
  const tip = document.getElementById('dashTrendTip');
  if(tip) tip.style.display = 'none';
}

// Horizontal magnitude bars: one hue, 4px rounded data-end, square at the
// baseline, value at the tip. Never used for identity.
function dashBarRows(rows, valueOf, labelOf, subOf){
  const max = Math.max(1, ...rows.map(valueOf));
  return `<div class="dash-bar-list">${rows.map(r => `
    <div class="dash-bar-row">
      <div class="dash-bar-label" title="${escapeHtml(labelOf(r))}">${escapeHtml(labelOf(r))}</div>
      <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${Math.max(2, (valueOf(r)/max)*100)}%;background:${CHART_HUE}"></div></div>
      <div class="dash-bar-val">${valueOf(r)}</div>
      ${subOf ? `<div class="dash-bar-sub">${subOf(r)}</div>` : ''}
    </div>`).join('')}</div>`;
}

// Ordinal ramp for ORDERED categories only (the journey funnel), light→dark.
// Validated against white: lightest step is 2.14:1, clearing the 2:1 floor an
// ordinal ramp's near-surface step has to hold. Never used for nominal
// categories — those get one flat hue, so length is the only encoding.
const CHART_RAMP = ['#F0A03C', '#E88A1B', '#D47300', '#B35F00'];

// Vertical columns for a short ordered series (months, budget bands).
// ≤24px thick, 4px rounded cap, square at the baseline, value on the cap.
function dashColumnsHtml(rows, opts){
  opts = opts || {};
  if(!rows || !rows.length) return dashEmpty(opts.emptyLabel);
  const max = Math.max(1, ...rows.map(r => r.count));
  return `<div class="dash-cols" style="--cols:${rows.length}">
    ${rows.map(r => {
      const h = Math.max(2, Math.round((r.count / max) * 100));
      return `<div class="dash-col" title="${escapeHtml(r.label)}: ${r.count}">
        <div class="dash-col-val">${r.count}</div>
        <div class="dash-col-track"><div class="dash-col-fill" style="height:${h}%;background:${CHART_HUE}"></div></div>
        <div class="dash-col-label">${escapeHtml(r.label)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

// The journey checkpoints. Bar length is the count; the ordinal ramp reinforces
// the sequence. Each row carries its own count AND share, so nothing depends on
// reading a colour.
function dashFunnelHtml(steps){
  if(!steps || !steps.length) return dashEmpty();
  const max = Math.max(1, ...steps.map(s => s.count));
  return `<div class="dash-funnel">
    ${steps.map((s, i) => {
      const w = Math.max(3, (s.count / max) * 100);
      const colour = CHART_RAMP[Math.min(i, CHART_RAMP.length - 1)];
      const dropFrom = i > 0 ? steps[i-1].count : null;
      const drop = dropFrom && dropFrom > 0 ? Math.round((s.count / dropFrom) * 100) : null;
      return `<div class="dash-funnel-row">
        <div class="dash-funnel-head">
          <span class="dash-funnel-label">${escapeHtml(s.label)}</span>
          <span class="dash-funnel-val">${s.count}<span class="dash-funnel-pct">${s.pct === null ? '' : ` · ${s.pct}% of all`}</span></span>
        </div>
        <div class="dash-funnel-track"><div class="dash-funnel-fill" style="width:${w}%;background:${colour}"></div></div>
        ${drop !== null ? `<div class="dash-funnel-step">${drop}% carried through from “${escapeHtml(steps[i-1].label)}”</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function dashKpiTile(label, value, sub){
  return `<div class="dash-kpi">
    <div class="dash-kpi-val">${value}</div>
    <div class="dash-kpi-label">${escapeHtml(label)}</div>
    ${sub ? `<div class="dash-kpi-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}
function dashPct(v){ return v === null || v === undefined ? '—' : `${v}%`; }

// ── Property sections ─────────────────────────────────────────────────

// Property groups and enquiry-type groups have an identical shape by design
// (see finishGroups in dashboardMetrics.js), so one renderer serves both.
function buildGroupTodayBody(section, emptyLabel){
  const rows = section.newTodayRows;
  if(!rows.length) return dashEmpty(emptyLabel);
  return dashBarRows(rows, r => r.newToday, r => r.label)
    + `<div class="dash-mini-row" style="margin-top:10px"><span>Total new today</span><span>${section.newTodayTotal}</span></div>`;
}

function buildGroupPerformanceBody(section, colLabel, note){
  const rows = section.rows;
  if(!rows.length) return dashEmpty('nothing here yet');
  const top = rows.slice(0, 12);
  const chart = dashBarRows(top, r => r.total, r => r.label);
  const table = `<div class="dash-chart-table"><table>
    <thead><tr><th>${escapeHtml(colLabel)}</th><th>Total</th><th>Today</th><th>Open</th><th>Site visits</th><th>Closed</th><th>Conv.</th><th>Pipeline</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="dash-td-name">${escapeHtml(r.label)}</td>
      <td>${r.total}</td>
      <td>${r.newToday || '—'}</td>
      <td>${r.open}</td>
      <td>${r.siteVisitDone}</td>
      <td>${r.won}</td>
      <td>${dashPct(r.conversionPct)}</td>
      <td>${r.pipelineValueINR ? window.formatINR(r.pipelineValueINR) : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
  return `<div class="dash-sec-note">${escapeHtml(note)}</div>`
    + chart
    + (rows.length > top.length ? `<div class="dash-sec-note">Chart shows the top ${top.length}; all ${rows.length} are in the table below.</div>` : '')
    + table;
}

function buildPropertyTodayBody(){ return buildGroupTodayBody(dashMetrics.propertyPerformance, 'no property enquiries today'); }
function buildPropertyPerformanceBody(){
  return buildGroupPerformanceBody(dashMetrics.propertyPerformance, 'Property',
    'Property Enquiry leads only, grouped by property. Spam excluded. “Conv.” is Closed ÷ total.');
}
function buildEnquiryTodayBody(){ return buildGroupTodayBody(dashMetrics.enquiryPerformance, 'no other enquiries today'); }
function buildEnquiryPerformanceBody(){
  return buildGroupPerformanceBody(dashMetrics.enquiryPerformance, 'Enquiry type',
    'Everything that is not a Property Enquiry, grouped by enquiry type rather than by property. Spam excluded.');
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
    dashStatCard('Site Visits Today', m.siteVisitDone.movedTodayCount, 'siteVisitDone'),
    dashStatCard('Missed Calls', m.missedCalls.total, 'missedCalls'),
    dashStatCard('Closed Today', m.movedToWonToday.count, 'movedToWonToday')
  ].join('');

  const k = m.kpis;
  const kpis = [
    dashKpiTile('Total leads', k.nonSpamTotal, `excl. ${k.spamCount} spam`),
    dashKpiTile('Open pipeline', window.formatINR(k.openPipelineValueINR), `${k.openLeads} open leads`),
    dashKpiTile('Conversion', dashPct(k.conversionPct), `${k.wonLeads} closed`),
    dashKpiTile('Site-visit rate', dashPct(k.siteVisitConversionPct), `${m.siteVisitDone.total} visited`),
    dashKpiTile('Details shared', dashPct(k.detailsSentPct), 'of open leads'),
    dashKpiTile('Overdue', dashPct(k.overduePct), 'of open leads'),
    dashKpiTile('New / day', k.avgNewLeadsPerDay, 'avg last 14 days'),
    dashKpiTile('New this month', k.newLeadsMTD, 'month to date')
  ].join('');

  el.innerHTML = `
    <div class="dash-wrap">
      <div class="dash-toolbar">
        <input type="date" id="dashDatePicker" value="${dashDateInputValue(dashRefDate)}" onchange="onDashDateChange()">
        <span class="dash-toolbar-label">${escapeHtml(m.meta.dateLabel)} · ${m.meta.totalLeadsScanned} leads scanned</span>
      </div>
      <div class="dash-stats">${stats}</div>

      <div class="dash-card">
        <div class="dash-card-hdr">
          <div>
            <div class="dash-card-title">New Leads — Last 14 Days</div>
            <div class="dash-card-sub">Leads created per day, IST · avg ${k.avgNewLeadsPerDay}/day</div>
          </div>
          <button class="dash-card-btn" id="dashTrendTableBtn" onclick="toggleDashTrendTable()">${dashTrendShowTable ? '📈 Chart' : '⊞ Table'}</button>
        </div>
        <div id="dashTrendBody">${dashTrendChartHtml(m.newLeadsToday.dailyTrend)}</div>
      </div>

      <div class="dash-card">
        <div class="dash-card-hdr"><div>
          <div class="dash-card-title">Portfolio KPIs</div>
          <div class="dash-card-sub">All-time, spam excluded</div>
        </div></div>
        <div class="dash-kpi-grid">${kpis}</div>
      </div>

      <div class="dash-card-grid">
        <div class="dash-card">
          <div class="dash-card-hdr"><div>
            <div class="dash-card-title">Lead Journey</div>
            <div class="dash-card-sub">Where the book stands right now</div>
          </div></div>
          ${dashFunnelHtml(m.journey)}
        </div>
        <div class="dash-card">
          <div class="dash-card-hdr"><div>
            <div class="dash-card-title">New Leads by Month</div>
            <div class="dash-card-sub">Last 6 months</div>
          </div></div>
          ${dashColumnsHtml(m.mix.byMonth, { emptyLabel:'no history yet' })}
        </div>
      </div>

      <div class="dash-card-grid">
        <div class="dash-card">
          <div class="dash-card-hdr"><div>
            <div class="dash-card-title">Leads by Channel</div>
            <div class="dash-card-sub">All-time, spam excluded</div>
          </div></div>
          ${m.mix.byChannel.length ? dashBarRows(m.mix.byChannel, r => r.count, r => r.label) : dashEmpty('no leads yet')}
        </div>
        <div class="dash-card">
          <div class="dash-card-hdr"><div>
            <div class="dash-card-title">Leads by Source</div>
            <div class="dash-card-sub">Where the enquiry originated</div>
          </div></div>
          ${m.mix.bySource.length ? dashBarRows(m.mix.bySource, r => r.count, r => r.label) : dashEmpty('no leads yet')}
        </div>
      </div>

      <div class="dash-card">
        <div class="dash-card-hdr"><div>
          <div class="dash-card-title">Budget Distribution</div>
          <div class="dash-card-sub">All-time, spam excluded · unparseable budgets counted as “Not specified”</div>
        </div></div>
        ${dashColumnsHtml(m.mix.byBudgetBand, { emptyLabel:'no budgets recorded' })}
      </div>

      <div class="dash-card-grid">
        <div class="dash-card">
          <div class="dash-card-hdr"><div>
            <div class="dash-card-title">Pipeline by Stage</div>
            <div class="dash-card-sub">${m.pipelineByStage.totalLeads} leads across ${m.pipelineByStage.stages.length} stages</div>
          </div></div>
          ${buildPipelineBody()}
        </div>
        <div class="dash-card">
          <div class="dash-card-hdr"><div>
            <div class="dash-card-title">Open Leads by Owner</div>
            <div class="dash-card-sub">Who is carrying the book</div>
          </div></div>
          ${m.ownerActivity.owners.length
            ? dashBarRows(m.ownerActivity.owners.slice().sort((a,b)=>b.openLeads-a.openLeads), o => o.openLeads, o => o.owner)
            : dashEmpty('no owners yet')}
        </div>
      </div>

      ${dashSection('propertyToday', '📍', 'Property-wise Leads Today', m.propertyPerformance.newTodayTotal, buildPropertyTodayBody)}
      ${dashSection('propertyPerformance', '🏘️', 'Property Performance (all-time)', m.propertyPerformance.totalProperties, buildPropertyPerformanceBody)}
      ${dashSection('enquiryToday', '🏷️', 'Other Enquiries Today (by type)', m.enquiryPerformance.newTodayTotal, buildEnquiryTodayBody)}
      ${dashSection('enquiryPerformance', '📁', 'Enquiry Type Performance (all-time)', m.enquiryPerformance.totalGroups, buildEnquiryPerformanceBody)}

      ${dashSection('followedUpToday', '✅', "Followed Up Today", m.followedUpToday.count, () => buildLeadListBody(m.followedUpToday.leads))}
      ${dashSection('overdueFollowUps', '⚠️', 'Overdue Follow-ups', m.overdueFollowUps.count, buildOverdueBody)}
      ${dashSection('actionLog', '📝', "Today's Action Log", m.actionLog.count, buildActionLogBody)}
      ${dashSection('stageChangesToday', '🔀', 'Stage Changes Today', `${m.stageChangesToday.count} (${m.stageChangesToday.forwardCount} forward)`, () => buildLeadListBody(m.stageChangesToday.leads))}
      ${dashSection('siteVisitPending', '🕓', 'Pending Site Visit', m.siteVisitPending.total, () => buildSiteVisitBody('siteVisitPending'))}
      ${dashSection('siteVisitDone', '🏠', 'Site Visits Done', `${m.siteVisitDone.movedTodayCount} today · ${m.siteVisitDone.total} all-time`, buildSiteVisitDoneBody)}
      ${dashSection('missedCalls', '📵', 'Missed Calls', m.missedCalls.total, () => buildLeadListBody(m.missedCalls.leads))}
      ${dashSection('movedToWonToday', '🎉', 'Moved to Closed Today', m.movedToWonToday.count, buildWonBody)}
      ${dashSection('movedToDeadToday', '🚫', 'Moved to Not Interested / Spam Today', m.movedToDeadToday.count, buildDeadBody)}
      ${dashSection('newLeadsNoActionToday', '🆕', 'New Today, No Action Yet', m.newLeadsNoActionToday.count, () => buildLeadListBody(m.newLeadsNoActionToday.leads))}
      ${dashSection('newLeadsToday', '📈', 'New Leads Today', m.newLeadsToday.total, buildNewTodayBody)}
      ${dashSection('followUpsDueTomorrow', '🌤️', "Tomorrow's Follow-up Plan", m.followUpsDueTomorrow.count, buildTomorrowBody)}
      ${dashSection('coldLeads', '🧊', 'Cold Leads (7+ days silent)', m.coldLeads.count, buildColdBody)}
      ${dashSection('ownerActivity', '👤', 'Owner Activity Detail', m.ownerActivity.owners.length, buildOwnerBody)}
      ${dashSection('dataHygiene', '🧹', 'Data Hygiene', m.dataHygiene.missingPhone.count + m.dataHygiene.missingBudget.count + m.dataHygiene.noFollowUpDate.count + m.dataHygiene.noAiSummary.count + m.dataHygiene.duplicatePhones.count, buildHygieneBody)}
    </div>`;
  dashDeadReasonsState = 'idle';
  dashDeadReasons = {};
};
