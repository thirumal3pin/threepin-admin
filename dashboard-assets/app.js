// ═══════ STATE ═══════
let properties = sampleData.map(p=>({...p}));
let filteredProperties = [...properties];
let selectedProperties = new Set();
let favorites = JSON.parse(localStorage.getItem('pinFavorites')) || [];
let notes = JSON.parse(localStorage.getItem('pinNotes')) || {};
let propertyInterests = JSON.parse(localStorage.getItem('pinInterests')) || {};
let currentStatus = 'all';
let currentType = 'all';
let currentSort = 'default';
let showFavOnly = false;
let hideSoldOut = false;
let currentSearch = '';
let currentDetailId = null;

// ═══════ HELPERS ═══════
const isReady = p => p.status === 'Ready to Move';
const splitList = s => s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
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
      const hay = [p.name,p.location,p.builder,p.config,p.amenities,p.highlights,p.type].join(' ').toLowerCase();
      if(!hay.includes(currentSearch)) return false;
    }
    return true;
  });
  if(currentSort==='price-low') res.sort((a,b)=>priceValue(a)-priceValue(b));
  else if(currentSort==='price-high') res.sort((a,b)=>priceValue(b)-priceValue(a));
  else if(currentSort==='name') res.sort((a,b)=>a.name.localeCompare(b.name));
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
    const typeBadge = p.type.includes('Plot')?'bs':p.type.includes('Villa')||p.type.includes('House')?'bp':'bb';
    return `
    <div class="card ${isSoldOut?'sold-out':''}">
      <div class="card-bar ${isReady(p)?'rtm':'uc'}"></div>
      ${isSoldOut?'<div class="sold-out-overlay"><div class="sold-out-overlay-text">SOLD OUT</div></div>':''}
      <div class="card-body" onclick="openDetail('${p.id}')">
        <div class="card-r1">
          <div>
            <div class="card-name">${p.name}</div>
            <div class="card-loc">📍 ${p.location}</div>
          </div>
          <div class="card-actions" onclick="event.stopPropagation()">
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

// ═══════ SOLD OUT ═══════
function toggleSoldOut(id){
  const p = properties.find(x=>x.id===id);
  if(!p) return;
  p.soldOut = !p.soldOut;
  if(p.soldOut){
    showToast('✓ Property marked as Sold Out');
    document.getElementById('dpSoldOut').classList.add('sold-out');
    document.getElementById('dpSoldOut').textContent = '✓ Marked Sold Out';
  } else {
    showToast('Property unmarked — Back to Active');
    document.getElementById('dpSoldOut').classList.remove('sold-out');
    document.getElementById('dpSoldOut').textContent = '🏷️ Mark Sold Out';
  }
  applyFilters();
  window.dashboardFirebase.saveProperty(p);
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
function openDetail(id){
  const p = properties.find(x=>x.id===id);
  if(!p) return;
  currentDetailId = id;
  document.querySelector('.dp-tabs').style.display='flex';
  document.querySelector('.dp-hdr-actions').style.display='flex';
  const fav = favorites.includes(id);
  const isSoldOut = !!p.soldOut;
  document.getElementById('dpFav').classList.toggle('active',fav);
  document.getElementById('dpFav').textContent = fav?'★ Saved':'★ Save';
  document.getElementById('dpSoldOut').classList.toggle('sold-out',isSoldOut);
  document.getElementById('dpSoldOut').textContent = isSoldOut?'✓ Marked Sold Out':'🏷️ Mark Sold Out';

  document.getElementById('dpHero').innerHTML = `
    <div style="flex:1;min-width:240px;">
      <div class="dp-builder-tag">${p.builder} · ${p.type}</div>
      <h1 class="dp-title">${p.name}</h1>
      <div class="dp-loc">📍 ${p.location}</div>
      <a href="tel:${p.contactNumber}" class="dp-call">📞 Call ${p.contactName} — ${p.contactNumber}</a>
    </div>
    <div class="dp-price-box">
      <div class="dp-price">${p.startingPrice}</div>
      ${p.pricePerSqft?`<div class="dp-psf">${p.pricePerSqft}</div>`:''}
      <div style="margin-top:8px;"><span class="badge ${isReady(p)?'bg':'ba'}">${isReady(p)?'✓ Ready to Move':'⏳ Under Construction'}</span></div>
    </div>`;

  const highlights = splitList(p.highlights);
  const amenities = splitList(p.amenities);

  const overview = `
    <div class="tab-panel active">
      <div class="sec">
        <div class="sec-title">📊 Key Facts</div>
        <div class="stats-g">
          <div class="stat-b"><div class="stat-b-v">${p.config}</div><div class="stat-b-l">Configuration</div></div>
          <div class="stat-b"><div class="stat-b-v">${p.sqftRange||'—'}</div><div class="stat-b-l">Area</div></div>
          <div class="stat-b"><div class="stat-b-v">${p.possession}</div><div class="stat-b-l">Possession</div></div>
          <div class="stat-b"><div class="stat-b-v">${p.totalUnits||'—'}</div><div class="stat-b-l">Total Units</div></div>
          <div class="stat-b"><div class="stat-b-v">${p.totalFloors||'—'}</div><div class="stat-b-l">Floors</div></div>
          <div class="stat-b"><div class="stat-b-v">${p.vastu||'—'}</div><div class="stat-b-l">Vastu</div></div>
        </div>
      </div>
      ${highlights.length?`<div class="sec"><div class="sec-title">✨ Highlights</div><div class="hi-grid">${highlights.map(h=>`<div class="hi-item">✓ ${h}</div>`).join('')}</div></div>`:''}
      ${amenities.length?`<div class="sec"><div class="sec-title">🏢 Amenities</div><div class="am-wrap">${amenities.map(a=>`<span class="am-chip">${a}</span>`).join('')}</div></div>`:''}
      <div class="sec">
        <div class="sec-title">📍 Location & Connectivity</div>
        <div class="conn-wrap">
          ${p.nearby?`<div class="conn-row"><div class="conn-k">Nearby</div><div class="conn-v">${p.nearby}</div></div>`:''}
          ${p.nearbyLandmark?`<div class="conn-row"><div class="conn-k">Landmark</div><div class="conn-v">${p.nearbyLandmark}</div></div>`:''}
          ${p.connectivity?`<div class="conn-row"><div class="conn-k">Connectivity</div><div class="conn-v">${p.connectivity}</div></div>`:''}
          ${!p.nearby&&!p.nearbyLandmark&&!p.connectivity?`<div class="conn-row"><div class="conn-v">Information not available</div></div>`:''}
        </div>
      </div>
      <div class="sec">
        <div class="sec-title">📤 Share & Export</div>
        <div class="export-g">
          <div class="export-btn" onclick="printProperty('${p.id}')"><div class="export-btn-icon">🖨️</div>Print</div>
          <div class="export-btn" onclick="exportProperty('${p.id}')"><div class="export-btn-icon">📄</div>JSON</div>
          <div class="export-btn" onclick="downloadBrochure('${p.id}')"><div class="export-btn-icon">📑</div>Brochure</div>
          <div class="export-btn" onclick="shareProperty('${p.id}')"><div class="export-btn-icon">🔗</div>Share</div>
        </div>
      </div>
    </div>`;

  const specs = `
    <div class="tab-panel">
      <div class="sec"><table class="spec-t">
        <tr><td>Property Name</td><td>${p.name}</td></tr>
        <tr><td>Builder</td><td>${p.builder}</td></tr>
        <tr><td>Type</td><td>${p.type}</td></tr>
        <tr><td>Location</td><td>${p.location}</td></tr>
        <tr><td>Configuration</td><td>${p.config}</td></tr>
        <tr><td>Area Range</td><td>${p.sqftRange||'—'}</td></tr>
        <tr><td>Total Units</td><td>${p.totalUnits||'—'}</td></tr>
        <tr><td>Land Area</td><td>${p.totalLandArea||'—'}</td></tr>
        <tr><td>Starting Price</td><td>${p.startingPrice}</td></tr>
        <tr><td>Price / SqFt</td><td>${p.pricePerSqft||'—'}</td></tr>
        <tr><td>Status</td><td>${p.status}</td></tr>
        <tr><td>Possession</td><td>${p.possession}</td></tr>
        <tr><td>Total Floors</td><td>${p.totalFloors||'—'}</td></tr>
        <tr><td>Parking</td><td>${p.parking?p.parking+' '+(p.parkingType||''):'—'}</td></tr>
        <tr><td>Vastu</td><td>${p.vastu||'—'}</td></tr>
        <tr><td>Availability</td><td>${p.availability||'—'}</td></tr>
        <tr><td>Contact</td><td>${p.contactName} — ${p.contactNumber}</td></tr>
      </table></div>
    </div>`;

  const pitch = `
    <div class="tab-panel">
      <div class="sec">
        <div class="summary-card">
          <div class="sum-lbl">💬 Sales Talking Points</div>
          <div class="sum-txt">
            <p><strong>${p.name}</strong> by ${p.builder} is a premium ${p.type.toLowerCase()} project in <strong>${p.location}</strong>.</p>
            <p>Offering ${p.config} configurations${p.sqftRange?` spanning ${p.sqftRange}`:''}, priced from <strong>${p.startingPrice}</strong>.</p>
            <p><strong>Possession:</strong> ${p.possession} · <strong>Status:</strong> ${p.status}</p>
            ${highlights.length?`<p><strong>Why buy:</strong> ${highlights.join(' · ')}</p>`:''}
            ${p.connectivity?`<p><strong>Connectivity:</strong> ${p.connectivity}</p>`:''}
            <p style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);"><strong>📞 Close with:</strong> "Shall I block a site visit for you this weekend? Call ${p.contactName} at ${p.contactNumber}."</p>
          </div>
        </div>
      </div>
    </div>`;

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
}

function showTab(name,btn){
  document.querySelectorAll('.dp-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  const idx=['overview','specs','pitch','notes'].indexOf(name);
  document.querySelectorAll('.tab-panel')[idx].classList.add('active');
}
function closeDetail(){document.getElementById('dp').classList.remove('open');}

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
const PROPERTY_TEMPLATE = {
  name: "Property Name Here",
  builder: "Builder Name",
  location: "Locality, Chennai",
  type: "Apartments",
  config: "2BHK / 3BHK",
  status: "Under Construction",
  possession: "Dec 2027",
  startingPrice: "₹60L+",
  pricePerSqft: "₹5500/Sqft",
  contactName: "Swaminathan",
  contactNumber: "98848 83370",
  totalUnits: "100",
  totalLandArea: "5 Acres",
  sqftRange: "900-1800 Sq.Ft",
  highlights: "Highlight One,Highlight Two,Highlight Three",
  amenities: "Swimming Pool,Gym,Clubhouse",
  nearby: "Nearby area",
  nearbyLandmark: "Landmark name",
  connectivity: "Metro / Road connectivity details",
  totalFloors: "G+5",
  vastu: "Yes",
  parking: "1",
  parkingType: "Covered",
  availability: "Available"
};

let pModalMode = 'add'; // 'add' | 'edit'
let pModalEditId = null;

function downloadTemplate(){
  downloadFile(JSON.stringify(PROPERTY_TEMPLATE, null, 2), '3pin_property_template.json', 'application/json');
  showToast('Template downloaded — fill it in and paste back here');
}

function openAddModal(){
  pModalMode = 'add'; pModalEditId = null;
  document.getElementById('pmTitle').textContent = 'Add New Property';
  document.getElementById('pmJson').value = '';
  document.getElementById('pmErr').classList.remove('show');
  document.getElementById('pModal').classList.add('open');
}

function openEditModal(id){
  const p = properties.find(x=>x.id===id);
  if(!p) return;
  pModalMode = 'edit'; pModalEditId = id;
  document.getElementById('pmTitle').textContent = 'Edit Property';
  document.getElementById('pmJson').value = JSON.stringify(p, null, 2);
  document.getElementById('pmErr').classList.remove('show');
  document.getElementById('pModal').classList.add('open');
}

function closePModal(){
  document.getElementById('pModal').classList.remove('open');
}

function savePModal(){
  const raw = document.getElementById('pmJson').value.trim();
  const errBox = document.getElementById('pmErr');
  if(!raw){ errBox.textContent='Please paste the property JSON.'; errBox.classList.add('show'); return; }
  let data;
  try{ data = JSON.parse(raw); }
  catch(e){ errBox.textContent='Invalid JSON — check for missing commas or quotes. ('+e.message+')'; errBox.classList.add('show'); return; }
  if(!data.name || !data.location){ errBox.textContent='Property must have at least a "name" and "location".'; errBox.classList.add('show'); return; }
  errBox.classList.remove('show');

  if(pModalMode==='add'){
    data.id = 'p'+Date.now();
    properties.unshift(data);
    showToast('✓ Property added successfully');
  } else {
    data.id = pModalEditId;
    const idx = properties.findIndex(p=>p.id===pModalEditId);
    if(idx>-1) properties[idx] = data;
    showToast('✓ Property updated successfully');
  }
  closePModal();
  refreshAfterDataChange();
  if(pModalMode==='edit') openDetail(data.id);
  window.dashboardFirebase.saveProperty(data);
}

function deleteProperty(id){
  const p = properties.find(x=>x.id===id);
  if(!p) return;
  if(!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
  properties = properties.filter(x=>x.id!==id);
  closeDetail();
  refreshAfterDataChange();
  showToast('Property deleted');
  window.dashboardFirebase.deleteProperty(id);
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
function exportProperty(id){const p=properties.find(x=>x.id===id);downloadFile(JSON.stringify(p,null,2),`${p.name.replace(/\s+/g,'_')}.json`,'application/json');showToast('JSON downloaded');}
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
function downloadFile(content,filename,type){
  const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}
function shareProperty(id){
  const p=properties.find(x=>x.id===id);
  const text=`${p.name}, ${p.location} — ${p.startingPrice} (${p.config}). Contact ${p.contactName}: ${p.contactNumber}`;
  if(navigator.share) navigator.share({title:p.name,text});
  else{navigator.clipboard.writeText(text);showToast('Details copied to clipboard');}
}
function printProperty(id){
  const p=properties.find(x=>x.id===id);const w=window.open('','_blank');
  w.document.write(`<html><head><title>${p.name}</title><style>body{font-family:Arial;padding:30px;color:#1c1917}h1{color:#B45309}table{width:100%;border-collapse:collapse;margin-top:16px}td{padding:8px 10px;border-bottom:1px solid #ddd}td:first-child{font-weight:bold;width:32%;color:#78716C}</style></head><body>
    <h1>${p.name}</h1><p><strong>${p.builder}</strong> · ${p.location}</p>
    <table>
      <tr><td>Starting Price</td><td>${p.startingPrice}</td></tr>
      <tr><td>Configuration</td><td>${p.config}</td></tr>
      <tr><td>Area</td><td>${p.sqftRange||'—'}</td></tr>
      <tr><td>Status</td><td>${p.status}</td></tr>
      <tr><td>Possession</td><td>${p.possession}</td></tr>
      <tr><td>Amenities</td><td>${p.amenities||'—'}</td></tr>
      <tr><td>Contact</td><td>${p.contactName} — ${p.contactNumber}</td></tr>
    </table></body></html>`);
  w.document.close();w.print();
}
function downloadBrochure(id){
  const p=properties.find(x=>x.id===id);
  const html=`<html><head><title>${p.name}</title></head><body style="font-family:Arial;padding:40px">
    <h1 style="color:#B45309">${p.name}</h1><h3>${p.builder} · ${p.location}</h3>
    <p><strong>Price:</strong> ${p.startingPrice} | <strong>Config:</strong> ${p.config} | <strong>Area:</strong> ${p.sqftRange||'—'}</p>
    <p><strong>Status:</strong> ${p.status} | <strong>Possession:</strong> ${p.possession}</p>
    <p><strong>Highlights:</strong> ${p.highlights||'—'}</p>
    <p><strong>Amenities:</strong> ${p.amenities||'—'}</p>
    <p><strong>Contact:</strong> ${p.contactName} — ${p.contactNumber}</p></body></html>`;
  downloadFile(html,`${p.name.replace(/\s+/g,'_')}_Brochure.html`,'text/html');showToast('Brochure downloaded');
}

// ═══════ TOAST ═══════
let toastTimer;
function showToast(msg){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2400);
}

// keyboard: ESC closes detail
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePModal();closeDetail();}});
window.addEventListener('DOMContentLoaded',()=>{
  if(window.pinAuth && window.pinAuth.isLoggedIn()){
    window.pinAuth.showApp();
    init();
  } else {
    window.pinAuth.showLogin();
  }
});
