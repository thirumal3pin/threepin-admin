// ═══════ STATE ═══════
let leads = [];
let stages = [];
let filteredLeads = [];
let currentView = 'kanban';
let currentSource = 'all';
let currentSearch = '';
let currentDetailId = null;
let lModalMode = 'add';
let lModalEditId = null;
let stageManagerDraft = [];
let toastTimer;

// ═══════ SNAPSHOT HANDLERS (called by firebase-sync.js) ═══════
window.applyLeadsSnapshot = function(list){
  leads = list;
  refreshAll();
};
window.applyPipelineSnapshot = function(list){
  stages = list.slice().sort((a,b)=> (a.order||0) - (b.order||0));
  refreshAll();
};

function refreshAll(){
  updateStats();
  applyFilters();
}

// ═══════ INIT ═══════
function init(){
  setupSearch();
  applyFilters();
  updateStats();
}

function updateStats(){
  const metaCount = leads.filter(l=>l.source==='meta').length;
  const manualCount = leads.filter(l=>l.source==='manual').length;
  document.getElementById('statMeta').textContent = metaCount;
  document.getElementById('statManual').textContent = manualCount;
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
function setSource(s, btn){
  currentSource = s;
  document.querySelectorAll('#sourceFilters .fbtn').forEach(b=>b.classList.remove('at'));
  btn.classList.add('at');
  applyFilters();
}
function setupSourceFilters(){
  document.getElementById('sourceFilters').innerHTML = `
    <button class="fbtn at" data-s="all" onclick="setSource('all',this)">All Sources</button>
    <button class="fbtn" data-s="meta" onclick="setSource('meta',this)">📱 Meta Ads</button>
    <button class="fbtn" data-s="manual" onclick="setSource('manual',this)">✍️ Manual</button>`;
}

function applyFilters(){
  filteredLeads = leads.filter(l=>{
    if(currentSource!=='all' && l.source!==currentSource) return false;
    if(currentSearch){
      const hay = [l.name,l.phone,l.email,l.propertyInterest].join(' ').toLowerCase();
      if(!hay.includes(currentSearch)) return false;
    }
    return true;
  });
  if(currentView==='kanban') renderBoard(); else renderList();
}

function toggleView(view){
  currentView = view;
  document.querySelectorAll('.view-toggle button').forEach(b=>b.classList.toggle('at', b.dataset.view===view));
  document.getElementById('kanbanView').style.display = view==='kanban' ? '' : 'none';
  document.getElementById('listView').style.display = view==='list' ? '' : 'none';
  applyFilters();
}

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
        <div class="kcol-title"><span class="kcol-dot" style="background:${stage.color}"></span>${stage.name}</div>
        <div class="kcol-count">${colLeads.length}</div>
      </div>
      <div class="kcol-body">
        ${colLeads.length ? colLeads.map(l=>leadCardHtml(l)).join('') : '<div class="kcol-empty">No leads</div>'}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function leadCardHtml(l){
  const stage = stageById(l.stageId);
  const next = nextStageId(l.stageId);
  const nextStage = next ? stageById(next) : null;
  return `
  <div class="lcard" onclick="openDetail('${l.id}')">
    <div class="lcard-top">
      <div class="lcard-name">${l.name}</div>
      <div class="lcard-src ${l.source}">${l.source==='meta'?'Meta':'Manual'}</div>
    </div>
    <div class="lcard-meta">
      ${l.phone?`<div>📞 ${l.phone}</div>`:''}
      ${l.propertyInterest?`<div>🏠 ${l.propertyInterest}</div>`:''}
    </div>
    <div class="lcard-foot">
      <div class="lcard-time">${timeAgo(l.updatedAt||l.createdAt)}</div>
      ${nextStage?`<button class="lcard-next" onclick="event.stopPropagation();changeStage('${l.id}','${next}')">→ ${nextStage.name}</button>`:''}
    </div>
  </div>`;
}

// ═══════ LIST VIEW ═══════
function renderList(){
  const wrap = document.getElementById('listView');
  if(!filteredLeads.length){
    wrap.innerHTML = '<div class="nores"><div class="nores-i">🗂️</div><div class="nores-t">No leads match your filters</div></div>';
    return;
  }
  wrap.innerHTML = `<div class="list-view"><table>
    <thead><tr><th>Name</th><th>Contact</th><th>Interest</th><th>Stage</th><th>Source</th><th>Updated</th></tr></thead>
    <tbody>${filteredLeads.map(l=>{
      const stage = stageById(l.stageId);
      return `<tr onclick="openDetail('${l.id}')">
        <td><b>${l.name}</b></td>
        <td>${l.phone||l.email||'—'}</td>
        <td>${l.propertyInterest||'—'}</td>
        <td>${stage?`<span class="stage-pill" style="background:${stage.color}22;color:${stage.color}">${stage.name}</span>`:'—'}</td>
        <td>${l.source==='meta'?'📱 Meta':'✍️ Manual'}</td>
        <td>${timeAgo(l.updatedAt||l.createdAt)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function changeStage(id, stageId){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  l.stageId = stageId;
  l.updatedAt = Date.now();
  applyFilters();
  window.crmFirebase.saveLead(l);
  if(currentDetailId===id) renderDetailStageRow(l);
}

// ═══════ ADD / EDIT LEAD MODAL ═══════
function openAddLeadModal(){
  lModalMode='add'; lModalEditId=null;
  document.getElementById('lmTitle').textContent='Add New Lead';
  document.getElementById('lmName').value='';
  document.getElementById('lmPhone').value='';
  document.getElementById('lmEmail').value='';
  document.getElementById('lmInterest').value='';
  document.getElementById('lmErr').classList.remove('show');
  document.getElementById('lModal').classList.add('open');
}
function openEditLeadModal(id){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  lModalMode='edit'; lModalEditId=id;
  document.getElementById('lmTitle').textContent='Edit Lead';
  document.getElementById('lmName').value=l.name||'';
  document.getElementById('lmPhone').value=l.phone||'';
  document.getElementById('lmEmail').value=l.email||'';
  document.getElementById('lmInterest').value=l.propertyInterest||'';
  document.getElementById('lmErr').classList.remove('show');
  document.getElementById('lModal').classList.add('open');
}
function closeLeadModal(){
  document.getElementById('lModal').classList.remove('open');
}
function saveLeadModal(){
  const name = document.getElementById('lmName').value.trim();
  const errBox = document.getElementById('lmErr');
  if(!name){ errBox.textContent='Name is required.'; errBox.classList.add('show'); return; }
  errBox.classList.remove('show');
  const phone = document.getElementById('lmPhone').value.trim();
  const email = document.getElementById('lmEmail').value.trim();
  const propertyInterest = document.getElementById('lmInterest').value.trim();

  if(lModalMode==='add'){
    const l = {
      id: 'lead_'+Date.now(),
      name, phone, email, propertyInterest,
      source: 'manual',
      stageId: stages.length ? stages[0].id : null,
      notes: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    leads.unshift(l);
    showToast('✓ Lead added');
    window.crmFirebase.saveLead(l);
  } else {
    const l = leads.find(x=>x.id===lModalEditId);
    if(l){
      l.name=name; l.phone=phone; l.email=email; l.propertyInterest=propertyInterest; l.updatedAt=Date.now();
      showToast('✓ Lead updated');
      window.crmFirebase.saveLead(l);
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

// ═══════ DETAIL PANEL ═══════
function openDetail(id){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  currentDetailId = id;
  document.getElementById('dpName').textContent = l.name;
  document.getElementById('dpSub').textContent = l.source==='meta' ? 'Lead via Meta (Facebook/Instagram) Ads' : 'Manually added lead';

  renderDetailStageRow(l);

  const infoHtml = `
    ${l.phone?`<div class="info-b"><div class="info-b-l">Phone</div><div class="info-b-v"><a href="tel:${l.phone}">${l.phone}</a></div></div>`:''}
    ${l.email?`<div class="info-b"><div class="info-b-l">Email</div><div class="info-b-v"><a href="mailto:${l.email}">${l.email}</a></div></div>`:''}
    ${l.propertyInterest?`<div class="info-b"><div class="info-b-l">Property Interest</div><div class="info-b-v">${l.propertyInterest}</div></div>`:''}
    <div class="info-b"><div class="info-b-l">Added</div><div class="info-b-v">${new Date(l.createdAt).toLocaleString()}</div></div>
    ${l.formId?`<div class="info-b"><div class="info-b-l">Meta Form ID</div><div class="info-b-v">${l.formId}</div></div>`:''}
    ${l.adId?`<div class="info-b"><div class="info-b-l">Meta Ad ID</div><div class="info-b-v">${l.adId}</div></div>`:''}
  `;
  document.getElementById('dpInfo').innerHTML = infoHtml;

  const rawSec = document.getElementById('dpRawSec');
  if(l.source==='meta' && l.rawFieldData){
    rawSec.style.display='';
    document.getElementById('dpRaw').textContent = JSON.stringify(l.rawFieldData, null, 2);
  } else {
    rawSec.style.display='none';
  }

  renderNotes(l);
  document.getElementById('dp').classList.add('open');
  window.scrollTo(0,0);
}
function renderDetailStageRow(l){
  const sel = document.getElementById('dpStageSel');
  sel.innerHTML = stages.map(s=>`<option value="${s.id}" ${s.id===l.stageId?'selected':''}>${s.name}</option>`).join('');
  const stage = stageById(l.stageId);
  sel.style.borderColor = stage ? stage.color : '';
  sel.style.color = stage ? stage.color : '';
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
        <span class="note-time">${new Date(n.createdAt).toLocaleString()}</span>
        <button class="note-delete" onclick="deleteNote('${l.id}','${n.id}')">×</button>
      </div>
      <div class="note-text">${n.text}</div>
    </div>`).join('') : '<div class="empty-mini">No notes yet — log a call or follow-up below.</div>';
  document.getElementById('notesPanel').innerHTML = html;
}
function addNote(){
  const inp = document.getElementById('noteInput');
  const text = inp.value.trim();
  if(!text) return;
  const l = leads.find(x=>x.id===currentDetailId);
  if(!l) return;
  l.notes = l.notes || [];
  l.notes.push({ id:'n'+Date.now(), text, createdAt: Date.now() });
  l.updatedAt = Date.now();
  inp.value='';
  renderNotes(l);
  applyFilters();
  window.crmFirebase.saveLead(l);
}
function deleteNote(leadId, noteId){
  const l = leads.find(x=>x.id===leadId);
  if(!l) return;
  l.notes = (l.notes||[]).filter(n=>n.id!==noteId);
  renderNotes(l);
  window.crmFirebase.saveLead(l);
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
      window.crmFirebase.saveLead(l);
    }
  });
  stages = stageManagerDraft;
  window.crmFirebase.savePipeline(stages);
  closeStageManager();
  refreshAll();
  showToast('✓ Pipeline stages updated');
}

// ═══════ MOBILE HEADER / FILTER TOGGLES ═══════
function toggleHdrMenu(e){
  if(e) e.stopPropagation();
  document.getElementById('hstats').classList.toggle('mobile-open');
}
function toggleMobileFilters(){
  document.getElementById('controlsPanel').classList.toggle('mobile-open');
}
document.addEventListener('click', e=>{
  const hstats = document.getElementById('hstats');
  const menuBtn = document.getElementById('hdrMenuBtn');
  if(hstats && hstats.classList.contains('mobile-open') && !hstats.contains(e.target) && e.target!==menuBtn){
    hstats.classList.remove('mobile-open');
  }
});

// ═══════ TOAST ═══════
function showToast(msg){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2400);
}

// keyboard: ESC closes panels
document.addEventListener('keydown', e=>{
  if(e.key==='Escape'){ closeDetail(); closeLeadModal(); closeStageManager(); }
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
window.onCrmAuthChange = function(user){
  if(user){
    document.getElementById('loginScreen').classList.remove('open');
    document.getElementById('appRoot').style.display = '';
    if(!crmInited){ crmInited = true; init(); }
  } else {
    document.getElementById('loginScreen').classList.add('open');
    document.getElementById('appRoot').style.display = 'none';
  }
};

window.addEventListener('DOMContentLoaded', ()=>{
  setupSourceFilters();
});
