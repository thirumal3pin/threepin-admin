// ═══════ STATE ═══════
let leads = [];
let stages = [];
let enquiryTypes = ['Property Enquiry', 'Seller Listing', 'General'];
let filteredLeads = [];
let currentView = 'kanban';
let lastBrowseView = 'kanban';
let currentSearch = '';
let currentDetailId = null;
let lModalMode = 'add';
let lModalEditId = null;
let lmModalContactAt = null;
let stageManagerDraft = [];
let toastTimer;
let currentUserEmail = null;
let digestSettings = { enabled:false, recipients:[], emailEnabled:false, emails:[] };
let digestSettingsDraft = { enabled:false, recipients:[], emailEnabled:false, emails:[] };

const CHANNEL_META = {
  call: { label: 'Direct Call', icon: '📞' },
  whatsapp: { label: 'WhatsApp', icon: '🟢' },
  instagram: { label: 'Instagram', icon: '📸' }
};
function channelLabel(c){
  const m = CHANNEL_META[c];
  return m ? `${m.icon} ${m.label}` : '—';
}

// wa.me needs digits only, no leading zeros, with country code. Most leads
// here are 10-digit Indian mobile numbers with no country code typed in, so
// default to +91 — the only assumption we can make without asking the user.
function waHref(phone){
  if(!phone) return null;
  let digits = String(phone).replace(/\D/g,'');
  if(!digits) return null;
  if(digits.length===10) digits = '91'+digits;
  else if(digits.length===11 && digits.startsWith('0')) digits = '91'+digits.slice(1);
  return `https://wa.me/${digits}`;
}

// ═══════ SNAPSHOT HANDLERS (called by firebase-sync.js) ═══════
window.applyLeadsSnapshot = function(list){
  leads = list;
  refreshAll();
  // The AI summary regenerates server-side (see generate-lead-summary.js)
  // and arrives back through this same snapshot — refresh just that block
  // if its lead's detail page happens to be open, without touching any
  // in-progress form state elsewhere in the panel.
  if(currentDetailId && document.getElementById('dp').classList.contains('open')){
    const l = leads.find(x=>x.id===currentDetailId);
    if(l) renderAiSummary(l);
  }
};
window.applyPipelineSnapshot = function(list){
  stages = list.slice().sort((a,b)=> (a.order||0) - (b.order||0));
  refreshAll();
};
window.applyEnquiryTypesSnapshot = function(list){
  enquiryTypes = (list && list.length) ? list : enquiryTypes;
  if(document.getElementById('lModal').classList.contains('open')){
    renderEnquiryTypeOptions(document.getElementById('lmEnquiryType').value);
  }
};
window.applyDigestSettingsSnapshot = function(settings){
  digestSettings = settings;
};

function refreshAll(){
  updateStats();
  updateFollowupBadge();
  checkFollowupNotify(false);
  applyFilters();
}

// ═══════ INIT ═══════
function init(){
  setupSearch();
  updateNavState();
  applyFilters();
  updateStats();
  updateNotifyBtnLabel();
  setInterval(()=>checkFollowupNotify(false), 15*60*1000);
}

// ═══════ BROWSER FOLLOW-UP ALERTS ═══════
// Per-device preference (localStorage, not synced) — a native OS
// notification while this tab is open, independent of the WhatsApp digest.
const FU_NOTIFY_KEY = 'fuNotifyEnabled';
const FU_NOTIFY_INTERVAL_MS = 60*60*1000; // don't re-notify more than once/hour
let fuNotifyEnabled = localStorage.getItem(FU_NOTIFY_KEY) === '1';
let fuLastNotifiedAt = 0;
function updateNotifyBtnLabel(){
  const btn = document.getElementById('fuNotifyBtn');
  if(!btn) return;
  btn.textContent = fuNotifyEnabled ? '🔔 Browser Alerts: On' : '🔕 Browser Alerts: Off';
}
async function toggleBrowserNotify(){
  if(!('Notification' in window)){ showToast('Notifications not supported in this browser'); return; }
  if(!fuNotifyEnabled){
    const perm = await Notification.requestPermission();
    if(perm!=='granted'){ showToast('Notification permission denied'); return; }
    fuNotifyEnabled = true;
    localStorage.setItem(FU_NOTIFY_KEY,'1');
    showToast('✓ Browser alerts enabled');
    checkFollowupNotify(true);
  } else {
    fuNotifyEnabled = false;
    localStorage.setItem(FU_NOTIFY_KEY,'0');
    showToast('Browser alerts turned off');
  }
  updateNotifyBtnLabel();
}
function checkFollowupNotify(force){
  if(!fuNotifyEnabled) return;
  if(!('Notification' in window) || Notification.permission!=='granted') return;
  const withFollowup = leads.filter(l=>l.followUpAt);
  if(!withFollowup.length) return;
  const buckets = followupBuckets(withFollowup);
  const count = buckets.overdue.length + buckets.today.length;
  if(count<=0) return;
  const now = Date.now();
  if(!force && now-fuLastNotifiedAt < FU_NOTIFY_INTERVAL_MS) return;
  fuLastNotifiedAt = now;
  const n = new Notification('📅 Follow-ups need attention', {
    body: `${buckets.overdue.length} overdue, ${buckets.today.length} due today`,
    tag: 'crm-followups'
  });
  n.onclick = () => { window.focus(); toggleView('followups'); n.close(); };
}

function updateStats(){
  document.getElementById('statTotal').textContent = leads.length;
}

// ═══════ SEARCH / FILTER ═══════
function setupSearch(){
  const inp = document.getElementById('searchInput');
  inp.addEventListener('input', e=>{
    currentSearch = e.target.value.toLowerCase();
    document.getElementById('srchClear').classList.toggle('show', !!currentSearch);
    applyFilters();
  });
}
function clearSearch(){
  document.getElementById('searchInput').value='';
  currentSearch='';
  document.getElementById('srchClear').classList.remove('show');
  applyFilters();
}

function applyFilters(){
  filteredLeads = leads.filter(l=>{
    if(currentSearch){
      const hay = [l.name,l.phone,l.email,l.propertyInterest,l.enquiryType,l.budget,channelLabel(l.channel)].join(' ').toLowerCase();
      if(!hay.includes(currentSearch)) return false;
    }
    return true;
  });
  if(currentView==='kanban') renderBoard();
  else if(currentView==='list') renderList();
  else renderFollowups();
}

// ═══════ NAV: view switching, view dropdown, more menu ═══════
function toggleView(view){
  currentView = view;
  if(view!=='followups') lastBrowseView = view;
  updateNavState();
  document.getElementById('kanbanView').style.display = view==='kanban' ? '' : 'none';
  document.getElementById('listView').style.display = view==='list' ? '' : 'none';
  document.getElementById('followupsView').style.display = view==='followups' ? '' : 'none';
  closeViewDropdown();
  applyFilters();
}
function updateNavState(){
  document.getElementById('fuNavBtn').classList.toggle('at', currentView==='followups');
  document.querySelector('#viewDd .view-dd-btn').classList.toggle('at', currentView!=='followups');
  document.getElementById('viewDdLabel').textContent = lastBrowseView==='list' ? '📃 List' : '📋 Board';
  document.querySelectorAll('#viewDdMenu button').forEach(b=>b.classList.toggle('at', b.dataset.view===lastBrowseView && currentView!=='followups'));
}
function toggleViewDropdown(e){
  if(e) e.stopPropagation();
  document.getElementById('viewDd').classList.toggle('open');
  document.getElementById('moreDd').classList.remove('open');
}
function closeViewDropdown(){
  document.getElementById('viewDd').classList.remove('open');
}
function toggleMoreMenu(e){
  if(e) e.stopPropagation();
  document.getElementById('moreDd').classList.toggle('open');
  document.getElementById('viewDd').classList.remove('open');
}
function closeMoreMenu(){
  document.getElementById('moreDd').classList.remove('open');
}
document.addEventListener('click', ()=>{ closeViewDropdown(); closeMoreMenu(); });

// ═══════ HELPERS ═══════
function stageById(id){ return stages.find(s=>s.id===id); }
function nextStageId(id){
  const idx = stages.findIndex(s=>s.id===id);
  if(idx===-1 || idx===stages.length-1) return null;
  return stages[idx+1].id;
}
function timeAgo(ts){
  if(!ts) return '—';
  const diff = Date.now()-ts;
  const mins = Math.floor(diff/60000);
  if(mins<1) return 'just now';
  if(mins<60) return mins+'m ago';
  const hrs = Math.floor(mins/60);
  if(hrs<24) return hrs+'h ago';
  const days = Math.floor(hrs/24);
  return days+'d ago';
}
function pad2(n){ return String(n).padStart(2,'0'); }
function toDateInputValue(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function toTimeInputValue(d){ return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function followUpBadge(l){
  if(!l.followUpAt) return '';
  const diff = l.followUpAt - Date.now();
  const cls = diff < 0 ? 'overdue' : (diff < 24*60*60*1000 ? 'soon' : '');
  const when = new Date(l.followUpAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  return `<div class="lcard-followup ${cls}">📅 ${diff<0?'Overdue: ':''}${when}</div>`;
}

// ═══════ PERSIST + AI SUMMARY ═══════
// Single choke point for every lead write — every call site that used to
// call window.crmFirebase.saveLead(l) directly now goes through here, so a
// summary regeneration can never be forgotten on some new call site later.
function persistLead(l){
  window.crmFirebase.saveLead(l);
  scheduleSummaryRegeneration(l.id);
}

// Debounced ~5s per lead: a burst of edits to the same lead (e.g. change
// stage, then immediately log a note) collapses into a single Claude call
// instead of one per save. The regenerated summary comes back through the
// normal Firestore onSnapshot listener (applyLeadsSnapshot) — no need to
// patch local state here.
const summaryRegenTimers = {};
function scheduleSummaryRegeneration(leadId){
  clearTimeout(summaryRegenTimers[leadId]);
  summaryRegenTimers[leadId] = setTimeout(() => {
    delete summaryRegenTimers[leadId];
    regenerateLeadSummary(leadId);
  }, 5000);
}
function renderAiSummary(l){
  const el = document.getElementById('dpAiSummary');
  if(!el) return;
  if(!l.aiSummary && !l.aiSummaryError){
    el.innerHTML = `<div class="dp-ai-summary-box empty"><span>✨</span><span>No AI summary yet — one will generate shortly after the next change.</span></div>`;
    return;
  }
  const metaHtml = `<div class="dp-ai-summary-meta">✨ AI summary${l.aiSummaryAt?' · updated '+timeAgo(l.aiSummaryAt):''}</div>`;
  const summaryHtml = l.aiSummary
    ? `<div class="dp-ai-summary-text">${escapeHtml(l.aiSummary)}</div>`
    : `<div class="dp-ai-summary-text empty">No summary yet.</div>`;
  const errorHtml = l.aiSummaryError
    ? `<div class="dp-ai-summary-err">⚠ Couldn't refresh the summary — showing the last one. (${escapeHtml(l.aiSummaryError)})</div>`
    : '';
  el.innerHTML = `<div class="dp-ai-summary-box${l.aiSummaryError?' has-error':''}">${metaHtml}${summaryHtml}${errorHtml}</div>`;
}
async function regenerateLeadSummary(leadId){
  try{
    const idToken = await window.crmAuth.getIdToken();
    if(!idToken) return;
    await fetch('/api/generate-lead-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+idToken },
      body: JSON.stringify({ leadId })
    });
  } catch(e){
    // Summary generation is best-effort and must never surface as a user-
    // facing error for an otherwise-successful save — the failure is still
    // visible via aiSummaryError once/if the request reaches the server.
    console.error('regenerateLeadSummary failed:', e);
  }
}

// One-time (re-runnable) bulk fill for existing leads that predate this
// feature — skips any lead that already has a summary. Runs server-side via
// api/backfill-lead-summaries.js so it uses the real ANTHROPIC_API_KEY at
// Vercel runtime; results land back through the usual Firestore listener.
async function runBackfillSummaries(){
  if(!confirm('Generate AI summaries for every existing lead that doesn\'t have one yet? This calls the Claude API once per lead.')) return;
  closeMoreMenu();
  showToast('Generating summaries…');
  try{
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/backfill-lead-summaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+idToken },
      body: JSON.stringify({})
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){ showToast(data.error || 'Backfill failed'); return; }
    const skippedNote = data.skipped ? `, ${data.skipped} already had one` : '';
    showToast(data.failed
      ? `✓ Generated ${data.generated}, ${data.failed} failed${skippedNote} — check console`
      : `✓ Generated summaries for ${data.generated} lead${data.generated===1?'':'s'}${skippedNote}`);
    if(data.errors && data.errors.length) console.error('Backfill errors:', data.errors);
  } catch(e){
    console.error('runBackfillSummaries failed:', e);
    showToast('Backfill failed — check console');
  }
}

// ═══════ LEAD HISTORY LOG ═══════
// text may contain <b> tags around already-escaped values for emphasis —
// never pass raw user input directly, always escapeHtml() it first.
function addHistory(l, type, text){
  l.history = l.history || [];
  l.history.push({
    id: 'h'+Date.now()+Math.random().toString(36).slice(2,7),
    type, text,
    at: Date.now(),
    by: currentUserEmail || l.updatedBy || null
  });
}
function historyIcon(type){
  return { created:'✨', stage:'🔀', field:'✏️', followup:'📅', 'followup-removed':'🗑️', 'followed-up':'✓', 'details-sent':'📨' }[type] || '•';
}
function renderHistory(l){
  const el = document.getElementById('historyPanel');
  if(!el) return;
  const items = (l.history||[]).slice().sort((a,b)=>b.at-a.at);
  if(!items.length){ el.innerHTML = '<div class="empty-mini">No changes logged yet.</div>'; return; }
  el.innerHTML = items.map(h=>`
    <div class="history-item">
      <div class="history-dot ${h.type}">${historyIcon(h.type)}</div>
      <div class="history-content">
        <div class="history-text">${h.text}</div>
        <div class="history-time">${new Date(h.at).toLocaleString([], { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' })}${h.by?' · '+escapeHtml(h.by.split('@')[0]):''}</div>
      </div>
    </div>`).join('');
}

// ═══════ FOLLOW-UP SPOTLIGHT ═══════
function followUpUrgencyClass(ts){
  if(ts==null) return 'none';
  const diff = ts - Date.now();
  if(diff < 0) return 'overdue';
  if(diff < 24*60*60*1000) return 'today';
  return 'upcoming';
}
function relativeFollowUpText(ts){
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs/60000);
  const hrs = Math.round(abs/3600000);
  const days = Math.round(abs/86400000);
  let phrase;
  if(mins<60) phrase = mins<=1 ? '1 minute' : mins+' minutes';
  else if(hrs<24) phrase = hrs===1 ? '1 hour' : hrs+' hours';
  else phrase = days===1 ? '1 day' : days+' days';
  return diff<0 ? `Overdue by ${phrase}` : `In ${phrase}`;
}
function renderFollowUpSpotlight(l){
  const el = document.getElementById('dpFuSpotlight');
  if(!el) return;
  if(l.followUpAt){
    const cls = followUpUrgencyClass(l.followUpAt);
    const when = new Date(l.followUpAt).toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const icoMap = { overdue:'⏰', today:'⏰', upcoming:'📅' };
    const labelMap = { overdue:'OVERDUE FOLLOW-UP', today:'FOLLOW-UP DUE TODAY', upcoming:'NEXT FOLLOW-UP' };
    el.innerHTML = `
      <div class="fu-spotlight ${cls}">
        <div class="fu-spotlight-ico">${icoMap[cls]}</div>
        <div class="fu-spotlight-main">
          <div class="fu-spotlight-label">${labelMap[cls]}</div>
          <div class="fu-spotlight-when">${when}</div>
          <div class="fu-spotlight-rel">${relativeFollowUpText(l.followUpAt)}</div>
        </div>
        <div class="fu-spotlight-actions">
          <button type="button" class="fu-spotlight-btn done" onclick="openFollowUpLogModal('${l.id}')">✓ Followed Up</button>
          <button type="button" class="fu-spotlight-btn remove" onclick="removeFollowUp('${l.id}')">✕ Remove</button>
        </div>
      </div>`;
  } else {
    el.innerHTML = `
      <div class="fu-spotlight none">
        <div class="fu-spotlight-ico">🗓️</div>
        <div class="fu-spotlight-main">
          <div class="fu-spotlight-label">No follow-up scheduled</div>
          <div class="fu-spotlight-when">Set a date to stay on top of this lead</div>
        </div>
        <div class="fu-spotlight-actions">
          <button type="button" class="fu-spotlight-btn done" onclick="openFollowUpLogModal('${l.id}')">+ Schedule</button>
        </div>
      </div>`;
  }
}

// ═══════ KANBAN BOARD ═══════
function renderBoard(){
  const board = document.getElementById('kanbanView');
  if(!stages.length){
    board.innerHTML = '<div class="nores"><div class="nores-i">🗂️</div><div class="nores-t">No pipeline stages yet</div></div>';
    return;
  }
  board.innerHTML = `<div class="kanban">${stages.map(stage=>{
    const colLeads = filteredLeads.filter(l=>l.stageId===stage.id);
    return `
    <div class="kcol">
      <div class="kcol-hdr">
        <div class="kcol-title"><span class="kcol-dot" style="background:${stage.color}"></span>${escapeHtml(stage.name)}</div>
        <div class="kcol-count">${colLeads.length}</div>
      </div>
      <div class="kcol-body" ondragover="onColDragOver(event)" ondragleave="onColDragLeave(event)" ondrop="onColDrop(event,'${stage.id}')">
        ${colLeads.length ? colLeads.map(l=>leadCardHtml(l)).join('') : '<div class="kcol-empty">No leads</div>'}
      </div>
    </div>`;
  }).join('')}</div>`;
}

let draggedLeadId = null;
function onCardDragStart(e, id){
  draggedLeadId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  e.currentTarget.classList.add('dragging');
}
function onCardDragEnd(e){
  e.currentTarget.classList.remove('dragging');
  draggedLeadId = null;
  document.querySelectorAll('.kcol-body.drag-over').forEach(el=>el.classList.remove('drag-over'));
}
function onColDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function onColDragLeave(e){
  e.currentTarget.classList.remove('drag-over');
}
function onColDrop(e, stageId){
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const id = draggedLeadId || e.dataTransfer.getData('text/plain');
  if(id) changeStage(id, stageId);
}

function leadCardHtml(l){
  const stage = stageById(l.stageId);
  const next = nextStageId(l.stageId);
  const nextStage = next ? stageById(next) : null;
  return `
  <div class="lcard" draggable="true" ondragstart="onCardDragStart(event,'${l.id}')" ondragend="onCardDragEnd(event)" onclick="openDetail('${l.id}')">
    <div class="lcard-top">
      <div class="lcard-name">${escapeHtml(l.name)}</div>
      <div class="lcard-src ${l.source}">${l.source==='meta'?'Meta':'Manual'}</div>
    </div>
    <div class="lcard-meta">
      ${l.phone?`<div>📞 ${escapeHtml(l.phone)}</div>`:''}
      ${l.channel?`<div>${channelLabel(l.channel)}</div>`:''}
      ${l.enquiryType?`<div>🏷️ ${escapeHtml(l.enquiryType)}</div>`:''}
      ${l.propertyInterest?`<div>🏠 ${escapeHtml(l.propertyInterest)}</div>`:''}
    </div>
    ${followUpBadge(l)}
    <div class="lcard-foot">
      <div class="lcard-time">${timeAgo(l.updatedAt||l.createdAt)}${l.updatedBy?' · '+escapeHtml(l.updatedBy.split('@')[0]):''}</div>
      ${nextStage?`<button class="lcard-next" onclick="event.stopPropagation();changeStage('${l.id}','${next}')">→ ${nextStage.name}</button>`:''}
    </div>
  </div>`;
}

// ═══════ LIST VIEW (sortable + per-column filter, Excel-style) ═══════
function sourceLabel(s){ return s==='meta'?'📱 Meta':(s==='whatsapp_bot'?'🤖 WhatsApp Bot':'✍️ Manual'); }
const LIST_COLUMNS = [
  { key:'name', label:'Name', filterable:true, get:l=>l.name||'', sortVal:l=>(l.name||'').toLowerCase() },
  { key:'contact', label:'Contact', filterable:false, get:l=>l.phone||l.email||'—', sortVal:l=>(l.phone||l.email||'').toLowerCase() },
  { key:'channel', label:'Channel', filterable:true, get:l=>l.channel?channelLabel(l.channel):'—', sortVal:l=>l.channel?channelLabel(l.channel):'' },
  { key:'enquiryType', label:'Type', filterable:true, get:l=>l.enquiryType||'—', sortVal:l=>(l.enquiryType||'').toLowerCase() },
  { key:'propertyInterest', label:'Interest', filterable:true, get:l=>l.propertyInterest||'—', sortVal:l=>(l.propertyInterest||'').toLowerCase() },
  { key:'stage', label:'Stage', filterable:true, get:l=>{ const s=stageById(l.stageId); return s?s.name:'—'; }, sortVal:l=>{ const s=stageById(l.stageId); return s?s.name.toLowerCase():''; } },
  { key:'source', label:'Source', filterable:true, get:l=>sourceLabel(l.source), sortVal:l=>sourceLabel(l.source).toLowerCase() },
  { key:'followUpAt', label:'Follow-up', filterable:false, get:l=>l.followUpAt?new Date(l.followUpAt).toLocaleDateString():'—', sortVal:l=>l.followUpAt||0 },
  { key:'updatedAt', label:'Updated', filterable:false, get:l=>timeAgo(l.updatedAt||l.createdAt), sortVal:l=>l.updatedAt||l.createdAt||0 },
  { key:'updatedBy', label:'Updated By', filterable:true, get:l=>l.updatedBy||'—', sortVal:l=>(l.updatedBy||'').toLowerCase() }
];
let listSortCol = null;
let listSortDir = 'asc';
let listColumnFilters = {}; // key -> Set of allowed display values; absent = no filter
let openFilterCol = null;

// Filter dropdowns list values from filteredLeads (the global search/source
// filter), not from other columns' filters — a lightweight approximation of
// Excel's cascading filters, good enough for this dataset's size.
function listFilterOptions(col){
  const counts = new Map();
  filteredLeads.forEach(l=>{
    const v = col.get(l);
    counts.set(v, (counts.get(v)||0)+1);
  });
  return Array.from(counts.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
}
function passesColumnFilters(l){
  return LIST_COLUMNS.every(col=>{
    if(!col.filterable) return true;
    const set = listColumnFilters[col.key];
    if(!set) return true;
    return set.has(col.get(l));
  });
}
function toggleListSort(key){
  if(listSortCol===key){ listSortDir = listSortDir==='asc' ? 'desc' : 'asc'; }
  else { listSortCol = key; listSortDir = 'asc'; }
  renderList();
}
function toggleListFilter(key, ev){
  if(ev) ev.stopPropagation();
  openFilterCol = openFilterCol===key ? null : key;
  renderList();
}
function toggleListFilterValue(key, value){
  let set = listColumnFilters[key];
  if(!set){
    const col = LIST_COLUMNS.find(c=>c.key===key);
    set = new Set(listFilterOptions(col).map(([v])=>v));
    listColumnFilters[key] = set;
  }
  if(set.has(value)) set.delete(value); else set.add(value);
  renderList();
}
function selectAllListFilter(key){ delete listColumnFilters[key]; renderList(); }
function clearListFilterToNone(key){ listColumnFilters[key] = new Set(); renderList(); }
document.addEventListener('click', ()=>{
  if(openFilterCol){ openFilterCol = null; renderList(); }
});

function renderFilterDropdown(col){
  const options = listFilterOptions(col);
  const optsHtml = options.length ? options.map(([value,count])=>{
    const checked = isFilterValueChecked(col.key, value) ? 'checked' : '';
    return `<label class="lv-filter-opt">
      <input type="checkbox" ${checked} data-val="${escapeHtml(value)}" onclick="toggleListFilterValue('${col.key}', this.dataset.val)">
      <span>${escapeHtml(value)||'(blank)'}</span>
      <span class="lv-filter-count">${count}</span>
    </label>`;
  }).join('') : '<div class="lv-filter-empty">No values</div>';
  return `<div class="lv-filter-pop" onclick="event.stopPropagation()">
    <div class="lv-filter-actions">
      <button onclick="selectAllListFilter('${col.key}')">Select all</button>
      <button onclick="clearListFilterToNone('${col.key}')">Clear</button>
    </div>
    <div class="lv-filter-opts">${optsHtml}</div>
  </div>`;
}
function isFilterValueChecked(key, value){
  const set = listColumnFilters[key];
  return !set || set.has(value);
}

function renderList(){
  const wrap = document.getElementById('listView');
  if(!filteredLeads.length){
    wrap.innerHTML = '<div class="nores"><div class="nores-i">🗂️</div><div class="nores-t">No leads match your filters</div></div>';
    return;
  }

  let rows = filteredLeads.filter(passesColumnFilters);
  if(listSortCol){
    const col = LIST_COLUMNS.find(c=>c.key===listSortCol);
    rows = rows.slice().sort((a,b)=>{
      const av = col.sortVal(a), bv = col.sortVal(b);
      const cmp = (typeof av==='number' && typeof bv==='number') ? av-bv : String(av).localeCompare(String(bv));
      return listSortDir==='asc' ? cmp : -cmp;
    });
  }

  const theadHtml = `<tr>${LIST_COLUMNS.map(col=>{
    const sortIcon = listSortCol===col.key ? (listSortDir==='asc'?'▲':'▼') : '↕';
    const filterActive = listColumnFilters[col.key] ? ' active' : '';
    const filterBtn = col.filterable ? `<button class="lv-filter-btn${filterActive}" onclick="toggleListFilter('${col.key}',event)">▾</button>` : '';
    const dropdown = (col.filterable && openFilterCol===col.key) ? renderFilterDropdown(col) : '';
    return `<th>
      <div class="lv-th">
        <span class="lv-th-label" onclick="toggleListSort('${col.key}')">${col.label} <span class="lv-sort-ico">${sortIcon}</span></span>
        ${filterBtn}
      </div>
      ${dropdown}
    </th>`;
  }).join('')}</tr>`;

  if(!rows.length){
    wrap.innerHTML = `<div class="list-view"><table><thead>${theadHtml}</thead></table></div>
      <div class="nores"><div class="nores-i">🔍</div><div class="nores-t">No leads match the current column filters</div></div>`;
    return;
  }

  wrap.innerHTML = `<div class="list-view"><table>
    <thead>${theadHtml}</thead>
    <tbody>${rows.map(l=>{
      const stage = stageById(l.stageId);
      return `<tr onclick="openDetail('${l.id}')">
        <td><b>${escapeHtml(l.name)}</b></td>
        <td>${escapeHtml(l.phone||l.email||'—')}</td>
        <td>${l.channel?channelLabel(l.channel):'—'}</td>
        <td>${escapeHtml(l.enquiryType||'—')}</td>
        <td>${escapeHtml(l.propertyInterest||'—')}</td>
        <td>${stage?`<span class="stage-pill" style="background:${stage.color}22;color:${stage.color}">${escapeHtml(stage.name)}</span>`:'—'}</td>
        <td>${sourceLabel(l.source)}</td>
        <td>${l.followUpAt?new Date(l.followUpAt).toLocaleDateString():'—'}</td>
        <td>${timeAgo(l.updatedAt||l.createdAt)}</td>
        <td>${l.updatedBy?escapeHtml(l.updatedBy):'—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

// ═══════ FOLLOW-UPS VIEW (date-grouped, calendar-style) ═══════
const FU_GROUP_DEFS = [
  { key:'overdue', label:'⚠️ Overdue' },
  { key:'today', label:'📅 Today' },
  { key:'tomorrow', label:'🌤️ Tomorrow' },
  { key:'week', label:'🗓️ This Week' },
  { key:'later', label:'📆 Later' }
];
function followupBuckets(list){
  const now = Date.now();
  const startOfToday = new Date(new Date().setHours(0,0,0,0)).getTime();
  const startOfTomorrow = startOfToday + 86400000;
  const startOfDayAfter = startOfTomorrow + 86400000;
  const startOfNextWeek = startOfToday + 7*86400000;
  const buckets = { overdue:[], today:[], tomorrow:[], week:[], later:[] };
  list.forEach(l=>{
    const t = l.followUpAt;
    if(t < now) buckets.overdue.push(l);
    else if(t < startOfTomorrow) buckets.today.push(l);
    else if(t < startOfDayAfter) buckets.tomorrow.push(l);
    else if(t < startOfNextWeek) buckets.week.push(l);
    else buckets.later.push(l);
  });
  Object.values(buckets).forEach(arr=>arr.sort((a,b)=>a.followUpAt-b.followUpAt));
  return buckets;
}
function updateFollowupBadge(){
  const badge = document.getElementById('fuBadge');
  if(!badge) return;
  const withFollowup = leads.filter(l=>l.followUpAt);
  if(!withFollowup.length){ badge.style.display='none'; return; }
  const buckets = followupBuckets(withFollowup);
  const count = buckets.overdue.length + buckets.today.length;
  if(count>0){
    badge.textContent = count;
    badge.style.display='';
    badge.classList.toggle('urgent', buckets.overdue.length>0);
  } else {
    badge.style.display='none';
  }
}
function followupRowHtml(l, bucketKey){
  const stage = stageById(l.stageId);
  const latest = (l.notes||[]).slice().sort((a,b)=>b.createdAt-a.createdAt)[0];
  const waUrl = waHref(l.phone);
  const fuDate = new Date(l.followUpAt);
  const timeLabel = (bucketKey==='today' || bucketKey==='overdue')
    ? fuDate.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
    : fuDate.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
  return `<div class="fu-row" onclick="openDetail('${l.id}')">
    <div class="fu-row-main">
      <div class="fu-name-row">
        <span class="fu-name">${escapeHtml(l.name)}</span>
        ${stage?`<span class="stage-pill sm" style="background:${stage.color}22;color:${stage.color}">${escapeHtml(stage.name)}</span>`:''}
      </div>
      <div class="fu-meta">
        ${l.phone?`<span>📞 ${escapeHtml(l.phone)}</span>`:''}
        ${l.propertyInterest?`<span>🏠 ${escapeHtml(l.propertyInterest)}</span>`:''}
      </div>
      <div class="fu-note ${latest?'':'empty'}">${latest ? `“${escapeHtml(latest.text)}” <span class="fu-note-time">— ${timeAgo(latest.createdAt)}</span>` : 'No notes yet'}</div>
    </div>
    <div class="fu-row-side">
      <div class="fu-time ${bucketKey}">${timeLabel}</div>
      <button class="fu-action-btn done" onclick="event.stopPropagation();openFollowUpLogModal('${l.id}')" title="Log follow-up">✓</button>
      <button class="fu-action-btn remove" onclick="event.stopPropagation();removeFollowUp('${l.id}')" title="Remove follow-up">✕</button>
      ${waUrl?`<a class="fu-wa-btn" href="${waUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">💬</a>`:''}
    </div>
  </div>`;
}
function renderFollowups(){
  const wrap = document.getElementById('followupsView');
  const withFollowup = filteredLeads.filter(l=>l.followUpAt);
  if(!withFollowup.length){
    wrap.innerHTML = '<div class="nores"><div class="nores-i">📅</div><div class="nores-t">No follow-ups scheduled</div><div class="nores-sub">Set one from a lead\'s Notes &amp; Follow-ups section.</div></div>';
    return;
  }
  const buckets = followupBuckets(withFollowup);
  const groupsHtml = FU_GROUP_DEFS.map(g=>{
    const arr = buckets[g.key];
    if(!arr.length) return '';
    return `<div class="fu-group">
      <div class="fu-group-hdr ${g.key}">${g.label} <span class="fu-count">${arr.length}</span></div>
      <div class="fu-rows">${arr.map(l=>followupRowHtml(l, g.key)).join('')}</div>
    </div>`;
  }).join('');
  wrap.innerHTML = `<div class="fu-wrap">${groupsHtml}</div>`;
}

function changeStage(id, stageId){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  if(l.stageId !== stageId){
    const oldStage = stageById(l.stageId);
    const newStage = stageById(stageId);
    if(oldStage && newStage){
      addHistory(l, 'stage', `Stage changed from <b>${escapeHtml(oldStage.name)}</b> to <b>${escapeHtml(newStage.name)}</b>`);
    }
  }
  l.stageId = stageId;
  l.updatedAt = Date.now();
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  applyFilters();
  persistLead(l);
  if(currentDetailId===id){ renderDetailStageRow(l); renderHistory(l); }
}

// ═══════ ADD / EDIT LEAD MODAL ═══════
function renderEnquiryTypeOptions(selected){
  const sel = document.getElementById('lmEnquiryType');
  const opts = enquiryTypes.map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  sel.innerHTML = `<option value="">Select type…</option>${opts}<option value="__add_new__">+ Add new type…</option>`;
  sel.value = selected && enquiryTypes.includes(selected) ? selected : '';
}
function renderStageOptions(selected){
  const sel = document.getElementById('lmStage');
  if(!stages.length){ sel.innerHTML = '<option value="">No stages yet</option>'; return; }
  sel.innerHTML = stages.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  sel.value = (selected && stages.some(s=>s.id===selected)) ? selected : stages[0].id;
}
function hideNewTypeRow(){
  document.getElementById('lmNewTypeRow').style.display='none';
  document.getElementById('lmNewEnquiryType').value='';
}
function onEnquiryTypeSelectChange(){
  const sel = document.getElementById('lmEnquiryType');
  if(sel.value === '__add_new__'){
    document.getElementById('lmNewTypeRow').style.display='flex';
    document.getElementById('lmNewEnquiryType').focus();
  } else {
    hideNewTypeRow();
  }
}
function confirmAddEnquiryType(){
  const inp = document.getElementById('lmNewEnquiryType');
  const val = inp.value.trim();
  if(!val) return;
  const existing = enquiryTypes.find(t=>t.toLowerCase()===val.toLowerCase());
  if(!existing){
    enquiryTypes.push(val);
    window.crmFirebase.saveEnquiryTypes(enquiryTypes);
  }
  renderEnquiryTypeOptions(existing || val);
  hideNewTypeRow();
}

function openAddLeadModal(){
  lModalMode='add'; lModalEditId=null;
  document.getElementById('lmTitle').textContent='Add New Lead';
  document.getElementById('lmChannel').value='';
  renderStageOptions('');
  document.getElementById('lmName').value='';
  document.getElementById('lmPhone').value='';
  document.getElementById('lmEmail').value='';
  renderEnquiryTypeOptions('');
  hideNewTypeRow();
  document.getElementById('lmInterest').value='';
  document.getElementById('lmBudget').value='';
  document.getElementById('lmFollowUpDate').value='';
  document.getElementById('lmFollowUpTime').value='';
  document.getElementById('lmNotes').value='';
  lmModalContactAt = Date.now();
  document.getElementById('lmContactTimeDisplay').textContent = new Date(lmModalContactAt).toLocaleString();
  document.getElementById('lmErr').classList.remove('show');
  document.getElementById('lModal').classList.add('open');
}
function openEditLeadModal(id){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  lModalMode='edit'; lModalEditId=id;
  document.getElementById('lmTitle').textContent='Edit Lead';
  document.getElementById('lmChannel').value=l.channel||'';
  renderStageOptions(l.stageId||'');
  document.getElementById('lmName').value=l.name||'';
  document.getElementById('lmPhone').value=l.phone||'';
  document.getElementById('lmEmail').value=l.email||'';
  renderEnquiryTypeOptions(l.enquiryType||'');
  hideNewTypeRow();
  document.getElementById('lmInterest').value=l.propertyInterest||'';
  document.getElementById('lmBudget').value=l.budget||'';
  const fu = l.followUpAt ? new Date(l.followUpAt) : null;
  document.getElementById('lmFollowUpDate').value = fu ? toDateInputValue(fu) : '';
  document.getElementById('lmFollowUpTime').value = fu ? toTimeInputValue(fu) : '';
  document.getElementById('lmNotes').value='';
  lmModalContactAt = l.contactAt || l.createdAt || Date.now();
  document.getElementById('lmContactTimeDisplay').textContent = new Date(lmModalContactAt).toLocaleString();
  document.getElementById('lmErr').classList.remove('show');
  document.getElementById('lModal').classList.add('open');
}
function closeLeadModal(){
  document.getElementById('lModal').classList.remove('open');
  hideNewTypeRow();
}
// Future-date rule: with a time given, the exact moment must be after now;
// with only a date given, it must be strictly after today (a bare "today"
// reads as already past since we can't know which part of today they meant).
function computeFollowUpAt(dateStr, timeStr){
  if(timeStr){
    const dt = new Date(`${dateStr}T${timeStr}:00`);
    if(isNaN(dt.getTime()) || dt.getTime() <= Date.now()){
      return { error: 'Follow-up date & time must be in the future.' };
    }
    return { value: dt.getTime() };
  }
  if(dateStr <= toDateInputValue(new Date())){
    return { error: 'Follow-up date must be a future date (add a time if you mean later today).' };
  }
  return { value: new Date(`${dateStr}T00:00:00`).getTime() };
}
function saveLeadModal(){
  const errBox = document.getElementById('lmErr');
  const showErr = (msg) => { errBox.textContent = msg; errBox.classList.add('show'); };
  errBox.classList.remove('show');

  const channel = document.getElementById('lmChannel').value;
  const stageId = document.getElementById('lmStage').value || (stages.length ? stages[0].id : null);
  const name = document.getElementById('lmName').value.trim();
  const phone = document.getElementById('lmPhone').value.trim();
  const email = document.getElementById('lmEmail').value.trim();
  const enquiryType = document.getElementById('lmEnquiryType').value;
  const propertyInterest = document.getElementById('lmInterest').value.trim();
  const budget = document.getElementById('lmBudget').value.trim();
  const followUpDate = document.getElementById('lmFollowUpDate').value;
  const followUpTime = document.getElementById('lmFollowUpTime').value;
  const noteText = document.getElementById('lmNotes').value.trim();

  if(!channel){ showErr('Please select a channel.'); return; }
  if(!name){ showErr('Name is required.'); return; }
  if(!phone){ showErr('Phone number is required.'); return; }
  if(!enquiryType || enquiryType==='__add_new__'){ showErr('Please select an enquiry type.'); return; }
  if(!propertyInterest){ showErr('Property / Locality is required.'); return; }

  let followUpAt = null;
  if(followUpDate){
    const r = computeFollowUpAt(followUpDate, followUpTime);
    if(r.error){ showErr(r.error); return; }
    followUpAt = r.value;
  }

  const now = Date.now();
  const contactAt = lmModalContactAt || now;

  if(lModalMode==='add'){
    const l = {
      id: 'lead_'+now,
      channel, name, phone, email, enquiryType, propertyInterest, budget,
      source: 'manual',
      stageId,
      notes: [],
      history: [],
      detailsSent: false,
      contactAt,
      followUpAt,
      createdAt: now,
      updatedAt: now,
      createdBy: currentUserEmail || null,
      updatedBy: currentUserEmail || null
    };
    addHistory(l, 'created', `Lead added via <b>${escapeHtml(channelLabel(channel))}</b>`);
    if(noteText) l.notes.push({ id:'n'+now, text: noteText, createdAt: now, by: currentUserEmail || null });
    leads.unshift(l);
    showToast('✓ Enquiry saved');
    persistLead(l);
  } else {
    const l = leads.find(x=>x.id===lModalEditId);
    if(l){
      const diffs = [];
      const diffField = (label, oldVal, newVal) => {
        if((oldVal||'') !== (newVal||'')){
          diffs.push({ type:'field', text:`${label} changed from <b>${escapeHtml(oldVal||'—')}</b> to <b>${escapeHtml(newVal||'—')}</b>` });
        }
      };
      diffField('Channel', channelLabel(l.channel), channelLabel(channel));
      diffField('Name', l.name, name);
      diffField('Phone', l.phone, phone);
      diffField('Email', l.email, email);
      diffField('Enquiry type', l.enquiryType, enquiryType);
      diffField('Property / Locality', l.propertyInterest, propertyInterest);
      diffField('Budget', l.budget, budget);
      if((l.followUpAt||null) !== (followUpAt||null)){
        if(followUpAt){
          const when = new Date(followUpAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
          diffs.push({ type:'followup', text:`Next follow-up ${l.followUpAt?'changed to':'set for'} <b>${when}</b>` });
        } else {
          diffs.push({ type:'followup-removed', text:'Follow-up removed' });
        }
      }

      l.channel=channel; l.stageId=stageId; l.name=name; l.phone=phone; l.email=email;
      l.enquiryType=enquiryType; l.propertyInterest=propertyInterest; l.budget=budget;
      l.contactAt = l.contactAt || contactAt;
      l.followUpAt = followUpAt;
      l.updatedAt = now;
      l.updatedBy = currentUserEmail || null;
      l.notes = l.notes || [];
      diffs.forEach(d=>addHistory(l, d.type, d.text));
      if(noteText) l.notes.push({ id:'n'+now, text: noteText, createdAt: now, by: currentUserEmail || null });
      showToast('✓ Enquiry updated');
      persistLead(l);
    }
  }
  closeLeadModal();
  refreshAll();
  if(lModalMode==='edit') openDetail(lModalEditId);
}

function deleteLead(id){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  if(!confirm(`Delete lead "${l.name}"? This cannot be undone.`)) return;
  leads = leads.filter(x=>x.id!==id);
  closeDetail();
  refreshAll();
  showToast('Lead deleted');
  window.crmFirebase.deleteLead(id);
}

// ═══════ EXPORT ═══════
function isToday(ts){
  if(!ts) return false;
  const d = new Date(ts), now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
}
const EXPORT_SCOPE_LABELS = {
  all: 'all', created_today: 'created-today', movement_today: 'movement-today', date_range: 'date-range'
};
function openExportModal(){
  document.querySelector('input[name="exportScope"][value="all"]').checked = true;
  document.getElementById('exportDateFrom').value = '';
  document.getElementById('exportDateTo').value = '';
  document.getElementById('exportDateRangeRow').style.display = 'none';
  document.getElementById('exportErr').classList.remove('show');
  updateExportCount();
  document.getElementById('exportModal').classList.add('open');
}
function closeExportModal(){
  document.getElementById('exportModal').classList.remove('open');
}
function onExportScopeChange(){
  const scope = document.querySelector('input[name="exportScope"]:checked').value;
  document.getElementById('exportDateRangeRow').style.display = scope==='date_range' ? 'flex' : 'none';
  updateExportCount();
}
// Returns the matching leads, or null when a date-range scope is missing a
// bound — the caller distinguishes "0 matches" from "filter incomplete."
function getExportLeads(){
  const scope = document.querySelector('input[name="exportScope"]:checked').value;
  if(scope==='created_today') return leads.filter(l=>isToday(l.createdAt));
  if(scope==='movement_today') return leads.filter(l=>isToday(l.updatedAt));
  if(scope==='date_range'){
    const fromStr = document.getElementById('exportDateFrom').value;
    const toStr = document.getElementById('exportDateTo').value;
    if(!fromStr || !toStr) return null;
    const from = new Date(`${fromStr}T00:00:00`).getTime();
    const to = new Date(`${toStr}T23:59:59.999`).getTime();
    return leads.filter(l=>l.createdAt>=from && l.createdAt<=to);
  }
  return leads;
}
function updateExportCount(){
  const countEl = document.getElementById('exportCount');
  const result = getExportLeads();
  countEl.textContent = result===null ? 'Pick both a from and to date.' : `${result.length} lead${result.length===1?'':'s'} will be exported.`;
}
function runExport(){
  if(typeof XLSX === 'undefined'){ showToast('Export library failed to load — check your connection and retry'); return; }
  const errBox = document.getElementById('exportErr');
  errBox.classList.remove('show');

  const scope = document.querySelector('input[name="exportScope"]:checked').value;
  if(scope==='date_range'){
    const fromStr = document.getElementById('exportDateFrom').value;
    const toStr = document.getElementById('exportDateTo').value;
    if(!fromStr || !toStr){ errBox.textContent='Pick both a from and to date.'; errBox.classList.add('show'); return; }
    if(fromStr > toStr){ errBox.textContent='"From" date must be before "To" date.'; errBox.classList.add('show'); return; }
  }

  const rows = getExportLeads();
  if(!rows || !rows.length){ errBox.textContent='No leads match this filter.'; errBox.classList.add('show'); return; }

  const leadRows = rows.map(l=>{
    const stage = stageById(l.stageId);
    const notes = (l.notes||[]).slice().sort((a,b)=>a.createdAt-b.createdAt);
    const notesSummary = notes.map(n=>`[${new Date(n.createdAt).toLocaleString()}${n.by?' · '+n.by:''}] ${n.text}`).join('\n');
    return {
      'Name': l.name || '',
      'Phone': l.phone || '',
      'Email': l.email || '',
      'Channel': l.channel ? channelLabel(l.channel) : '',
      'Enquiry Type': l.enquiryType || '',
      'Property / Locality': l.propertyInterest || '',
      'Budget': l.budget || '',
      'Stage': stage ? stage.name : '',
      'Source': sourceLabel(l.source),
      'Sent Details': l.detailsSent === true ? 'Yes' : 'No',
      'Time of Contact': l.contactAt ? new Date(l.contactAt).toLocaleString() : '',
      'Follow-up': l.followUpAt ? new Date(l.followUpAt).toLocaleString() : '',
      'Added': l.createdAt ? new Date(l.createdAt).toLocaleString() : '',
      'Added By': l.createdBy || '',
      'Last Updated': l.updatedAt ? new Date(l.updatedAt).toLocaleString() : '',
      'Last Updated By': l.updatedBy || '',
      'Notes Count': notes.length,
      'Notes': notesSummary
    };
  });

  const wb = XLSX.utils.book_new();
  const leadsSheet = XLSX.utils.json_to_sheet(leadRows);
  leadsSheet['!cols'] = [
    {wch:20},{wch:14},{wch:22},{wch:14},{wch:16},{wch:24},{wch:12},{wch:14},
    {wch:16},{wch:12},{wch:19},{wch:19},{wch:19},{wch:22},{wch:19},{wch:22},{wch:10},{wch:50}
  ];
  XLSX.utils.book_append_sheet(wb, leadsSheet, 'Leads');

  const stamp = new Date().toISOString().slice(0,10);
  const label = EXPORT_SCOPE_LABELS[scope] || 'all';
  XLSX.writeFile(wb, `3pin-leads-export-${label}-${stamp}.xlsx`);
  closeExportModal();
  showToast('✓ Export downloaded');
}

// ═══════ DETAIL PANEL ═══════
function openDetail(id){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  currentDetailId = id;
  document.getElementById('dpName').textContent = l.name;
  document.getElementById('dpSub').textContent = l.source==='meta' ? 'Lead via Meta (Facebook/Instagram) Ads' : 'Manually added lead';
  renderAiSummary(l);

  const waBtn = document.getElementById('dpWaBtn');
  const waUrl = waHref(l.phone);
  waBtn.style.display = waUrl ? '' : 'none';
  if(waUrl) waBtn.href = waUrl;

  renderDetailStageRow(l);
  renderFollowUpSpotlight(l);

  const infoHtml = `
    ${l.channel?`<div class="info-b"><div class="info-b-l">Channel</div><div class="info-b-v">${channelLabel(l.channel)}</div></div>`:''}
    ${l.phone?`<div class="info-b"><div class="info-b-l">Phone</div><div class="info-b-v"><a href="tel:${encodeURIComponent(l.phone)}">${escapeHtml(l.phone)}</a></div></div>`:''}
    ${l.email?`<div class="info-b"><div class="info-b-l">Email</div><div class="info-b-v"><a href="mailto:${encodeURIComponent(l.email)}">${escapeHtml(l.email)}</a></div></div>`:''}
    ${l.enquiryType?`<div class="info-b"><div class="info-b-l">Enquiry Type</div><div class="info-b-v">${escapeHtml(l.enquiryType)}</div></div>`:''}
    ${l.propertyInterest?`<div class="info-b highlight"><div class="info-b-l">Property / Locality</div><div class="info-b-v">${escapeHtml(l.propertyInterest)}</div></div>`:''}
    ${l.budget?`<div class="info-b highlight"><div class="info-b-l">Budget</div><div class="info-b-v">${escapeHtml(l.budget)}</div></div>`:''}
    ${l.formId?`<div class="info-b"><div class="info-b-l">Meta Form ID</div><div class="info-b-v">${escapeHtml(l.formId)}</div></div>`:''}
    ${l.adId?`<div class="info-b"><div class="info-b-l">Meta Ad ID</div><div class="info-b-v">${escapeHtml(l.adId)}</div></div>`:''}
  `;
  document.getElementById('dpInfo').innerHTML = infoHtml;

  const metaHtml = `
    <div class="dp-meta-item"><span class="dp-meta-l">Contacted</span><span class="dp-meta-v">${new Date(l.contactAt||l.createdAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</span></div>
    <div class="dp-meta-item"><span class="dp-meta-l">Added</span><span class="dp-meta-v">${new Date(l.createdAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</span></div>
    ${l.createdBy?`<div class="dp-meta-item"><span class="dp-meta-l">By</span><span class="dp-meta-v">${escapeHtml(l.createdBy.split('@')[0])}</span></div>`:''}
    ${l.updatedBy?`<div class="dp-meta-item"><span class="dp-meta-l">Updated by</span><span class="dp-meta-v">${escapeHtml(l.updatedBy.split('@')[0])}</span></div>`:''}
  `;
  document.getElementById('dpMeta').innerHTML = metaHtml;

  const rawSec = document.getElementById('dpRawSec');
  if(l.source==='meta' && l.rawFieldData){
    rawSec.style.display='';
    document.getElementById('dpRaw').textContent = JSON.stringify(l.rawFieldData, null, 2);
  } else {
    rawSec.style.display='none';
  }

  renderNotes(l);
  renderNoteFollowUpFields(l);
  renderDetailsSentToggle(l);
  renderHistory(l);
  document.getElementById('dp').classList.add('open');
  window.scrollTo(0,0);
}
function renderDetailStageRow(l){
  const sel = document.getElementById('dpStageSel');
  sel.innerHTML = stages.map(s=>`<option value="${s.id}" ${s.id===l.stageId?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
  const stage = stageById(l.stageId);
  sel.style.borderColor = stage ? stage.color : '';
  sel.style.color = stage ? stage.color : '';
}
// Leads with no `detailsSent` field yet (everything created before this
// feature) read as "No" by default — same as an explicit false — so there's
// no migration needed and nothing forces an agent to set it.
function renderDetailsSentToggle(l){
  const wrap = document.getElementById('dpDetailsSentToggle');
  if(!wrap) return;
  const effective = l.detailsSent === true;
  wrap.querySelector('.yes').classList.toggle('active', effective);
  wrap.querySelector('.no').classList.toggle('active', !effective);
  wrap.classList.toggle('sent', effective);
  wrap.classList.toggle('not-sent', !effective);
}
function setDetailsSent(value){
  const l = leads.find(x=>x.id===currentDetailId);
  if(!l) return;
  const prevEffective = l.detailsSent === true;
  if(prevEffective === value) return;
  const label = v => v ? 'Yes' : 'No';
  addHistory(l, 'details-sent', `Sent details changed from <b>${label(prevEffective)}</b> to <b>${label(value)}</b>`);
  l.detailsSent = value;
  l.updatedAt = Date.now();
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  renderDetailsSentToggle(l);
  renderHistory(l);
  persistLead(l);
}
function onDetailStageChange(){
  const sel = document.getElementById('dpStageSel');
  changeStage(currentDetailId, sel.value);
}
function closeDetail(){
  document.getElementById('dp').classList.remove('open');
  currentDetailId = null;
}
function toggleRaw(){
  document.getElementById('dpRaw').classList.toggle('show');
}

// ═══════ NOTES ═══════
function renderNotes(l){
  const notes = l.notes || [];
  const html = notes.length ? notes.slice().reverse().map(n=>`
    <div class="note-item">
      <div class="note-meta">
        <span class="note-time">${new Date(n.createdAt).toLocaleString()}${n.by?' · '+escapeHtml(n.by):''}</span>
        <button class="note-delete" onclick="deleteNote('${l.id}','${n.id}')">×</button>
      </div>
      <div class="note-text">${escapeHtml(n.text)}</div>
    </div>`).join('') : '<div class="empty-mini">No notes yet — log a call or follow-up below.</div>';
  document.getElementById('notesPanel').innerHTML = html;
}
function renderNoteFollowUpFields(l){
  const fu = l.followUpAt ? new Date(l.followUpAt) : null;
  document.getElementById('noteFollowUpDate').value = fu ? toDateInputValue(fu) : '';
  document.getElementById('noteFollowUpTime').value = fu ? toTimeInputValue(fu) : '';
  const actions = document.getElementById('noteFuActions');
  if(actions) actions.style.display = l.followUpAt ? 'flex' : 'none';
}
function parseFollowUpRaw(dateStr, timeStr){
  if(!dateStr) return null;
  return timeStr ? new Date(`${dateStr}T${timeStr}:00`).getTime() : new Date(`${dateStr}T00:00:00`).getTime();
}
// Closes out a follow-up: log what happened AND set the next one in one
// step — a real estate agent almost always needs both ("called, still
// deciding on budget — check back in a week"), so this never silently
// wipes the date the way a bare "mark done" would. removeFollowUp() below
// stays fully separate for when a lead genuinely needs no more follow-up.
let fuLogLeadId = null;
function openFollowUpLogModal(leadId){
  const l = leads.find(x=>x.id===leadId);
  if(!l) return;
  fuLogLeadId = leadId;
  document.getElementById('fuLogLeadName').textContent = l.name;
  document.getElementById('fuLogNote').value = '';
  document.getElementById('fuLogDate').value = '';
  document.getElementById('fuLogTime').value = '';
  document.getElementById('fuLogErr').classList.remove('show');
  document.getElementById('fuLogModal').classList.add('open');
  document.getElementById('fuLogNote').focus();
}
function closeFollowUpLogModal(){
  document.getElementById('fuLogModal').classList.remove('open');
  fuLogLeadId = null;
}
// Real-estate follow-up cadence — tomorrow/3-day/week/fortnight covers the
// common "still deciding," "post-site-visit," and "nurture" cases without
// making the agent operate a date picker for every single lead.
function setFuLogPreset(days){
  const dateInp = document.getElementById('fuLogDate');
  const timeInp = document.getElementById('fuLogTime');
  if(days===null){ dateInp.value=''; timeInp.value=''; return; }
  const d = new Date();
  d.setDate(d.getDate()+days);
  dateInp.value = toDateInputValue(d);
}
function saveFollowUpLog(){
  const l = leads.find(x=>x.id===fuLogLeadId);
  if(!l) return;
  const errBox = document.getElementById('fuLogErr');
  errBox.classList.remove('show');

  const noteText = document.getElementById('fuLogNote').value.trim();
  const dateStr = document.getElementById('fuLogDate').value;
  const timeStr = document.getElementById('fuLogTime').value;

  let followUpAt = null;
  if(dateStr){
    const r = computeFollowUpAt(dateStr, timeStr);
    if(r.error){ errBox.textContent = r.error; errBox.classList.add('show'); return; }
    followUpAt = r.value;
  }

  const now = Date.now();
  if(noteText){
    l.notes = l.notes || [];
    l.notes.push({ id:'n'+now, text: noteText, createdAt: now, by: currentUserEmail || null });
    addHistory(l, 'followed-up', `Followed up — “${escapeHtml(noteText)}”`);
  } else {
    addHistory(l, 'followed-up', 'Marked as followed up');
  }
  const prevFollowUpAt = l.followUpAt;
  if((prevFollowUpAt||null) !== (followUpAt||null)){
    if(followUpAt){
      const when = new Date(followUpAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      addHistory(l, 'followup', `Next follow-up ${prevFollowUpAt?'changed to':'set for'} <b>${when}</b>`);
    } else {
      addHistory(l, 'followup-removed', 'Follow-up removed');
    }
  }
  l.followUpAt = followUpAt;
  l.updatedAt = now;
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  persistLead(l);
  closeFollowUpLogModal();
  refreshAll();
  showToast(followUpAt ? '✓ Logged — next follow-up set' : '✓ Logged — no further follow-up');
  if(currentDetailId===l.id){ renderNotes(l); renderNoteFollowUpFields(l); renderFollowUpSpotlight(l); renderHistory(l); }
}
function removeFollowUp(leadId){
  const l = leads.find(x=>x.id===leadId);
  if(!l) return;
  if(!confirm(`Remove the follow-up for "${l.name}"?`)) return;
  if(l.followUpAt) addHistory(l, 'followup-removed', 'Follow-up removed');
  l.followUpAt = null;
  l.updatedAt = Date.now();
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  persistLead(l);
  refreshAll();
  showToast('Follow-up removed');
  if(currentDetailId===leadId){ renderNoteFollowUpFields(l); renderFollowUpSpotlight(l); renderHistory(l); }
}
function addNote(){
  const inp = document.getElementById('noteInput');
  const text = inp.value.trim();
  if(!text) return;
  const l = leads.find(x=>x.id===currentDetailId);
  if(!l) return;

  const fuDateStr = document.getElementById('noteFollowUpDate').value;
  const fuTimeStr = document.getElementById('noteFollowUpTime').value;
  const currentAt = l.followUpAt || null;
  const candidateAt = parseFollowUpRaw(fuDateStr, fuTimeStr);
  let nextFollowUpAt = currentAt;
  // Only re-validate "must be future" when the agent actually changed the
  // date/time — leaving it as-is must never block saving a note, even if
  // that existing follow-up has since gone overdue.
  if(candidateAt !== currentAt){
    if(candidateAt === null){
      nextFollowUpAt = null;
    } else {
      const r = computeFollowUpAt(fuDateStr, fuTimeStr);
      if(r.error){ showToast(r.error); return; }
      nextFollowUpAt = r.value;
    }
  }

  const now = Date.now();
  l.notes = l.notes || [];
  l.notes.push({ id:'n'+now, text, createdAt: now, by: currentUserEmail || null });
  if(nextFollowUpAt !== currentAt){
    if(nextFollowUpAt){
      const when = new Date(nextFollowUpAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      addHistory(l, 'followup', `Next follow-up ${currentAt?'changed to':'set for'} <b>${when}</b>`);
    } else {
      addHistory(l, 'followup-removed', 'Follow-up removed');
    }
  }
  l.followUpAt = nextFollowUpAt;
  l.updatedAt = now;
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  inp.value='';
  renderNotes(l);
  renderNoteFollowUpFields(l);
  renderFollowUpSpotlight(l);
  renderHistory(l);
  applyFilters();
  persistLead(l);
}
function deleteNote(leadId, noteId){
  const l = leads.find(x=>x.id===leadId);
  if(!l) return;
  l.notes = (l.notes||[]).filter(n=>n.id!==noteId);
  l.updatedAt = Date.now();
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  renderNotes(l);
  persistLead(l);
}

// ═══════ STAGE MANAGER ═══════
const STAGE_COLORS = ['#1D4ED8','#B45309','#6D28D9','#15803D','#B91C1C','#0891B2','#DB2777'];
function openStageManager(){
  stageManagerDraft = stages.map(s=>({...s}));
  renderStageManagerRows();
  document.getElementById('stageModal').classList.add('open');
}
function closeStageManager(){
  document.getElementById('stageModal').classList.remove('open');
}
function renderStageManagerRows(){
  document.getElementById('stageRows').innerHTML = stageManagerDraft.map((s,i)=>`
    <div class="stage-row">
      <button class="stage-move" onclick="moveStageDraft(${i},-1)" ${i===0?'disabled style="opacity:.3"':''}>↑</button>
      <button class="stage-move" onclick="moveStageDraft(${i},1)" ${i===stageManagerDraft.length-1?'disabled style="opacity:.3"':''}>↓</button>
      <span class="stage-color" style="background:${s.color}" onclick="cycleStageColor(${i})"></span>
      <input type="text" value="${s.name}" oninput="renameStageDraft(${i}, this.value)">
      <button class="stage-del" onclick="deleteStageDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameStageDraft(i, val){ stageManagerDraft[i].name = val; }
function cycleStageColor(i){
  const cur = STAGE_COLORS.indexOf(stageManagerDraft[i].color);
  stageManagerDraft[i].color = STAGE_COLORS[(cur+1)%STAGE_COLORS.length];
  renderStageManagerRows();
}
function moveStageDraft(i, dir){
  const j = i+dir;
  if(j<0 || j>=stageManagerDraft.length) return;
  [stageManagerDraft[i], stageManagerDraft[j]] = [stageManagerDraft[j], stageManagerDraft[i]];
  renderStageManagerRows();
}
function deleteStageDraft(i){
  if(stageManagerDraft.length<=1){ showToast('Keep at least one stage'); return; }
  if(!confirm(`Delete stage "${stageManagerDraft[i].name}"? Leads in it will move to the first stage.`)) return;
  stageManagerDraft.splice(i,1);
  renderStageManagerRows();
}
function addStageDraft(){
  const inp = document.getElementById('newStageName');
  const name = inp.value.trim();
  if(!name) return;
  stageManagerDraft.push({ id:'stage_'+Date.now()+Math.random().toString(36).slice(2,6), name, color: STAGE_COLORS[stageManagerDraft.length % STAGE_COLORS.length] });
  inp.value='';
  renderStageManagerRows();
}
function saveStageManager(){
  const validIds = new Set(stageManagerDraft.map(s=>s.id));
  const fallbackId = stageManagerDraft[0] ? stageManagerDraft[0].id : null;
  leads.forEach(l=>{
    if(!validIds.has(l.stageId)){
      l.stageId = fallbackId;
      persistLead(l);
    }
  });
  stages = stageManagerDraft;
  window.crmFirebase.savePipeline(stages);
  closeStageManager();
  refreshAll();
  showToast('✓ Pipeline stages updated');
}

// ═══════ FOLLOW-UP WHATSAPP DIGEST MANAGER ═══════
function openDigestManager(){
  digestSettingsDraft = {
    enabled: digestSettings.enabled, recipients: digestSettings.recipients.slice(),
    emailEnabled: digestSettings.emailEnabled, emails: digestSettings.emails.slice()
  };
  document.getElementById('digestEnabled').checked = digestSettingsDraft.enabled;
  document.getElementById('digestEmailEnabled').checked = digestSettingsDraft.emailEnabled;
  renderDigestRecipientRows();
  renderDigestEmailRows();
  document.getElementById('digestModal').classList.add('open');
}
function closeDigestManager(){
  document.getElementById('digestModal').classList.remove('open');
}
function renderDigestRecipientRows(){
  document.getElementById('digestRecipientRows').innerHTML = digestSettingsDraft.recipients.map((r,i)=>`
    <div class="req-info-row">
      <input type="text" value="${escapeHtml(r)}" oninput="renameDigestRecipientDraft(${i}, this.value)">
      <button class="stage-del" onclick="removeDigestRecipientDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameDigestRecipientDraft(i, val){ digestSettingsDraft.recipients[i] = val; }
function removeDigestRecipientDraft(i){ digestSettingsDraft.recipients.splice(i,1); renderDigestRecipientRows(); }
function addDigestRecipientDraft(){
  const inp = document.getElementById('newDigestRecipient');
  const val = inp.value.trim();
  if(!val) return;
  digestSettingsDraft.recipients.push(val);
  inp.value='';
  renderDigestRecipientRows();
}
function renderDigestEmailRows(){
  document.getElementById('digestEmailRows').innerHTML = digestSettingsDraft.emails.map((r,i)=>`
    <div class="req-info-row">
      <input type="text" value="${escapeHtml(r)}" oninput="renameDigestEmailDraft(${i}, this.value)">
      <button class="stage-del" onclick="removeDigestEmailDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameDigestEmailDraft(i, val){ digestSettingsDraft.emails[i] = val; }
function removeDigestEmailDraft(i){ digestSettingsDraft.emails.splice(i,1); renderDigestEmailRows(); }
function addDigestEmailDraft(){
  const inp = document.getElementById('newDigestEmail');
  const val = inp.value.trim();
  if(!val) return;
  digestSettingsDraft.emails.push(val);
  inp.value='';
  renderDigestEmailRows();
}
function syncDigestDraftFromForm(){
  digestSettingsDraft.enabled = document.getElementById('digestEnabled').checked;
  digestSettingsDraft.emailEnabled = document.getElementById('digestEmailEnabled').checked;
}
function saveDigestManager(){
  syncDigestDraftFromForm();
  window.crmFirebase.saveFollowupDigestSettings(digestSettingsDraft.enabled, digestSettingsDraft.recipients, digestSettingsDraft.emailEnabled, digestSettingsDraft.emails);
  digestSettings = {
    enabled: digestSettingsDraft.enabled, recipients: digestSettingsDraft.recipients.slice(),
    emailEnabled: digestSettingsDraft.emailEnabled, emails: digestSettingsDraft.emails.slice()
  };
  closeDigestManager();
  showToast('✓ Digest settings saved');
}
async function sendDigestNow(){
  syncDigestDraftFromForm();
  if(!digestSettingsDraft.recipients.length && !digestSettingsDraft.emails.length){
    showToast('Add at least one WhatsApp number or email first');
    return;
  }
  saveDigestManager();
  showToast('Sending digest…');
  try{
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/followup-digest', {
      method:'POST',
      headers:{ 'Authorization':'Bearer '+idToken }
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){ showToast(data.error || 'Send failed'); return; }
    const results = data.results || [];
    const okCount = results.filter(r=>r.ok).length;
    const failCount = results.length - okCount;
    if(!results.length) showToast('Nothing to send — no recipients configured');
    else if(!failCount) showToast(`✓ Digest sent to ${okCount} recipient${okCount===1?'':'s'}`);
    else showToast(`Sent to ${okCount}, ${failCount} failed — check console`);
    if(failCount) console.error('Digest send failures:', results.filter(r=>!r.ok));
  } catch(e){
    console.error('sendDigestNow error:', e);
    showToast('Send failed — see console');
  }
}

// ═══════ AI BOT EDITOR ═══════
const DEFAULT_BOT_CONFIG_CLIENT = {
  role: 'You are a professional, friendly real estate assistant for 3 PIN Realty, a real estate brokerage in Chennai. You help potential buyers find properties by understanding their requirements through natural conversation.',
  welcomeMessage: "Hi! Thanks for reaching out to 3 PIN Realty 👋 What are you looking for in Chennai — an apartment, villa, or plot?",
  requiredInfo: [
    { id:'ri1', label:'Preferred area in Chennai' },
    { id:'ri2', label:'Budget' },
    { id:'ri3', label:'Property type and configuration (e.g. 2BHK apartment, villa)' },
    { id:'ri4', label:'Name' }
  ],
  steps: [
    { id:'s1', title:'Hook & Qualify', instructions:'Acknowledge the enquiry immediately. Ask only for what is missing — do not repeat questions already answered. Gather naturally, not like a form.' },
    { id:'s2', title:'Share Matching Options', instructions:'Once you have area, budget, and type, let them know a team member will follow up with matching properties. Do not invent specific listings, prices, or availability you were not given.' },
    { id:'s3', title:'Close & Handoff', instructions:'Once you have the required info, thank them and let them know a team member will follow up shortly.' }
  ],
  guardrails: [
    'Never invent specific property prices, availability, or details you have not been given.',
    'If asked for legal, financial, or loan advice, say a team member will follow up on that.',
    'If the user seems frustrated, confused, or explicitly asks for a human, stop qualifying and say a team member will take over.',
    'Keep replies short — 1-3 sentences, WhatsApp style, not long paragraphs.'
  ],
  tone: 'Warm, professional, concise. Natural conversation — never sound like filling out a form.',
  waPhoneNumber: '',
  waPhoneNumberId: ''
};
let botConfigDraft = null;
let botTestHistory = [];

async function openBotEditor(){
  document.getElementById('botEditorPanel').classList.add('open');
  const saved = await window.crmFirebase.getBotConfig();
  botConfigDraft = saved ? JSON.parse(JSON.stringify(saved)) : JSON.parse(JSON.stringify(DEFAULT_BOT_CONFIG_CLIENT));
  renderBotEditorForm();
  botTestHistory = [];
  renderBotChat();
  loadKnowledge();
}
function closeBotEditor(){
  document.getElementById('botEditorPanel').classList.remove('open');
}

function renderBotEditorForm(){
  document.getElementById('botRole').value = botConfigDraft.role || '';
  document.getElementById('botWelcome').value = botConfigDraft.welcomeMessage || '';
  document.getElementById('botTone').value = botConfigDraft.tone || '';
  updateWaConnectionStatus();
  renderRequiredInfoRows();
  renderStepsRows();
  renderGuardrailsRows();
}

function updateWaConnectionStatus(){
  const connected = !!(botConfigDraft.waPhoneNumberId && botConfigDraft.waConnectedAt);
  const statusEl = document.getElementById('waConnectionStatus');
  const disconnectedBody = document.getElementById('waDisconnectedBody');
  const connectedBody = document.getElementById('waConnectedBody');
  const subEl = document.getElementById('waCardSub');

  statusEl.textContent = connected ? 'Verified' : 'Not connected';
  statusEl.className = 'connect-status ' + (connected ? 'connected' : 'disconnected');
  disconnectedBody.style.display = connected ? 'none' : 'block';
  connectedBody.style.display = connected ? 'block' : 'none';

  if(connected){
    const num = botConfigDraft.waPhoneNumber || botConfigDraft.waPhoneNumberId;
    subEl.textContent = botConfigDraft.waVerifiedName || 'Connected';
    document.getElementById('waVerifiedText').textContent = num;
    const meta = [];
    if(botConfigDraft.waVerifiedName) meta.push('Name: ' + botConfigDraft.waVerifiedName);
    if(botConfigDraft.waQualityRating) meta.push('Quality: ' + botConfigDraft.waQualityRating);
    meta.push('ID: ' + botConfigDraft.waPhoneNumberId);
    document.getElementById('waVerifiedMeta').innerHTML = meta.map(m=>`<span>${m}</span>`).join('');
  } else {
    subEl.textContent = 'Not connected';
  }
  renderWorkflowCanvas();
}

// ═══════ WORKFLOW CANVAS ═══════
function renderWorkflowCanvas(){
  const el = document.getElementById('wfCanvas');
  if(!el || !botConfigDraft) return;

  const sheets = knowledgeSources.filter(s => /sheet/i.test(s.type||''));
  const docs = knowledgeSources.filter(s => !/sheet/i.test(s.type||''));
  const waOn = !!(botConfigDraft.waPhoneNumberId && botConfigDraft.waConnectedAt);
  const agentOn = waOn && knowledgeSources.length > 0;

  const node = (opts) => {
    const cls = 'wf-node' + (opts.cls ? ' '+opts.cls : '');
    const click = opts.onclick ? ` onclick="${opts.onclick}"` : '';
    const pill = opts.pill ? `<span class="wf-pill ${opts.pill.k}">${opts.pill.t}</span>` : '';
    return `<div class="${cls}"${click}>
      <div class="wf-node-top"><span class="wf-ico">${opts.ico}</span>${pill}</div>
      <div class="wf-node-name">${opts.name}</div>
      <div class="wf-node-desc">${opts.desc}</div>
    </div>`;
  };

  const knowledgeNode = node({
    ico:'📚', name:'Knowledge',
    desc: docs.length ? `${docs.length} doc${docs.length>1?'s':''}/file${docs.length>1?'s':''}` : 'Add docs & PDFs',
    pill: docs.length ? {k:'on',t:'Connected'} : {k:'off',t:'Empty'},
    onclick:"openWfSection('secKnowledge')"
  });
  const sheetNode = node({
    ico:'📊', name:'Google Sheet',
    desc: sheets.length ? `${sheets.length} sheet${sheets.length>1?'s':''} linked` : 'Link a sheet',
    pill: sheets.length ? {k:'on',t:'Linked'} : {k:'off',t:'Empty'},
    onclick:"openWfSection('secKnowledge')"
  });
  const agentNode = node({
    cls:'agent', ico:'🤖', name:"3 PIN Agent",
    desc: agentOn ? 'Live & answering' : 'Connect a channel to go live',
    pill: agentOn ? {k:'on',t:'Active'} : {k:'warn',t:'Inactive'},
    onclick:"openWfSection('secPersona')"
  });
  const waNode = node({
    ico:'🟢', name:'WhatsApp',
    desc: waOn ? (botConfigDraft.waPhoneNumber||'Connected') : 'Click to connect',
    pill: waOn ? {k:'on',t:'Verified'} : {k:'off',t:'Connect'},
    onclick:"openWfSection('secChannels')"
  });
  const igNode = node({ cls:'soon', ico:'📸', name:'Instagram', desc:'Coming soon', pill:{k:'off',t:'Soon'} });
  const webNode = node({ cls:'soon', ico:'🌐', name:'Website', desc:'Coming soon', pill:{k:'off',t:'Soon'} });

  el.innerHTML =
    `<div class="wf-col">${knowledgeNode}${sheetNode}</div>` +
    `<div class="wf-rail"></div>` +
    `<div class="wf-col center">${agentNode}</div>` +
    `<div class="wf-rail"></div>` +
    `<div class="wf-col">${waNode}${igNode}${webNode}</div>`;
}

function openWfSection(id){
  const sec = document.getElementById(id);
  if(!sec) return;
  sec.scrollIntoView({ behavior:'smooth', block:'center' });
  sec.classList.add('wf-flash');
  setTimeout(()=>sec.classList.remove('wf-flash'), 1200);
}

// Meta Embedded Signup Configuration ID comes from /api/public-config (see
// crm.html), which serves it from the META_EMBEDDED_SIGNUP_CONFIG_ID Vercel
// env var — not hardcoded here, so it's set in exactly one place.
let waSignupSessionInfo = null;
let waSessionInfoResolvers = [];
let publicConfig = null;
(window.__publicConfigPromise || Promise.resolve({})).then(cfg => { publicConfig = cfg; });

// Exact allowlist, not endsWith — "evilfacebook.com" ends with "facebook.com"
// too, so a substring/suffix check here would let an attacker-controlled
// page inject a fake WA_EMBEDDED_SIGNUP message with a spoofed phone number.
const META_MESSAGE_ORIGINS = ['https://www.facebook.com', 'https://web.facebook.com', 'https://m.facebook.com'];
let waSignupAttemptId = 0;

window.addEventListener('message', (event) => {
  if (!META_MESSAGE_ORIGINS.includes(event.origin)) return;
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.type === 'WA_EMBEDDED_SIGNUP' && data.event === 'FINISH') {
    waSignupSessionInfo = data.data; // { phone_number_id, waba_id }
    waSessionInfoResolvers.forEach(r => r(data.data));
    waSessionInfoResolvers = [];
  }
});

// Tagged with the attempt id at call time so a message that arrives late
// from a cancelled/timed-out earlier attempt can't be mistaken for the
// current one's session info.
function waitForWaSessionInfo(timeoutMs, attemptId){
  if (waSignupSessionInfo && attemptId === waSignupAttemptId) return Promise.resolve(waSignupSessionInfo);
  return new Promise(resolve => {
    const wrapped = (info) => { if (attemptId === waSignupAttemptId) resolve(info); };
    waSessionInfoResolvers.push(wrapped);
    setTimeout(() => { if (attemptId === waSignupAttemptId) resolve(waSignupSessionInfo); }, timeoutMs);
  });
}

function connectWhatsApp(){
  // Must call FB.login() synchronously, in direct response to the click —
  // any `await` (even a resolved promise's microtask) before it makes
  // browsers treat the resulting window.open() as NOT user-initiated, and
  // they silently block the popup instead of opening it. That's why the
  // public config is pre-fetched into `publicConfig` at load time rather
  // than awaited here.
  const note = document.getElementById('waConnectNote');
  if (typeof FB === 'undefined'){
    note.textContent = 'Meta SDK failed to load — check your connection and try again.';
    note.style.color = 'var(--red)';
    return;
  }
  if (!publicConfig || !publicConfig.metaEmbeddedSignupConfigId){
    note.textContent = 'Meta config is still loading — wait a second and try again.';
    note.style.color = 'var(--red)';
    return;
  }
  const btn = document.getElementById('waConnectBtn');
  btn.disabled = true; btn.textContent = 'Connecting…';
  waSignupSessionInfo = null;
  const attemptId = ++waSignupAttemptId;
  FB.login((response) => handleFbLoginResponse(response, attemptId), {
    config_id: publicConfig.metaEmbeddedSignupConfigId,
    response_type: 'code',
    override_default_response_type: true,
    extras: { setup: {}, featureType: '', sessionInfoVersion: '2' }
  });
}

async function handleFbLoginResponse(response, attemptId){
  const btn = document.getElementById('waConnectBtn');
  const note = document.getElementById('waConnectNote');
  const resetBtn = () => { btn.disabled = false; btn.innerHTML = '<span class="wa-glyph">✆</span> Connect WhatsApp via Meta'; };

  if (!response.authResponse || !response.authResponse.code){
    note.textContent = 'Connection cancelled.';
    note.style.color = 'var(--red)';
    resetBtn();
    return;
  }

  try{
    const sessionInfo = await waitForWaSessionInfo(4000, attemptId);
    if (!sessionInfo || !sessionInfo.phone_number_id){
      note.textContent = 'Could not read the connected number from Meta — please try again.';
      note.style.color = 'var(--red)';
      return;
    }
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/whatsapp-embedded-signup', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+idToken },
      body: JSON.stringify({
        code: response.authResponse.code,
        phoneNumberId: sessionInfo.phone_number_id,
        wabaId: sessionInfo.waba_id
      })
    });
    const data = await res.json().catch(()=>({}));
    if(!data.connected){
      note.textContent = data.error || 'Could not connect. Please try again.';
      note.style.color = 'var(--red)';
      return;
    }
    // Persist verified fields into the draft so a later "Save Workflow" won't wipe them.
    botConfigDraft.waPhoneNumberId = data.phoneNumberId;
    botConfigDraft.waPhoneNumber = data.displayPhoneNumber || '';
    botConfigDraft.waVerifiedName = data.verifiedName || '';
    botConfigDraft.waQualityRating = data.qualityRating || '';
    botConfigDraft.waConnectedAt = Date.now();
    updateWaConnectionStatus();
    showToast('✓ WhatsApp connected');
  } catch(e){
    console.error('connectWhatsApp error:', e);
    note.textContent = 'Connection failed — see console.';
    note.style.color = 'var(--red)';
  } finally {
    resetBtn();
  }
}

async function disconnectWhatsApp(){
  if(!confirm('Disconnect this WhatsApp number from the bot?')) return;
  try{
    const idToken = await window.crmAuth.getIdToken();
    await fetch('/api/whatsapp-embedded-signup', {
      method:'DELETE',
      headers:{ 'Authorization':'Bearer '+idToken }
    });
  } catch(e){ console.error('disconnectWhatsApp error:', e); }
  botConfigDraft.waPhoneNumberId = '';
  botConfigDraft.waPhoneNumber = '';
  botConfigDraft.waVerifiedName = '';
  botConfigDraft.waQualityRating = '';
  botConfigDraft.waConnectedAt = null;
  updateWaConnectionStatus();
  showToast('WhatsApp disconnected');
}

function syncBotDraftFromForm(){
  botConfigDraft.role = document.getElementById('botRole').value;
  botConfigDraft.welcomeMessage = document.getElementById('botWelcome').value;
  botConfigDraft.tone = document.getElementById('botTone').value;
  // WhatsApp fields are managed by the connect/disconnect flow, not this form.
}

function renderRequiredInfoRows(){
  document.getElementById('botRequiredInfoRows').innerHTML = botConfigDraft.requiredInfo.map((r,i)=>`
    <div class="req-info-row">
      <input type="text" value="${r.label}" oninput="renameRequiredInfoDraft(${i}, this.value)">
      <button class="stage-del" onclick="removeRequiredInfoDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameRequiredInfoDraft(i, val){ botConfigDraft.requiredInfo[i].label = val; }
function removeRequiredInfoDraft(i){ botConfigDraft.requiredInfo.splice(i,1); renderRequiredInfoRows(); }
function addRequiredInfoDraft(){
  const inp = document.getElementById('newRequiredInfo');
  const label = inp.value.trim();
  if(!label) return;
  botConfigDraft.requiredInfo.push({ id:'ri_'+Date.now(), label });
  inp.value='';
  renderRequiredInfoRows();
}

function renderStepsRows(){
  document.getElementById('botStepsRows').innerHTML = botConfigDraft.steps.map((s,i)=>`
    <div class="step-row">
      <div class="step-row-hdr">
        <button class="stage-move" onclick="moveStepDraft(${i},-1)" ${i===0?'disabled style="opacity:.3"':''}>↑</button>
        <button class="stage-move" onclick="moveStepDraft(${i},1)" ${i===botConfigDraft.steps.length-1?'disabled style="opacity:.3"':''}>↓</button>
        <input type="text" value="${s.title}" oninput="renameStepTitleDraft(${i}, this.value)">
        <button class="stage-del" onclick="removeStepDraft(${i})">🗑️</button>
      </div>
      <textarea rows="2" oninput="renameStepInstructionsDraft(${i}, this.value)">${s.instructions}</textarea>
    </div>`).join('');
}
function renameStepTitleDraft(i, val){ botConfigDraft.steps[i].title = val; }
function renameStepInstructionsDraft(i, val){ botConfigDraft.steps[i].instructions = val; }
function moveStepDraft(i, dir){
  const j = i+dir;
  if(j<0 || j>=botConfigDraft.steps.length) return;
  [botConfigDraft.steps[i], botConfigDraft.steps[j]] = [botConfigDraft.steps[j], botConfigDraft.steps[i]];
  renderStepsRows();
}
function removeStepDraft(i){ botConfigDraft.steps.splice(i,1); renderStepsRows(); }
function addStepDraft(){
  botConfigDraft.steps.push({ id:'s_'+Date.now(), title:'New Step', instructions:'' });
  renderStepsRows();
}

function renderGuardrailsRows(){
  document.getElementById('botGuardrailsRows').innerHTML = botConfigDraft.guardrails.map((g,i)=>`
    <div class="req-info-row">
      <input type="text" value="${g}" oninput="renameGuardrailDraft(${i}, this.value)">
      <button class="stage-del" onclick="removeGuardrailDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameGuardrailDraft(i, val){ botConfigDraft.guardrails[i] = val; }
function removeGuardrailDraft(i){ botConfigDraft.guardrails.splice(i,1); renderGuardrailsRows(); }
function addGuardrailDraft(){
  const inp = document.getElementById('newGuardrail');
  const val = inp.value.trim();
  if(!val) return;
  botConfigDraft.guardrails.push(val);
  inp.value='';
  renderGuardrailsRows();
}

function saveBotConfig(){
  syncBotDraftFromForm();
  updateWaConnectionStatus();
  window.crmFirebase.saveBotConfig(botConfigDraft);
  showToast('✓ Workflow saved');
}

function renderBotChat(){
  const win = document.getElementById('botChatWindow');
  if(!botTestHistory.length){
    win.innerHTML = '<div class="bot-chat-empty">Send a message to test the bot with your current draft workflow.</div>';
    return;
  }
  win.innerHTML = botTestHistory.map(m=>`<div class="bot-msg ${m.role}">${m.content}</div>`).join('');
  win.scrollTop = win.scrollHeight;
}

async function sendBotTestMessage(){
  const inp = document.getElementById('botTestInput');
  const text = inp.value.trim();
  if(!text) return;
  syncBotDraftFromForm();
  botTestHistory.push({ role:'user', content:text });
  inp.value='';
  renderBotChat();
  try{
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/bot-test-message', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+idToken },
      body: JSON.stringify({ config: botConfigDraft, history: botTestHistory })
    });
    if(!res.ok){
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error || ('HTTP '+res.status));
    }
    const data = await res.json();
    botTestHistory.push({ role:'assistant', content:data.reply || '(no reply)' });
    renderBotChat();
  } catch(e){
    console.error('Bot test message error:', e);
    showToast('Test message failed — see console');
  }
}
function clearBotTestChat(){
  botTestHistory = [];
  renderBotChat();
}

// ═══════ KNOWLEDGE BASE ═══════
let knowledgeSources = [];

async function kbFetch(method, body){
  const idToken = await window.crmAuth.getIdToken();
  const opts = { method, headers:{ 'Authorization':'Bearer '+idToken } };
  if(body){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  const res = await fetch('/api/knowledge-sync', opts);
  const data = await res.json().catch(()=>({}));
  if(data.error) throw new Error(data.error);
  return data;
}

async function loadKnowledge(){
  try{
    const data = await kbFetch('GET');
    knowledgeSources = data.sources || [];
  } catch(e){
    console.error('loadKnowledge error:', e);
    knowledgeSources = [];
  }
  renderKnowledgeList();
}

function renderKnowledgeList(){
  renderWorkflowCanvas();
  const el = document.getElementById('kbSourceList');
  if(!knowledgeSources.length){
    el.innerHTML = '<div class="kb-empty">No knowledge connected yet. Add a sheet, doc, or file above.</div>';
    return;
  }
  el.innerHTML = knowledgeSources.map(s=>{
    const when = s.syncedAt ? new Date(s.syncedAt).toLocaleDateString() : '';
    const chars = s.chars ? (s.chars>999 ? (s.chars/1000).toFixed(1)+'k' : s.chars) + ' chars' : '';
    const resync = s.url ? `<button class="kb-src-act" onclick="resyncKnowledge('${s.id}')">↻ Sync</button>` : '';
    return `<div class="kb-src">
      <div class="kb-src-icon">${s.url ? '🔗' : '📄'}</div>
      <div class="kb-src-body">
        <div class="kb-src-name">${escapeHtml(s.name||'Source')}</div>
        <div class="kb-src-meta">${escapeHtml(s.type||'')} · ${chars} · synced ${when}</div>
      </div>
      <div class="kb-src-acts">${resync}<button class="kb-src-act del" onclick="removeKnowledge('${s.id}')">🗑️</button></div>
    </div>`;
  }).join('');
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function addKnowledgeLink(){
  const url = document.getElementById('kbLinkUrl').value.trim();
  const name = document.getElementById('kbLinkName').value.trim();
  if(!url){ showToast('Paste a Google Sheet or Doc link'); return; }
  showToast('Connecting link…');
  try{
    const data = await kbFetch('POST', { action:'addLink', url, name });
    knowledgeSources.push(data.source);
    document.getElementById('kbLinkUrl').value='';
    document.getElementById('kbLinkName').value='';
    renderKnowledgeList();
    showToast('✓ Knowledge added');
  } catch(e){
    console.error(e); showToast(e.message || 'Could not add link');
  }
}

function toggleKbPaste(){
  const box = document.getElementById('kbPasteBox');
  box.style.display = box.style.display==='none' ? 'block' : 'none';
}

async function addKnowledgePaste(){
  const name = document.getElementById('kbPasteName').value.trim();
  const content = document.getElementById('kbPasteContent').value.trim();
  if(!content){ showToast('Paste some text first'); return; }
  try{
    const data = await kbFetch('POST', { action:'addText', name: name||'Pasted text', sourceType:'Text', content });
    knowledgeSources.push(data.source);
    document.getElementById('kbPasteName').value='';
    document.getElementById('kbPasteContent').value='';
    document.getElementById('kbPasteBox').style.display='none';
    renderKnowledgeList();
    showToast('✓ Knowledge added');
  } catch(e){ console.error(e); showToast(e.message || 'Could not add text'); }
}

async function uploadKnowledgeFile(event){
  const file = event.target.files[0];
  event.target.value = '';
  if(!file) return;
  showToast('Reading ' + file.name + '…');
  try{
    let text = '';
    if(file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')){
      text = await extractPdfText(file);
    } else {
      text = await file.text();
    }
    if(!text.trim()){ showToast('No readable text found in that file'); return; }
    const data = await kbFetch('POST', { action:'addText', name:file.name, sourceType: file.name.split('.').pop().toUpperCase(), content:text });
    knowledgeSources.push(data.source);
    renderKnowledgeList();
    showToast('✓ ' + file.name + ' added');
  } catch(e){ console.error(e); showToast(e.message || 'Could not read file'); }
}

async function extractPdfText(file){
  if(!window.pdfjsLib) throw new Error('PDF reader not loaded — try again');
  const buf = await file.arrayBuffer();
  // isEvalSupported:false disarms CVE-2024-4367 — a crafted PDF can otherwise
  // run arbitrary JS in this (logged-in) origin via pdf.js's font eval path.
  // Kept even after the version bump below, as defence-in-depth.
  const pdf = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  let out = '';
  const pages = Math.min(pdf.numPages, 50);
  for(let i=1;i<=pages;i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map(it=>it.str).join(' ') + '\n';
  }
  return out;
}

async function resyncKnowledge(id){
  showToast('Re-syncing…');
  try{
    const data = await kbFetch('POST', { action:'resync', id });
    const idx = knowledgeSources.findIndex(s=>s.id===id);
    if(idx>=0) knowledgeSources[idx] = data.source;
    renderKnowledgeList();
    showToast('✓ Synced');
  } catch(e){ console.error(e); showToast(e.message || 'Sync failed'); }
}

async function removeKnowledge(id){
  try{
    await kbFetch('POST', { action:'remove', id });
    knowledgeSources = knowledgeSources.filter(s=>s.id!==id);
    renderKnowledgeList();
    showToast('Removed');
  } catch(e){ console.error(e); showToast('Could not remove'); }
}

function connectGoogleDrive(){
  // Placeholder for the full OAuth Drive Picker (needs a one-time Google Cloud
  // OAuth client + Picker API key). Until that's configured, the paste-a-link
  // flow above already covers Sheets & Docs with no setup.
  showToast('Google Drive picker needs one-time OAuth setup — use "Connect" with a shared link for now');
}


// ═══════ TOAST ═══════
function showToast(msg){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2400);
}

// keyboard: ESC closes panels
document.addEventListener('keydown', e=>{
  if(e.key==='Escape'){ closeDetail(); closeLeadModal(); closeStageManager(); closeBotEditor(); closeDigestManager(); closeFollowUpLogModal(); closeViewDropdown(); closeMoreMenu(); }
});

// ═══════ REAL AUTH (Firebase Authentication) ═══════
let crmInited = false;
function attemptCrmLogin(e){
  e.preventDefault();
  const email = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errBox = document.getElementById('loginErr');
  errBox.classList.remove('show');
  window.crmAuth.login(email, password).catch(()=>{
    errBox.textContent = 'Invalid email or password.';
    errBox.classList.add('show');
  });
}
function crmLogout(){
  window.crmAuth.logout();
}
function renderUserProfileBadge(){
  const el = document.getElementById('hdrUserEmail');
  if(el) el.textContent = currentUserEmail ? '👤 ' + currentUserEmail : '';
}
window.onCrmAuthChange = function(user){
  if(user){
    currentUserEmail = user.email || null;
    renderUserProfileBadge();
    document.getElementById('loginScreen').classList.remove('open');
    document.getElementById('appRoot').style.display = '';
    if(!crmInited){ crmInited = true; init(); }
  } else {
    currentUserEmail = null;
    document.getElementById('loginScreen').classList.add('open');
    document.getElementById('appRoot').style.display = 'none';
  }
};
