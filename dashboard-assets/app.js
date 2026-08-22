// ═══════ STATE ═══════
let properties = sampleData.map(p=>({...p}));
let filteredProperties = [...properties];
let selectedProperties = new Set();
let favorites = JSON.parse(localStorage.getItem('pinFavorites')) || [];
let notes = JSON.parse(localStorage.getItem('pinNotes')) || {};
let propertyInterests = JSON.parse(localStorage.getItem('pinInterests')) || {};
let currentStatus = 'all';
let currentType = 'all';
let currentSort = 'newest';
let showFavOnly = false;
let hideSoldOut = false;
let currentSearch = '';
let currentDetailId = null;

// ═══════ HELPERS ═══════
const isReady = p => p.status === 'Ready to Move';
// crude numeric price extraction for sorting (₹, L, Cr, Crores)
function priceValue(p){
  const s = (p.startingPrice||'').replace(/,/g,'');
  const m = s.match(/([\d.]+)\s*(Cr|Crore|Crores|L|Lakh)?/i);
  if(!m) return Number.MAX_SAFE_INTEGER; // 'Price on Request' sinks to bottom
  let n = parseFloat(m[1]);
  const unit = (m[2]||'').toLowerCase();
  if(unit.startsWith('cr')) n *= 10000000;
  else if(unit.startsWith('l')) n *= 100000;
  else if(s.includes('/Sqft')) n = n; // per-sqft plots — keep small
  return n;
}
// When a property was added, for the "time of insert" sort. New properties
// get an explicit createdAt (see savePModal); older ones fall back to the
// timestamp baked into their id ('p'+Date.now(), see savePModal's add path),
// and anything with neither (the original seeded sample data) sorts as
// oldest, which is the correct place for it.
function insertValue(p){
  if(p.createdAt) return Number(p.createdAt);
  const m = /^p(\d+)$/.exec(p.id || '');
  return m ? Number(m[1]) : 0;
}

// ═══════ INIT ═══════
function init(){
  setupStatusFilters();
  setupTypeFilters();
  setupSoldOutFilter();
  setupSearch();
  applyFilters();
  updateStats();
}

function updateStats(){
  document.getElementById('cR').textContent = properties.filter(isReady).length;
  document.getElementById('cU').textContent = properties.filter(p => p.status === 'Under Construction').length;
  document.getElementById('cT').textContent = properties.length;
}

// ═══════ FILTERS / SORT / SEARCH ═══════
function setupStatusFilters(){
  document.getElementById('statusFilters').innerHTML = `
    <button class="fbtn at" data-s="all" onclick="setStatus('all',this)">All</button>
    <button class="fbtn srtm" data-s="ready" onclick="setStatus('ready',this)">✓ Ready</button>
    <button class="fbtn suc" data-s="upcoming" onclick="setStatus('upcoming',this)">⏳ Upcoming</button>`;
}
function setupTypeFilters(){
  const types = [...new Set(properties.map(p => p.type))].sort();
  const norm = {'Apartment':'Apartments','Apartments':'Apartments','Plot':'Plots','Plots':'Plots','Villa':'Villa','Residential':'Residential','Townhouse':'Townhouse','Independent House':'House'};
  const groups = [...new Set(properties.map(p => norm[p.type]||p.type))].sort();
  let html = `<button class="fbtn at" data-t="all" onclick="setType('all',this)">All Types</button>`;
  groups.forEach(t => html += `<button class="fbtn" data-t="${t}" onclick="setType('${t}',this)">${t}</button>`);
  document.getElementById('typeFilters').innerHTML = html;
}
function setupSoldOutFilter(){
  const html = `<button class="fbtn" id="soldOutToggle" onclick="toggleSoldOutFilter(this)">👁️ Hide Sold Out</button>`;
  let container = document.querySelector('.controls');
  let divider = document.querySelector('.fdiv');
  if(divider) divider.insertAdjacentHTML('afterend', html);
}
function toggleSoldOutFilter(btn){
  hideSoldOut = !hideSoldOut;
  btn.classList.toggle('at', hideSoldOut);
  btn.textContent = hideSoldOut ? '✓ Only Active' : '👁️ Hide Sold Out';
  applyFilters();
}
function setStatus(s,btn){currentStatus=s;document.querySelectorAll('#statusFilters .fbtn').forEach(b=>b.classList.remove('at'));btn.classList.add('at');applyFilters();}
function setType(t,btn){currentType=t;document.querySelectorAll('#typeFilters .fbtn').forEach(b=>b.classList.remove('at'));btn.classList.add('at');applyFilters();}
function applySort(){currentSort=document.getElementById('sortSel').value;applyFilters();}
function toggleFavView(){showFavOnly=!showFavOnly;document.getElementById('favToggle').classList.toggle('at',showFavOnly);applyFilters();}

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

function setupSearch(){
  const inp = document.getElementById('searchInput');
  inp.addEventListener('input', e => {
    currentSearch = e.target.value.toLowerCase();
    document.getElementById('srchClear').classList.toggle('show', !!currentSearch);
    applyFilters();
  });
}
function clearSearch(){document.getElementById('searchInput').value='';currentSearch='';document.getElementById('srchClear').classList.remove('show');applyFilters();}

function applyFilters(){
  const norm = {'Apartment':'Apartments','Apartments':'Apartments','Plot':'Plots','Plots':'Plots','Villa':'Villa','Residential':'Residential','Townhouse':'Townhouse','Independent House':'House'};
  let res = properties.filter(p => {
    if(currentStatus==='ready' && !isReady(p)) return false;
    if(currentStatus==='upcoming' && p.status!=='Under Construction') return false;
    if(currentType!=='all' && (norm[p.type]||p.type)!==currentType) return false;
    if(showFavOnly && !favorites.includes(p.id)) return false;
    if(hideSoldOut && p.soldOut) return false;
    if(currentSearch){
      const hay = [p.propertyCode,p.name,p.location,p.builder,p.config,p.amenities,p.highlights,p.type].join(' ').toLowerCase();
      if(!hay.includes(currentSearch)) return false;
    }
    return true;
  });
  if(currentSort==='price-low') res.sort((a,b)=>priceValue(a)-priceValue(b));
  else if(currentSort==='price-high') res.sort((a,b)=>priceValue(b)-priceValue(a));
  else if(currentSort==='name') res.sort((a,b)=>a.name.localeCompare(b.name));
  else if(currentSort==='newest') res.sort((a,b)=>insertValue(b)-insertValue(a));
  else if(currentSort==='oldest') res.sort((a,b)=>insertValue(a)-insertValue(b));
  filteredProperties = res;
  renderGrid();
}

// ═══════ GRID ═══════
function renderGrid(){
  const grid = document.getElementById('pgrid');
  const noRes = document.getElementById('noRes');
  const rCnt = document.getElementById('rCnt');
  if(filteredProperties.length===0){
    grid.innerHTML=''; noRes.style.display='block';
    rCnt.innerHTML='<b>0</b> properties'; return;
  }
  noRes.style.display='none';
  rCnt.innerHTML = `Showing <b>${filteredProperties.length}</b> of ${properties.length} properties`;
  grid.innerHTML = filteredProperties.map(p => {
    const fav = favorites.includes(p.id);
    const sel = selectedProperties.has(p.id);
    const isSoldOut = !!p.soldOut;
    const pType = p.type||'';
    const typeBadge = pType.includes('Plot')?'bs':pType.includes('Villa')||pType.includes('House')?'bp':'bb';
    return `
    <div class="card ${isSoldOut?'sold-out':''}">
      <div class="card-bar ${isReady(p)?'rtm':'uc'}"></div>
      ${isSoldOut?'<div class="sold-out-overlay"><div class="sold-out-overlay-text">SOLD OUT</div></div>':''}
      <div class="card-body" onclick="openDetail('${p.id}')">
        <div class="card-r1">
          <div>
            <div class="card-name">${p.propertyCode?`<span class="card-code-inline">${escapeHtml(p.propertyCode)}</span> — `:''}${p.name}</div>
            <div class="card-loc">📍 ${p.location}</div>
          </div>
          <div class="card-actions" onclick="event.stopPropagation()">
            <button class="card-action-btn card-share" onclick="sharePropertyLink('${p.id}',event)" title="Share internal link" aria-label="Share internal link">${PinPropertyView.SHARE_ICON}</button>
            <button class="card-action-btn card-star ${fav?'active':''}" onclick="toggleFavorite('${p.id}',event)" title="Save">★</button>
          </div>
        </div>
        <div class="badges">
          <span class="badge ${isReady(p)?'bg':'ba'}">${isReady(p)?'✓ Ready to Move':'⏳ '+p.possession}</span>
          <span class="badge ${typeBadge}">${p.config}</span>
        </div>
        <div class="price-row">
          <div>
            <div class="price-lbl">Starting Price</div>
            <div class="price-main">${p.startingPrice}</div>
          </div>
          ${p.pricePerSqft?`<div class="price-psf">${p.pricePerSqft}</div>`:''}
        </div>
        <div class="card-stats">
          <div class="cst"><div class="cst-l">Area</div><div class="cst-v">${p.sqftRange||'—'}</div></div>
          <div class="cst"><div class="cst-l">Type</div><div class="cst-v">${p.type}</div></div>
        </div>
        <div class="card-foot">
          <div class="card-bldr">${p.builder}</div>
          <label class="card-cmp" onclick="event.stopPropagation()">
            <input type="checkbox" ${sel?'checked':''} onchange="toggleSelection('${p.id}',this)"> Compare
          </label>
        </div>
      </div>
      <div class="card-cta">
        <a href="tel:${p.contactNumber}" class="cta-btn cta-call" onclick="event.stopPropagation()">📞 Call</a>
        <div class="cta-btn cta-view" onclick="openDetail('${p.id}')">View Details →</div>
      </div>
    </div>`;
  }).join('');
}

// ═══════ FAVORITES ═══════
function toggleFavorite(id,event){
  event.stopPropagation();
  const i = favorites.indexOf(id);
  if(i===-1){favorites.push(id);showToast('★ Added to favorites');}
  else{favorites.splice(i,1);showToast('Removed from favorites');}
  localStorage.setItem('pinFavorites',JSON.stringify(favorites));
  applyFilters();
}
function toggleFavFromDetail(){
  const id = currentDetailId;
  const i = favorites.indexOf(id);
  if(i===-1){favorites.push(id);showToast('★ Added to favorites');}
  else{favorites.splice(i,1);showToast('Removed from favorites');}
  localStorage.setItem('pinFavorites',JSON.stringify(favorites));
  document.getElementById('dpFav').classList.toggle('active',favorites.includes(id));
  document.getElementById('dpFav').textContent = favorites.includes(id)?'★ Saved':'★ Save';
}

// ═══════ LEAD CRM ═══════
function openLeadCrm(id){
  const p = properties.find(x=>x.id===id);
  if(!p) return;
  window.location.href = 'crm.html?propertyId=' + id;
}

// ═══════ SOLD OUT ═══════
async function toggleSoldOut(id){
  const p = properties.find(x=>x.id===id);
  if(!p) return;
  const prev = p.soldOut;
  p.soldOut = !p.soldOut;
  if(p.soldOut){
    document.getElementById('dpSoldOut').classList.add('sold-out');
    document.getElementById('dpSoldOut').textContent = '✓ Marked Sold Out';
  } else {
    document.getElementById('dpSoldOut').classList.remove('sold-out');
    document.getElementById('dpSoldOut').textContent = '🏷️ Mark Sold Out';
  }
  applyFilters();
  try{
    await window.dashboardFirebase.saveProperty(p);
    showToast(p.soldOut ? '✓ Property marked as Sold Out' : 'Property unmarked — Back to Active');
  }catch(e){
    p.soldOut = prev;
    document.getElementById('dpSoldOut').classList.toggle('sold-out', p.soldOut);
    document.getElementById('dpSoldOut').textContent = p.soldOut ? '✓ Marked Sold Out' : '🏷️ Mark Sold Out';
    applyFilters();
    showToast('✗ Update failed — check your connection and try again');
  }
}

// ═══════ SELECTION / COMPARE ═══════
function toggleSelection(id,cb){
  if(cb.checked) selectedProperties.add(id); else selectedProperties.delete(id);
  const t=document.getElementById('msToolbar');
  document.getElementById('msCount').textContent=selectedProperties.size;
  t.classList.toggle('active',selectedProperties.size>0);
}
function clearSelection(){
  selectedProperties.clear();
  document.querySelectorAll('.card-cmp input').forEach(c=>c.checked=false);
  document.getElementById('msToolbar').classList.remove('active');
}
function compareSelected(){
  if(selectedProperties.size<2){showToast('Select at least 2 properties to compare');return;}
  const comp = Array.from(selectedProperties).map(id=>properties.find(p=>p.id===id));
  const rows = [
    ['Starting Price','startingPrice'],['Price/SqFt','pricePerSqft'],['Configuration','config'],
    ['Area Range','sqftRange'],['Status','status'],['Possession','possession'],
    ['Builder','builder'],['Location','location'],['Total Units','totalUnits'],['Vastu','vastu']
  ];
  const html = `
    <div class="sec">
      <div class="sec-title">📊 Property Comparison</div>
      <div class="cmp-wrap"><table class="cmp-t">
        <thead><tr><th>Feature</th>${comp.map(p=>`<th>${p.name}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(([lbl,key])=>`<tr><td>${lbl}</td>${comp.map(p=>`<td>${p[key]||'—'}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  currentDetailId=null;
  document.getElementById('dpHero').innerHTML='<div><div class="dp-builder-tag">Comparison Mode</div><h1 class="dp-title">Comparing '+comp.length+' Properties</h1></div>';
  document.querySelector('.dp-tabs').style.display='none';
  document.querySelector('.dp-hdr-actions').style.display='none';
  document.getElementById('dpBody').innerHTML=html;
  document.getElementById('dp').classList.add('open');
}

// ═══════ DETAIL PANEL ═══════
// openDetail = render + put the property's own URL in the address bar, so
// whatever you're looking at is always the link you can paste into chat.
// renderDetail is the plain render, used on its own when the Back button
// (popstate) restores a panel that's already in the history stack.
function openDetail(id){
  if(!renderDetail(id)) return;
  pushDetailUrl(id);
}

function renderDetail(id){
  const p = properties.find(x=>x.id===id);
  if(!p) return false;
  currentDetailId = id;
  PinPropertyView.cacheProperty(p);
  document.querySelector('.dp-tabs').style.display='flex';
  document.querySelector('.dp-hdr-actions').style.display='flex';
  const fav = favorites.includes(id);
  const isSoldOut = !!p.soldOut;
  document.getElementById('dpFav').classList.toggle('active',fav);
  document.getElementById('dpFav').textContent = fav?'★ Saved':'★ Save';
  document.getElementById('dpSoldOut').classList.toggle('sold-out',isSoldOut);
  document.getElementById('dpSoldOut').textContent = isSoldOut?'✓ Marked Sold Out':'🏷️ Mark Sold Out';

  document.getElementById('dpHero').innerHTML = PinPropertyView.hero(p);

  const overview = PinPropertyView.overviewTab(p);
  const specs = PinPropertyView.specsTab(p);
  const pitch = PinPropertyView.pitchTab(p);

  const crm = `
    <div class="tab-panel">
      <div class="sec">
        <div class="sec-title">👤 Client Interest Level</div>
        <div class="interest-buttons">
          <button class="interest-btn hot ${propertyInterests[id]==='hot'?'active':''}" onclick="setInterest('${id}','hot')">🔥 Hot Lead</button>
          <button class="interest-btn warm ${propertyInterests[id]==='warm'?'active':''}" onclick="setInterest('${id}','warm')">🌡️ Warm</button>
          <button class="interest-btn cold ${propertyInterests[id]==='cold'?'active':''}" onclick="setInterest('${id}','cold')">❄️ Cold</button>
        </div>
      </div>
      <div class="sec">
        <div class="sec-title">📝 Notes & Follow-up</div>
        <div id="notesPanel">${renderNotes(id)}</div>
        <div class="note-add">
          <input class="note-input" id="noteInput" placeholder="Add a note (e.g. client budget, follow-up date)…" onkeydown="if(event.key==='Enter')addNoteInline('${id}')">
          <button class="note-btn" onclick="addNoteInline('${id}')">Add</button>
        </div>
      </div>
    </div>`;

  document.getElementById('dpBody').innerHTML = overview + specs + pitch + crm;
  document.getElementById('dp').classList.add('open');
  // reset tabs
  document.querySelectorAll('.dp-tab').forEach((t,i)=>t.classList.toggle('active',i===0));
  return true;
}

function showTab(name,btn){
  document.querySelectorAll('.dp-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  const idx=['overview','specs','pitch','notes'].indexOf(name);
  document.querySelectorAll('.tab-panel')[idx].classList.add('active');
}

// ═══════ DETAIL URL / HISTORY ═══════
// The panel owns exactly ONE history entry while it's open: opening pushes
// it, re-rendering a different property replaces it, and closing pops it.
// Without that single-entry rule, browsing five properties would bury the
// list under five Back presses.
let detailUrlPushed = false;
function pushDetailUrl(id){
  const url = PinPropertyView.propertyUrl(id);
  if(detailUrlPushed){ history.replaceState({pinDetail:id},'',url); }
  else { history.pushState({pinDetail:id},'',url); detailUrlPushed = true; }
}
function hideDetailPanel(){
  document.getElementById('dp').classList.remove('open');
  currentDetailId = null;
}
// Close routes through the history stack so the Back button and the
// "All Properties" button land in exactly the same state.
function closeDetail(){
  if(detailUrlPushed){ history.back(); return; }
  hideDetailPanel();
}
window.addEventListener('popstate', e => {
  const id = e.state && e.state.pinDetail;
  if(id && properties.some(p=>p.id===id)){
    detailUrlPushed = true;
    renderDetail(id);
  } else {
    detailUrlPushed = false;
    hideDetailPanel();
  }
});

// ═══════ NOTES ═══════
function renderNotes(id){
  const list = notes[id]||[];
  if(!list.length) return `<div class="empty-mini">No notes yet. Add your first observation below.</div>`;
  return list.map(n=>`
    <div class="note-item">
      <div class="note-meta"><span class="note-time">${n.date}</span><button class="note-delete" onclick="deleteNote('${id}',${n.id})">×</button></div>
      <div class="note-text">${n.text}</div>
    </div>`).join('');
}
function addNoteInline(id){
  const inp=document.getElementById('noteInput');
  const txt=inp.value.trim();
  if(!txt) return;
  if(!notes[id]) notes[id]=[];
  notes[id].push({text:txt,date:new Date().toLocaleString(),id:Date.now()});
  localStorage.setItem('pinNotes',JSON.stringify(notes));
  document.getElementById('notesPanel').innerHTML=renderNotes(id);
  inp.value=''; showToast('Note added');
}
function deleteNote(id,noteId){
  if(notes[id]){notes[id]=notes[id].filter(n=>n.id!==noteId);localStorage.setItem('pinNotes',JSON.stringify(notes));document.getElementById('notesPanel').innerHTML=renderNotes(id);}
}
function setInterest(id,lvl){
  propertyInterests[id]= propertyInterests[id]===lvl?null:lvl;
  localStorage.setItem('pinInterests',JSON.stringify(propertyInterests));
  document.querySelectorAll('.interest-btn').forEach(b=>b.classList.remove('active'));
  if(propertyInterests[id]){event.target.classList.add('active');showToast(`Marked as ${lvl} lead`);}
}

// ═══════ ADD / EDIT / DELETE PROPERTY ═══════
let pModalMode = 'add'; // 'add' | 'edit'
let pModalEditId = null;
let pModalOriginalFull = null; // full original property object, when editing
let pModalOriginalStr = {};    // key -> snapshot string value, for diffing

// Drives the on-screen edit form: which fields exist, how they're grouped,
// and how each renders.
const PROPERTY_FIELDS = [
  { key:'propertyCode', label:'Property Code', group:'Basic Info', placeholder:'MYLA002', example:'MYLA002' },
  { key:'name', label:'Property Name', group:'Basic Info', required:true, example:'Green Meadows' },
  { key:'builder', label:'Builder', group:'Basic Info', example:'ABC Builders' },
  { key:'location', label:'Location', group:'Basic Info', required:true, example:'Velachery, Chennai' },
  { key:'type', label:'Type', group:'Basic Info', datalist:true, example:'Apartments' },
  { key:'config', label:'Configuration', group:'Basic Info', placeholder:'2BHK / 3BHK', example:'2BHK / 3BHK' },
  { key:'status', label:'Status', group:'Pricing & Status', options:['Under Construction','Ready to Move'], example:'Under Construction' },
  { key:'possession', label:'Possession', group:'Pricing & Status', example:'Dec 2027' },
  { key:'startingPrice', label:'Starting Price', group:'Pricing & Status', example:'₹65L+' },
  { key:'pricePerSqft', label:'Price / Sqft', group:'Pricing & Status', example:'₹5500/Sqft' },
  { key:'availability', label:'Availability', group:'Pricing & Status', example:'Available' },
  { key:'totalUnits', label:'Total Units', group:'Specifications', example:'100' },
  { key:'sqftRange', label:'Sqft Range', group:'Specifications', example:'900-1800 Sq.Ft' },
  { key:'totalLandArea', label:'Total Land Area', group:'Specifications', example:'5 Acres' },
  { key:'uds', label:'UDS (Undivided Share)', group:'Specifications', example:'600 Sqft UDS' },
  { key:'totalFloors', label:'Total Floors', group:'Specifications', example:'G+5' },
  { key:'parking', label:'Parking', group:'Specifications', example:'1' },
  { key:'parkingType', label:'Parking Type', group:'Specifications', example:'Covered' },
  { key:'vastu', label:'Vastu', group:'Specifications', example:'Yes' },
  { key:'highlights', label:'Highlights', group:'Description', textarea:true, wide:true, hint:'Comma-separated', example:'Highlight One,Highlight Two,Highlight Three' },
  { key:'amenities', label:'Amenities', group:'Description', textarea:true, wide:true, hint:'Comma-separated', example:'Swimming Pool,Gym,Clubhouse' },
  { key:'nearby', label:'Nearby', group:'Description', example:'Nearby area' },
  { key:'nearbyLandmark', label:'Nearby Landmark', group:'Description', example:'Landmark name' },
  { key:'connectivity', label:'Connectivity', group:'Description', wide:true, example:'Metro / Road connectivity details' },
  { key:'contactName', label:'Contact Name', group:'Contact', example:'Swaminathan' },
  { key:'contactNumber', label:'Contact Number', group:'Contact', example:'98848 83370' },
];

function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function ensurePModalFormBuilt(){
  const container = document.getElementById('pmForm');
  if(container.dataset.built) return;
  container.dataset.built = '1';
  const groups = [];
  const byGroup = {};
  PROPERTY_FIELDS.forEach(f=>{
    if(!byGroup[f.group]){ byGroup[f.group]=[]; groups.push(f.group); }
    byGroup[f.group].push(f);
  });
  let html = '';
  groups.forEach(g=>{
    html += `<div class="pf-group"><div class="pf-group-title">${escapeHtml(g)}</div><div class="pf-grid">`;
    byGroup[g].forEach(f=>{
      html += `<div class="pf-field${f.wide?' pf-wide':''}" id="pfw_${f.key}">
        <label for="pf_${f.key}">${escapeHtml(f.label)}${f.required?' *':''}</label>`;
      if(f.options){
        html += `<select id="pf_${f.key}" oninput="onPModalFieldInput('${f.key}')">` +
          f.options.map(o=>`<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('') + `</select>`;
      } else if(f.textarea){
        html += `<textarea id="pf_${f.key}" rows="2" placeholder="${escapeHtml(f.hint||'')}" oninput="onPModalFieldInput('${f.key}')"></textarea>`;
      } else {
        const listAttr = f.datalist ? ` list="pf_${f.key}_list"` : '';
        html += `<input type="text" id="pf_${f.key}"${listAttr} placeholder="${escapeHtml(f.placeholder||'')}" oninput="onPModalFieldInput('${f.key}')">`;
        if(f.datalist) html += `<datalist id="pf_${f.key}_list"></datalist>`;
      }
      html += `<div class="pf-diff" id="pfd_${f.key}"></div></div>`;
    });
    html += `</div></div>`;
  });
  container.innerHTML = html;
}

function refreshPModalTypeDatalist(){
  const list = document.getElementById('pf_type_list');
  if(!list) return;
  const types = [...new Set(properties.map(p=>p.type).filter(Boolean))].sort();
  list.innerHTML = types.map(t=>`<option value="${escapeHtml(t)}"></option>`).join('');
}

function populatePModalForm(data){
  data = data || {};
  PROPERTY_FIELDS.forEach(f=>{
    const val = data[f.key]!=null ? String(data[f.key]) : '';
    pModalOriginalStr[f.key] = val;
    const el = document.getElementById('pf_'+f.key);
    el.value = val;
    updateFieldDiff(f.key);
  });
  updateJsonPreview();
}

function onPModalFieldInput(key){
  updateFieldDiff(key);
  updateJsonPreview();
}

function updateFieldDiff(key){
  const el = document.getElementById('pf_'+key);
  const diffEl = document.getElementById('pfd_'+key);
  const wrap = document.getElementById('pfw_'+key);
  if(!el || !diffEl || !wrap) return;
  const cur = el.value;
  const orig = pModalOriginalStr[key] || '';
  if(pModalMode==='edit' && cur !== orig){
    wrap.classList.add('pf-changed');
    const oldTxt = orig ? `<s class="pf-old">${escapeHtml(orig)}</s>` : `<s class="pf-old pf-empty">empty</s>`;
    const newTxt = cur ? `<span class="pf-new">${escapeHtml(cur)}</span>` : `<span class="pf-new pf-empty">empty</span>`;
    diffEl.innerHTML = `${oldTxt} → ${newTxt}`;
    diffEl.classList.add('show');
  } else {
    wrap.classList.remove('pf-changed');
    diffEl.classList.remove('show');
    diffEl.innerHTML = '';
  }
}

function buildDataFromForm(){
  const base = pModalMode==='edit' && pModalOriginalFull ? {...pModalOriginalFull} : {};
  PROPERTY_FIELDS.forEach(f=>{
    base[f.key] = document.getElementById('pf_'+f.key).value.trim();
  });
  return base;
}

function updateJsonPreview(){
  const jsonEl = document.getElementById('pmJson');
  if(jsonEl) jsonEl.value = JSON.stringify(buildDataFromForm(), null, 2);
}

function discardPModalChanges(){
  populatePModalForm(pModalOriginalFull || {});
  document.getElementById('pmErr').classList.remove('show');
  showToast('Changes discarded');
}

// Accepts either the dashboard's own schema or the alternate flat schema
// (propertyType/price/priceInCr/readyToMove/builtupArea/...) used by some
// listing sources, and fills in the fields the grid/detail view rely on.
function normalizeProperty(data){
  // Raw source fields always win over a previously-derived value, so
  // re-editing price/type/status/etc. on an already-saved alt-schema
  // property actually changes what's displayed instead of being masked
  // by whatever got baked in on the first save.
  const propertyCode = data.propertyCode || data.propertyId || '';
  const type = data.propertyType || data.type || 'Property';
  const builder = data.builder || 'Individual Owner';
  let startingPrice;
  if(data.price) startingPrice = data.price;
  else if(data.priceInCr) startingPrice = `₹${data.priceInCr} Cr`;
  else startingPrice = data.startingPrice || 'Price on Request';
  let status;
  if(data.readyToMove !== undefined || data.newOrResale !== undefined){
    status = (data.readyToMove==='Yes' || data.newOrResale==='Resale') ? 'Ready to Move' : 'Under Construction';
  } else {
    status = data.status || 'Under Construction';
  }
  const possession = data.possessionDate || data.possession || 'Contact for details';
  const sqftRange = data.builtupArea || data.superBuiltupArea || data.carpetArea || data.sqftRange || '';
  return { ...data, propertyCode, type, builder, startingPrice, status, possession, sqftRange };
}

function openAddModal(){
  pModalMode = 'add'; pModalEditId = null; pModalOriginalFull = null;
  document.getElementById('pmTitle').textContent = 'Add New Property';
  document.getElementById('pmErr').classList.remove('show');
  ensurePModalFormBuilt();
  refreshPModalTypeDatalist();
  populatePModalForm({ status:'Under Construction' });
  const jsonEl = document.getElementById('pmJson');
  jsonEl.readOnly = false;
  jsonEl.value = '';
  document.getElementById('pmJsonSummary').textContent = 'Paste JSON to fill in the form (optional)';
  document.getElementById('pmJsonActions').classList.add('show');
  document.getElementById('pModal').classList.add('open');
}

function openEditModal(id){
  const p = properties.find(x=>x.id===id);
  if(!p) return;
  pModalMode = 'edit'; pModalEditId = id; pModalOriginalFull = {...p};
  document.getElementById('pmTitle').textContent = 'Edit Property';
  document.getElementById('pmErr').classList.remove('show');
  ensurePModalFormBuilt();
  refreshPModalTypeDatalist();
  populatePModalForm(p);
  document.getElementById('pmJson').readOnly = true;
  document.getElementById('pmJsonSummary').textContent = 'View JSON (live preview, read-only)';
  document.getElementById('pmJsonActions').classList.remove('show');
  document.getElementById('pModal').classList.add('open');
}

// Add-mode only: lets someone paste a full property JSON (e.g. from
// exportProperty on another listing, or hand-written) and have it fill
// in the form fields in one shot, instead of retyping every field.
function loadPModalJson(){
  const errBox = document.getElementById('pmErr');
  const raw = document.getElementById('pmJson').value.trim();
  if(!raw){ errBox.textContent = 'Paste a property JSON above first.'; errBox.classList.add('show'); return; }
  let data;
  try{ data = JSON.parse(raw); }
  catch(e){ errBox.textContent = 'Invalid JSON — check for missing commas or quotes. ('+e.message+')'; errBox.classList.add('show'); return; }
  errBox.classList.remove('show');
  // Runs the same alt-schema mapping used at save time (propertyType/price/
  // priceInCr/readyToMove/builtupArea/...) so JSON from other listing
  // sources still lands in the right form fields, not just this app's own shape.
  populatePModalForm(normalizeProperty(data));
  showToast('JSON loaded — review the form below and Save');
}

// Add-mode only: fills the JSON box with a blank template (every field
// PROPERTY_FIELDS knows about, with an example value) so it can be copied
// out, filled in elsewhere, and pasted back — or edited right there and
// loaded with loadPModalJson().
function insertPModalJsonTemplate(){
  const tmpl = {};
  PROPERTY_FIELDS.forEach(f => { tmpl[f.key] = f.example || ''; });
  const jsonEl = document.getElementById('pmJson');
  jsonEl.value = JSON.stringify(tmpl, null, 2);
  document.getElementById('pmJsonWrap').open = true;
  jsonEl.focus();
  showToast('Template inserted — edit the values, then Load into form or paste elsewhere');
}

function closePModal(){
  document.getElementById('pModal').classList.remove('open');
}

async function savePModal(){
  const errBox = document.getElementById('pmErr');

  // Add mode: if the form's still empty but JSON was pasted (and never
  // explicitly "Load"ed), apply it now — otherwise Save silently fails
  // the name/location check even though the pasted JSON has both.
  if(pModalMode === 'add'){
    const formSoFar = buildDataFromForm();
    const rawJson = document.getElementById('pmJson').value.trim();
    if((!formSoFar.name || !formSoFar.location) && rawJson){
      let parsed;
      try{ parsed = JSON.parse(rawJson); }
      catch(e){ errBox.textContent='Invalid JSON — check for missing commas or quotes. ('+e.message+')'; errBox.classList.add('show'); return; }
      populatePModalForm(normalizeProperty(parsed));
    }
  }

  let data = buildDataFromForm();
  if(!data.name || !data.location){ errBox.textContent='Property must have at least a "name" and "location".'; errBox.classList.add('show'); return; }
  errBox.classList.remove('show');

  data = normalizeProperty(data);

  const mode = pModalMode;
  let previousEntry = null;
  if(mode==='add'){
    data.id = 'p'+Date.now();
    data.createdAt = Date.now();
    properties.unshift(data);
  } else {
    data.id = pModalEditId;
    const idx = properties.findIndex(p=>p.id===pModalEditId);
    previousEntry = idx>-1 ? properties[idx] : null;
    if(idx>-1) properties[idx] = data;
  }
  closePModal();
  refreshAfterDataChange();
  if(mode==='edit') openDetail(data.id);

  try{
    await window.dashboardFirebase.saveProperty(data);
    showToast(mode==='add' ? '✓ Property added successfully' : '✓ Property updated successfully');
  }catch(e){
    if(mode==='add'){
      properties = properties.filter(p=>p.id!==data.id);
    } else if(previousEntry){
      const idx = properties.findIndex(p=>p.id===data.id);
      if(idx>-1) properties[idx] = previousEntry;
    }
    refreshAfterDataChange();
    showToast('✗ Save failed — check your connection and try again');
  }
}

async function deleteProperty(id){
  const p = properties.find(x=>x.id===id);
  if(!p) return;
  if(!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
  properties = properties.filter(x=>x.id!==id);
  closeDetail();
  refreshAfterDataChange();
  try{
    await window.dashboardFirebase.deleteProperty(id);
    showToast('Property deleted');
  }catch(e){
    properties.unshift(p);
    refreshAfterDataChange();
    showToast('✗ Delete failed — check your connection and try again');
  }
}

function refreshAfterDataChange(){
  setupTypeFilters();
  updateStats();
  applyFilters();
}

window.applyPropertiesSnapshot = function(list){
  properties = list;
  refreshAfterDataChange();
};

// ═══════ EXPORT / SHARE ═══════
// Single-property export/share/print actions (and showToast/downloadFile)
// live in property-view.js, shared with property.html. Only the
// multi-select export below is dashboard-only.
function exportSelected(format){
  const sel=Array.from(selectedProperties).map(id=>properties.find(p=>p.id===id));
  if(!sel.length){showToast('No properties selected');return;}
  if(format==='csv'){
    const headers=['Name','Builder','Location','Type','Config','Starting Price','Price/SqFt','Area','Status','Possession'];
    const rows=sel.map(p=>[p.name,p.builder,p.location,p.type,p.config,p.startingPrice,p.pricePerSqft,p.sqftRange,p.status,p.possession]);
    const csv=[headers,...rows].map(r=>r.map(c=>`"${(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
    downloadFile(csv,`3pin_properties_${Date.now()}.csv`,'text/csv');
  }
  showToast('Export downloaded');
}
// Look properties up out of this page's in-memory list for the shared
// export/share/print actions in property-view.js.
PinPropertyView.setResolver(id => properties.find(x => x.id === id));

// keyboard: ESC closes detail
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePModal();closeDetail();closeShareDetailsModal();}});
