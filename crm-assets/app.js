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
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
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
  if(e.key==='Escape'){ closeDetail(); closeLeadModal(); closeStageManager(); closeBotEditor(); }
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
