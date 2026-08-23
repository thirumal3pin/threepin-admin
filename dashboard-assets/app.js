// ═══════ STATE ═══════
let properties = sampleData.map(p=>({...p}));
let filteredProperties = [...properties];
let selectedProperties = new Set();
// Favourites stay per-browser on purpose — they're a personal shortlist,
// not shared business data. Notes, events and interest level are the
// opposite: they moved into Firestore so the whole team sees the same
// history on every device (see the NOTES & EVENTS section below).
let favorites = JSON.parse(localStorage.getItem('pinFavorites')) || [];
let notes = {};        // property id -> [entry], filled on demand from Firestore
let notesLoaded = {};  // property id -> true once its subcollection was fetched
let currentStatus = 'all';
let currentType = 'all';
let currentSort = 'newest';
let showFavOnly = false;
let hideSoldOut = false;
let currentSearch = '';
let currentDetailId = null;

// ═══════ HELPERS ═══════
const isReady = p => p.status === 'Ready to Move';
const splitList = s => s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
// esc()/escapeHtml() live in property-view.js (loaded before this file) —
// property.html needs them too and doesn't load this file at all, so they
// can't be defined here.
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
  const norm = {'Apartment':'Apartments','Apartments':'Apartments','Plot':'Plots','Plots':'Plots','Villa':'Villa','Residential':'Residential','Townhouse':'Townhouse','Independent House':'House'};
  // filter(Boolean) keeps a property with no type from producing an
  // "undefined" filter button — the pipeline can write one at any time.
  const groups = [...new Set(properties.map(p => norm[p.type]||p.type).filter(Boolean))].sort();
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
      // sheetNotes/detailsText/zone included so free-text facts ("negotiable",
      // a seller situation, a zone name) are findable, not just structured ones.
      const hay = [p.propertyCode,p.name,p.location,p.zone,p.builder,p.config,p.amenities,p.highlights,p.type,p.sheetNotes,p.detailsText,p.furnishing,p.facing].join(' ').toLowerCase();
      if(!hay.includes(currentSearch)) return false;
    }
    return true;
  });
  if(currentSort==='price-low') res.sort((a,b)=>priceValue(a)-priceValue(b));
  else if(currentSort==='price-high') res.sort((a,b)=>priceValue(b)-priceValue(a));
  // String()-wrapped because the brochure pipeline only guarantees the fields
  // it computes itself — name comes through from the source JSON and can be
  // absent, which used to throw here and take the entire grid down with it.
  else if(currentSort==='name') res.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
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
    const e = esc(p);
    const fav = favorites.includes(p.id);
    const sel = selectedProperties.has(p.id);
    const isSoldOut = !!p.soldOut;
    const pType = p.type||'';
    const typeBadge = pType.includes('Plot')?'bs':pType.includes('Villa')||pType.includes('House')?'bp':'bb';
    return `
    <div class="card ${isSoldOut?'sold-out':''}">
      <div class="card-bar ${isReady(p)?'rtm':'uc'}"></div>
      ${isSoldOut?'<div class="sold-out-overlay"><div class="sold-out-overlay-text">SOLD OUT</div></div>':''}
      <div class="card-body" onclick="openDetail('${e.id}')">
        <div class="card-r1">
          <div>
            <div class="card-name">${e.propertyCode?`<span class="card-code-inline">${e.propertyCode}</span> — `:''}${e.name}</div>
            <div class="card-loc">📍 ${e.location}</div>
          </div>
          <div class="card-actions" onclick="event.stopPropagation()">
            <button class="card-action-btn card-share" onclick="sharePropertyLink('${e.id}',event)" title="Share internal link" aria-label="Share internal link">${PinPropertyView.SHARE_ICON}</button>
            <button class="card-action-btn card-star ${fav?'active':''}" onclick="toggleFavorite('${e.id}',event)" title="Save">★</button>
          </div>
        </div>
        <div class="badges">
          <span class="badge ${isReady(p)?'bg':'ba'}">${isReady(p)?'✓ Ready to Move':'⏳ '+e.possession}</span>
          <span class="badge ${typeBadge}">${e.config}</span>
        </div>
        <div class="price-row">
          <div>
            <div class="price-lbl">Starting Price</div>
            <div class="price-main">${e.startingPrice}</div>
          </div>
          ${e.pricePerSqft?`<div class="price-psf">${e.pricePerSqft}</div>`:''}
        </div>
        <div class="card-stats">
          <div class="cst"><div class="cst-l">Area</div><div class="cst-v">${e.sqftRange||'—'}</div></div>
          <div class="cst"><div class="cst-l">Type</div><div class="cst-v">${e.type}</div></div>
        </div>
        <div class="card-foot">
          <div class="card-bldr">${e.builder}</div>
          <div class="card-res" title="Brochure · Photos · Map Pin · Details">${PinPropertyView.resourceChips(p, true)}</div>
          <label class="card-cmp" onclick="event.stopPropagation()">
            <input type="checkbox" ${sel?'checked':''} onchange="toggleSelection('${e.id}',this)"> Compare
          </label>
        </div>
      </div>
      <div class="card-cta">
        <a href="tel:${encodeURIComponent(p.contactNumber||'')}" class="cta-btn cta-call" onclick="event.stopPropagation()">📞 Call</a>
        <div class="cta-btn cta-view" onclick="openDetail('${e.id}')">View Details →</div>
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
    recordChanges(p, 'update', [{
      field:'soldOut', label:'Sold Out',
      from: prev ? 'Yes' : 'No', to: p.soldOut ? 'Yes' : 'No'
    }]);
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
  const comp = Array.from(selectedProperties).map(id=>properties.find(p=>p.id===id)).filter(Boolean).map(esc);
  if(comp.length<2){showToast('Select at least 2 properties to compare');return;}
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

  const lvl = p.interestLevel || '';
  const crm = `
    <div class="tab-panel">
      <div class="sec">
        <div class="sec-title">👤 Client Interest Level</div>
        <div class="interest-buttons">
          <button class="interest-btn hot ${lvl==='hot'?'active':''}" data-lvl="hot" onclick="setInterest('${id}','hot')">🔥 Hot Lead</button>
          <button class="interest-btn warm ${lvl==='warm'?'active':''}" data-lvl="warm" onclick="setInterest('${id}','warm')">🌡️ Warm</button>
          <button class="interest-btn cold ${lvl==='cold'?'active':''}" data-lvl="cold" onclick="setInterest('${id}','cold')">❄️ Cold</button>
        </div>
      </div>
      <div class="sec">
        <div class="sec-title">📝 Notes & Events</div>
        <div id="notesPanel">${renderNotes(id)}</div>
        <div class="note-add">
          <div class="note-add-row">
            <select class="note-kind-sel" id="noteKind" onchange="onNoteKindChange()">
              ${Object.entries(NOTE_KINDS).map(([k,v])=>`<option value="${k}">${v.icon} ${escapeHtml(v.label)}</option>`).join('')}
            </select>
            <span class="note-date-wrap" id="noteDateWrap" style="display:none;">
              <input type="date" class="note-date" id="noteDate" title="Date this happened / is due">
            </span>
          </div>
          <div class="note-add-row">
            <input class="note-input" id="noteInput" placeholder="What happened? (e.g. client budget, site visit outcome, revised price)…" onkeydown="if(event.key==='Enter')addNoteInline('${id}')">
            <button class="note-btn" onclick="addNoteInline('${id}')">Add</button>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('dpBody').innerHTML = overview + specs + pitch + crm;
  document.getElementById('dp').classList.add('open');
  // reset tabs
  document.querySelectorAll('.dp-tab').forEach((t,i)=>t.classList.toggle('active',i===0));
  // Notes live in a subcollection, so they arrive after the panel paints —
  // repaintNotes() checks currentDetailId before writing, so a slow response
  // for a property the user already navigated away from is discarded.
  loadPropertyNotes(id);
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

// ═══════ NOTES & EVENTS ═══════
// Stored in Firestore under properties/{id}/notes so every teammate on the
// tenant sees the same history — the previous localStorage version was
// per-browser, invisible to anyone else and lost whenever site data was
// cleared. Each entry is either a free-text note or a dated event; both
// share one collection so the panel can show a single chronological log.
const NOTE_KINDS = {
  note:    { label:'Note',          icon:'📝' },
  visit:   { label:'Site Visit',    icon:'🏠' },
  call:    { label:'Client Call',   icon:'📞' },
  price:   { label:'Price Update',  icon:'💰' },
  status:  { label:'Status Change', icon:'🔔' },
  booking: { label:'Booking',       icon:'🤝' }
};

// Newest first, using the event date when one was given and the creation
// timestamp otherwise, so a back-dated site visit files itself correctly.
function noteSortValue(n){
  if(n.eventDate){ const t = Date.parse(n.eventDate); if(!isNaN(t)) return t; }
  return Number(n.createdAt) || 0;
}
function sortedNotes(id){
  return [...(notes[id]||[])].sort((a,b)=>noteSortValue(b)-noteSortValue(a));
}

function formatNoteWhen(n){
  if(n.eventDate){
    const d = new Date(n.eventDate);
    if(!isNaN(d)) return d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
  }
  if(n.createdAt) return new Date(Number(n.createdAt)).toLocaleString();
  return '';
}

function renderNotes(id){
  if(!notesLoaded[id]) return `<div class="empty-mini">Loading notes…</div>`;
  const list = sortedNotes(id);
  if(!list.length) return `<div class="empty-mini">Nothing logged yet. Add the first note or event below.</div>`;
  return list.map(n=>{
    const kind = NOTE_KINDS[n.kind] || NOTE_KINDS.note;
    return `
    <div class="note-item">
      <div class="note-meta">
        <span class="note-kind note-kind-${escapeHtml(n.kind||'note')}">${kind.icon} ${escapeHtml(kind.label)}</span>
        <span class="note-time">${escapeHtml(formatNoteWhen(n))}</span>
        ${n.author?`<span class="note-author">${escapeHtml(n.author)}</span>`:''}
        <button class="note-delete" onclick="deleteNote('${escapeHtml(id)}','${escapeHtml(n.id)}')" title="Delete">×</button>
      </div>
      <div class="note-text">${escapeHtml(n.text)}</div>
    </div>`;
  }).join('');
}

function repaintNotes(id){
  const panel = document.getElementById('notesPanel');
  // Guard against a slow fetch landing after the user moved to another
  // property — otherwise it would paint one property's log into another's.
  if(panel && currentDetailId===id) panel.innerHTML = renderNotes(id);
}

// One-time lift of the old per-browser notes into Firestore, so nothing
// anyone typed before this change is lost. Runs only when the property has
// no server-side notes at all, so it can never duplicate an existing log.
async function migrateLegacyNotes(id){
  let legacy;
  try{ legacy = JSON.parse(localStorage.getItem('pinNotes')) || {}; }catch(e){ return []; }
  const list = legacy[id];
  if(!Array.isArray(list) || !list.length) return [];
  const migrated = list.map((n,i)=>({
    id: 'legacy_'+(n.id||Date.now()+i),
    text: String(n.text||''),
    kind: 'note',
    eventDate: '',
    createdAt: Number(n.id) || Date.now(),
    author: '(imported)'
  })).filter(n=>n.text);
  for(const n of migrated){
    try{ await window.dashboardFirebase.savePropertyNote(id, n); }catch(e){ return []; }
  }
  return migrated;
}

async function loadPropertyNotes(id){
  if(notesLoaded[id]){ repaintNotes(id); return; }
  try{
    let list = await window.dashboardFirebase.getPropertyNotes(id);
    if(!list.length) list = await migrateLegacyNotes(id);
    notes[id] = list;
    notesLoaded[id] = true;
  }catch(e){
    notes[id] = [];
    notesLoaded[id] = true;
    showToast('✗ Could not load notes — check your connection');
  }
  repaintNotes(id);
}

function onNoteKindChange(){
  const kind = document.getElementById('noteKind').value;
  document.getElementById('noteDateWrap').style.display = kind==='note' ? 'none' : '';
}

async function addNoteInline(id){
  const inp = document.getElementById('noteInput');
  const txt = inp.value.trim();
  if(!txt){ inp.focus(); return; }
  const kind = document.getElementById('noteKind').value || 'note';
  const eventDate = kind==='note' ? '' : (document.getElementById('noteDate').value || '');
  const entry = {
    id: 'n'+Date.now(),
    text: txt,
    kind,
    eventDate,
    createdAt: Date.now(),
    author: (window.dashboardAuth && window.dashboardAuth.getUserEmail()) || ''
  };
  if(!notes[id]) notes[id] = [];
  notes[id].push(entry);
  inp.value = '';
  document.getElementById('noteDate').value = '';
  repaintNotes(id);
  try{
    await window.dashboardFirebase.savePropertyNote(id, entry);
    showToast(kind==='note' ? 'Note added' : `${NOTE_KINDS[kind].label} logged`);
  }catch(e){
    notes[id] = notes[id].filter(n=>n.id!==entry.id);
    repaintNotes(id);
    showToast('✗ Could not save — check your connection and try again');
  }
}

async function deleteNote(id,noteId){
  const list = notes[id]||[];
  const removed = list.find(n=>n.id===noteId);
  if(!removed) return;
  notes[id] = list.filter(n=>n.id!==noteId);
  repaintNotes(id);
  try{
    await window.dashboardFirebase.deletePropertyNote(id, noteId);
    showToast('Entry deleted');
  }catch(e){
    notes[id].push(removed);
    repaintNotes(id);
    showToast('✗ Could not delete — check your connection and try again');
  }
}

// Interest level lives on the property document (not localStorage) so it
// shows up for the whole team and survives a browser reset.
async function setInterest(id,lvl){
  const p = properties.find(x=>x.id===id);
  if(!p) return;
  const prev = p.interestLevel || '';
  const next = prev===lvl ? '' : lvl;
  p.interestLevel = next;
  document.querySelectorAll('.interest-btn').forEach(b=>b.classList.toggle('active', b.dataset.lvl===next));
  try{
    await window.dashboardFirebase.saveProperty(p);
    showToast(next ? `Marked as ${lvl} lead` : 'Interest level cleared');
    recordChanges(p, 'update', [{
      field:'interestLevel', label:'Interest Level',
      from: prev || '', to: next || ''
    }]);
  }catch(e){
    p.interestLevel = prev;
    document.querySelectorAll('.interest-btn').forEach(b=>b.classList.toggle('active', b.dataset.lvl===prev));
    showToast('✗ Update failed — check your connection and try again');
  }
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
  const type = data.type || data.propertyType || 'Property';
  const builder = data.builder || 'Individual Owner';
  let startingPrice;
  if(data.startingPrice) startingPrice = data.startingPrice;
  else if(data.price) startingPrice = data.price;
  else if(data.priceInCr) startingPrice = `₹${data.priceInCr} Cr`;
  else startingPrice = 'Price on Request';
  let status;
  if(data.status){
    status = data.status;
  } else if(data.readyToMove !== undefined || data.newOrResale !== undefined){
    status = (data.readyToMove==='Yes' || data.newOrResale==='Resale') ? 'Ready to Move' : 'Under Construction';
  } else {
    status = 'Under Construction';
  }
  const possession = data.possession || data.possessionDate || 'Contact for details';
  const sqftRange = data.sqftRange || data.builtupArea || data.superBuiltupArea || data.carpetArea || '';
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
  // Diff before the array is mutated — afterwards pModalOriginalFull and the
  // stored entry are the same object and every field compares equal.
  const diffs = mode==='edit' ? diffPropertyFields(pModalOriginalFull, data) : [];
  data.updatedAt = Date.now();
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
    if(mode==='edit'){
      recordChanges(data, 'update', diffs);
    } else {
      recordChanges(data, 'create', [{
        field:'(property)', label:'New property added', from:'',
        to:`${data.name} — ${data.location}`
      }]);
    }
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
    // The full document goes into the change log, which is append-only —
    // so a delete stays recoverable instead of being gone for good.
    recordChanges(p, 'delete', [{
      field:'(property)', label:'Property deleted',
      from:`${p.name} — ${p.location}`, to:''
    }], { snapshot: JSON.stringify(p) });
  }catch(e){
    properties.unshift(p);
    refreshAfterDataChange();
    showToast('✗ Delete failed — check your connection and try again');
  }
}

// ═══════ CHANGE LOG ═══════
// The inventory sheet stays the place data is typed, and nothing writes back
// to it automatically. This log is the bridge: every edit made here is
// recorded with its before/after value so it can be found later and applied
// to the sheet by hand, then ticked off. It doubles as the only surviving
// copy of a deleted property, which is why delete records carry a full
// snapshot and why nothing in this collection is ever removed.
let changeLog = [];
let changeLogLoaded = false;
let changeFilter = 'pending'; // 'pending' | 'applied' | 'all'
let changeSearch = '';

function newChangeId(){
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

// Compares only the fields the edit form can actually change, so a value
// rewritten identically by normalizeProperty never shows up as a false edit.
function diffPropertyFields(before, after){
  const out = [];
  PROPERTY_FIELDS.forEach(f=>{
    const from = before && before[f.key]!=null ? String(before[f.key]) : '';
    const to   = after  && after[f.key]!=null  ? String(after[f.key])  : '';
    if(from !== to) out.push({ field:f.key, label:f.label, from, to });
  });
  return out;
}

function changeStamp(p){
  return {
    propertyId: p.id || '',
    propertyCode: p.propertyCode || '',
    propertyName: p.name || '',
    propertyLocation: p.location || '',
    propertyType: p.type || ''
  };
}

// Fire-and-forget on purpose: a failure to write the audit trail must never
// roll back or block the property edit the user actually asked for. It warns
// instead, so a silent gap in the log can't go unnoticed.
async function recordChanges(property, kind, diffs, extra){
  if(!diffs.length) return;
  const at = Date.now();
  const by = (window.dashboardAuth && window.dashboardAuth.getUserEmail()) || '';
  const stamp = changeStamp(property);
  const entries = diffs.map(d => ({
    id: newChangeId(),
    ...stamp, ...d,
    kind, at, by,
    appliedToSheet: false,
    ...(extra||{})
  }));
  changeLog = entries.concat(changeLog);
  renderChangesIfOpen();
  try{
    await window.dashboardFirebase.saveChanges(entries);
  }catch(e){
    changeLog = changeLog.filter(c => !entries.some(x => x.id === c.id));
    renderChangesIfOpen();
    showToast('⚠ Saved, but the change log entry failed to record');
  }
}

function refreshAfterDataChange(){
  setupTypeFilters();
  updateStats();
  applyFilters();
  updateMissingCount();
  renderMissing();
}

window.applyPropertiesSnapshot = function(list){
  properties = list;
  refreshAfterDataChange();
  migrateLegacyInterests();
};

// One-time lift of interest levels out of the old per-browser store and onto
// the property documents. Never overwrites a level already set on the server,
// and never clears localStorage — the original stays put as a fallback copy
// in case anything about the upload goes wrong.
let interestMigrationRan = false;
async function migrateLegacyInterests(){
  if(interestMigrationRan || !properties.length) return;
  interestMigrationRan = true;
  let legacy;
  try{ legacy = JSON.parse(localStorage.getItem('pinInterests')) || {}; }catch(e){ return; }
  let moved = 0;
  for(const [id,lvl] of Object.entries(legacy)){
    if(!lvl) continue;
    const p = properties.find(x=>x.id===id);
    if(!p || p.interestLevel) continue;
    p.interestLevel = lvl;
    try{ await window.dashboardFirebase.saveProperty(p); moved++; }
    catch(e){ p.interestLevel = ''; interestMigrationRan = false; return; }
  }
  if(moved) refreshAfterDataChange();
}

// ═══════ SYNC FROM INVENTORY SHEET ═══════
// Pulls the Inventory master sheet into the dashboard on demand, via
// api/sync-inventory.js. Always previews first: the button runs a dry run,
// shows exactly what would change, and only writes after confirmation — a
// sheet sync touches every property, so it should never be one careless click.
let syncBusy = false;

async function callSync(dryRun){
  const token = window.dashboardAuth && await window.dashboardAuth.getIdToken();
  if(!token) throw new Error('You appear to be signed out. Reload and sign in again.');
  const res = await fetch('/api/sync-inventory', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun })
  });
  let data;
  try{ data = await res.json(); }
  catch{ throw new Error(`Server returned ${res.status}. Try again in a moment.`); }
  if(!res.ok || data.error) throw new Error(data.error || `Sync failed (${res.status}).`);
  return data;
}

function renderSyncPreview(d){
  const rows = (d.changes || []).map(c => {
    const fields = (c.fields || []).map(f =>
      `<div class="sync-f"><span class="chg-field">${escapeHtml(f.field)}</span>
        <span class="chg-from">${escapeHtml(f.from || '—')}</span>
        <span class="chg-arrow">→</span>
        <span class="chg-to">${escapeHtml(f.to || '—')}</span></div>`).join('');
    return `<div class="sync-row ${c.kind==='create'?'new':''}">
      <div class="sync-head">
        <span class="chg-code">${escapeHtml(c.id)}</span>
        <span class="chg-name">${escapeHtml(c.name || '')}</span>
        <span class="sync-kind">${c.kind === 'create' ? 'NEW' : 'UPDATE'}</span>
      </div>
      ${fields}
      ${c.moreFields ? `<div class="sync-more">…and ${c.moreFields} more field${c.moreFields===1?'':'s'}</div>` : ''}
    </div>`;
  }).join('');

  return `
    <div class="sync-stats">
      <div class="sync-stat"><b>${d.created}</b><span>to add</span></div>
      <div class="sync-stat"><b>${d.updated}</b><span>to update</span></div>
      <div class="sync-stat"><b>${d.unchanged}</b><span>already current</span></div>
      <div class="sync-stat quiet"><b>${d.untouched}</b><span>not in sheet — untouched</span></div>
    </div>
    ${(d.created + d.updated) === 0
      ? `<div class="empty-mini">Everything already matches the sheet. Nothing to do.</div>`
      : `<div class="sync-list">${rows}</div>`}`;
}

async function openSyncModal(){
  if(syncBusy) return;
  syncBusy = true;
  const modal = document.getElementById('syncModal');
  const body = document.getElementById('syncBody');
  const btn = document.getElementById('syncApplyBtn');
  modal.classList.add('open');
  btn.style.display = 'none';
  body.innerHTML = '<div class="empty-mini">Reading the inventory sheet…</div>';
  try{
    const d = await callSync(true);
    body.innerHTML = renderSyncPreview(d);
    if((d.created + d.updated) > 0) btn.style.display = '';
  }catch(e){
    body.innerHTML = `<div class="pmodal-err show">${escapeHtml(e.message)}</div>`;
  }finally{
    syncBusy = false;
  }
}

async function applySync(){
  if(syncBusy) return;
  syncBusy = true;
  const body = document.getElementById('syncBody');
  const btn = document.getElementById('syncApplyBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try{
    const d = await callSync(false);
    body.innerHTML = `<div class="sync-done">✓ Synced ${d.written} propert${d.written===1?'y':'ies'} from the sheet.
      <div class="sync-done-sub">${d.untouched} propert${d.untouched===1?'y':'ies'} not in the sheet were left untouched.</div></div>`;
    btn.style.display = 'none';
    showToast(`✓ Synced ${d.written} propert${d.written===1?'y':'ies'}`);
    // The grid updates itself — the Firestore listener fires on every write.
  }catch(e){
    body.innerHTML = `<div class="pmodal-err show">${escapeHtml(e.message)}</div>`;
  }finally{
    btn.disabled = false;
    btn.textContent = '✓ Apply to dashboard';
    syncBusy = false;
  }
}

function closeSyncModal(){
  document.getElementById('syncModal').classList.remove('open');
}

// ═══════ MISSING DATA ═══════
// The agent's data-quality worklist: every property listed with the fields it
// still lacks, so gaps surface BEFORE a client call instead of during one.
// Each gap can be fixed in place (saved to the property + change log, ready
// to copy into the sheet later) or marked "Not required" for that property —
// stored on the doc as naFields, so a plot stops nagging about floor numbers.
const MISSING_FIELDS = [
  { key:'config',        label:'Configuration',   group:'Core' },
  { key:'sqftRange',     label:'Built-up Area',   group:'Core' },
  { key:'startingPrice', label:'Price',           group:'Core', empty:['Price on Request'] },
  { key:'pricePerSqft',  label:'Rate / Sqft',     group:'Core' },
  { key:'possession',    label:'Possession',      group:'Core', empty:['Contact for details'] },
  { key:'availability',  label:'Availability',    group:'Core' },
  { key:'totalLandArea', label:'Land Area',       group:'Specs' },
  { key:'uds',           label:'UDS',             group:'Specs' },
  { key:'totalUnits',    label:'Total Units',     group:'Specs' },
  { key:'totalFloors',   label:'Total Floors',    group:'Specs' },
  { key:'floorNo',       label:'Floor No',        group:'Specs' },
  { key:'facing',        label:'Facing',          group:'Specs' },
  { key:'bathrooms',     label:'Bathrooms',       group:'Specs' },
  { key:'parking',       label:'Parking',         group:'Specs' },
  { key:'furnishing',    label:'Furnishing',      group:'Specs' },
  { key:'vastu',         label:'Vastu',           group:'Specs' },
  { key:'powerBackup',   label:'Power Backup',    group:'Specs' },
  { key:'approval',      label:'Approval',        group:'Specs' },
  { key:'propertyAge',   label:'Property Age',    group:'Specs' },
  { key:'zone',          label:'Zone',            group:'Location' },
  { key:'mapLink',       label:'Location Pin',    group:'Location' },
  { key:'nearbyLandmark',label:'Landmark',        group:'Location' },
  { key:'connectivity',  label:'Connectivity',    group:'Location' },
  { key:'highlights',    label:'Highlights',      group:'Marketing' },
  { key:'amenities',     label:'Amenities',       group:'Marketing' },
  { key:'photosLink',    label:'Photos Link',     group:'Marketing' },
  { key:'brochureLink',  label:'Brochure',        group:'Marketing' },
  { key:'detailsText',   label:'Share Details',   group:'Marketing' },
  { key:'contactName',   label:'Contact Name',    group:'Contact' },
  { key:'contactNumber', label:'Contact Number',  group:'Contact' }
];

function fieldIsMissing(p, f){
  if(Array.isArray(p.naFields) && p.naFields.includes(f.key)) return false;
  const v = p[f.key];
  if(v == null || String(v).trim() === '') return true;
  // Placeholder defaults count as missing — "Price on Request" on the card
  // usually means "nobody entered the price", and the agent should know that.
  return Array.isArray(f.empty) && f.empty.includes(String(v).trim());
}
function missingFieldsOf(p){ return MISSING_FIELDS.filter(f => fieldIsMissing(p, f)); }

let missingSearch = '';
let missingOpenEditor = null; // `${propId}|${fieldKey}` of the expanded editor

function updateMissingCount(){
  const btn = document.getElementById('missingCountBadge');
  if(!btn) return;
  const n = properties.filter(p => missingFieldsOf(p).length).length;
  btn.textContent = n;
  btn.style.display = n ? '' : 'none';
}

function openMissing(){
  document.getElementById('missingPanel').classList.add('open');
  renderMissing();
}
function closeMissing(){
  document.getElementById('missingPanel').classList.remove('open');
  missingOpenEditor = null;
}
function onMissingSearch(v){ missingSearch = v.toLowerCase(); renderMissing(); }

function renderMissing(){
  const body = document.getElementById('missingBody');
  if(!body || !document.getElementById('missingPanel').classList.contains('open')) return;

  const list = properties
    .map(p => ({ p, miss: missingFieldsOf(p) }))
    .filter(x => x.miss.length)
    .filter(x => !missingSearch ||
      [x.p.propertyCode, x.p.name, x.p.location].join(' ').toLowerCase().includes(missingSearch))
    .sort((a,b) => b.miss.length - a.miss.length);

  const total = MISSING_FIELDS.length;
  document.getElementById('missingCount2').textContent =
    `${list.length} propert${list.length===1?'y':'ies'} with gaps`;

  if(!list.length){
    body.innerHTML = '<div class="empty-mini">🎉 Every property has all its agent-facing fields filled (or marked not required).</div>';
    return;
  }

  body.innerHTML = list.map(({p, miss}) => {
    const e = esc(p);
    const filled = total - miss.length;
    return `
    <div class="md-prop">
      <div class="md-head" onclick="openDetail('${e.id}')" title="Open property">
        <span class="chg-code">${e.propertyCode||e.id}</span>
        <span class="md-name">${e.name||'(unnamed)'}</span>
        <span class="md-loc">${e.location||''}</span>
        <span class="md-progress"><b>${filled}</b>/${total} filled</span>
      </div>
      <div class="md-chips">
        ${miss.map(f => {
          const ek = `${p.id}|${f.key}`;
          const open = missingOpenEditor === ek;
          return `<div class="md-chip-wrap${open?' open':''}">
            <button class="md-chip${open?' at':''}" onclick="toggleMissingEditor('${e.id}','${f.key}')">${escapeHtml(f.label)}</button>
            ${open?`<div class="md-editor">
              <input class="md-input" id="mdInput" placeholder="${escapeHtml(f.label)}…"
                onkeydown="if(event.key==='Enter')saveMissingField('${e.id}','${f.key}')">
              <button class="md-save" onclick="saveMissingField('${e.id}','${f.key}')">✓ Save</button>
              <button class="md-na" onclick="markFieldNA('${e.id}','${f.key}')" title="This field doesn't apply to this property">Not required</button>
            </div>`:''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');

  const inp = document.getElementById('mdInput');
  if(inp) inp.focus();
}

function toggleMissingEditor(propId, fieldKey){
  const ek = `${propId}|${fieldKey}`;
  missingOpenEditor = missingOpenEditor === ek ? null : ek;
  renderMissing();
}

async function saveMissingField(propId, fieldKey){
  const inp = document.getElementById('mdInput');
  const val = inp ? inp.value.trim() : '';
  if(!val){ if(inp) inp.focus(); return; }
  const p = properties.find(x => x.id === propId);
  if(!p) return;
  const f = MISSING_FIELDS.find(x => x.key === fieldKey);
  const prev = p[fieldKey] != null ? String(p[fieldKey]) : '';
  p[fieldKey] = val;
  p.updatedAt = Date.now();
  missingOpenEditor = null;
  renderMissing();
  updateMissingCount();
  try{
    await window.dashboardFirebase.saveProperty(p);
    showToast(`✓ ${f ? f.label : fieldKey} saved`);
    recordChanges(p, 'update', [{ field: fieldKey, label: (f?f.label:fieldKey), from: prev, to: val }]);
    refreshAfterDataChange();
  }catch(e){
    p[fieldKey] = prev;
    renderMissing();
    updateMissingCount();
    showToast('✗ Save failed — check your connection and try again');
  }
}

async function markFieldNA(propId, fieldKey){
  const p = properties.find(x => x.id === propId);
  if(!p) return;
  const f = MISSING_FIELDS.find(x => x.key === fieldKey);
  const prevNA = Array.isArray(p.naFields) ? [...p.naFields] : [];
  // Stored as an array (not a map) deliberately: Firestore's merge deep-merges
  // maps, so a removed key would silently come back — arrays replace whole.
  p.naFields = [...new Set([...prevNA, fieldKey])];
  missingOpenEditor = null;
  renderMissing();
  updateMissingCount();
  try{
    await window.dashboardFirebase.saveProperty(p);
    showToast(`${f ? f.label : fieldKey} marked not required for this property`);
    recordChanges(p, 'update', [{ field: fieldKey, label: (f?f.label:fieldKey)+' (not required)', from: '(missing)', to: 'N/A for this property' }]);
  }catch(e){
    p.naFields = prevNA;
    renderMissing();
    updateMissingCount();
    showToast('✗ Update failed — check your connection and try again');
  }
}

// ═══════ CHANGE LOG VIEW ═══════
function dayKey(ms){
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function dayLabel(key){
  const [y,m,d] = key.split('-').map(Number);
  const date = new Date(y, m-1, d);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((today - date) / 86400000);
  const long = date.toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  if(diff===0) return `Today · ${long}`;
  if(diff===1) return `Yesterday · ${long}`;
  return long;
}

async function openChanges(){
  document.getElementById('changesPanel').classList.add('open');
  if(!changeLogLoaded){
    document.getElementById('changesBody').innerHTML = '<div class="empty-mini">Loading change history…</div>';
    try{
      changeLog = await window.dashboardFirebase.getChanges();
      changeLogLoaded = true;
    }catch(e){
      document.getElementById('changesBody').innerHTML =
        '<div class="empty-mini">Could not load the change history — check your connection and reopen.</div>';
      return;
    }
  }
  renderChanges();
}
function closeChanges(){
  document.getElementById('changesPanel').classList.remove('open');
}
function renderChangesIfOpen(){
  const panel = document.getElementById('changesPanel');
  if(panel && panel.classList.contains('open') && changeLogLoaded) renderChanges();
}
function setChangeFilter(f, btn){
  changeFilter = f;
  document.querySelectorAll('#changesFilters .fbtn').forEach(b=>b.classList.remove('at'));
  btn.classList.add('at');
  renderChanges();
}
function onChangeSearch(v){
  changeSearch = v.toLowerCase();
  renderChanges();
}

function visibleChanges(){
  return changeLog.filter(c=>{
    if(changeFilter==='pending' && c.appliedToSheet) return false;
    if(changeFilter==='applied' && !c.appliedToSheet) return false;
    if(changeSearch){
      const hay = [c.propertyCode,c.propertyName,c.propertyLocation,c.label,c.from,c.to,c.by]
        .join(' ').toLowerCase();
      if(!hay.includes(changeSearch)) return false;
    }
    return true;
  }).sort((a,b)=>(b.at||0)-(a.at||0));
}

function renderChanges(){
  const body = document.getElementById('changesBody');
  const list = visibleChanges();
  const pending = changeLog.filter(c=>!c.appliedToSheet).length;
  document.getElementById('changesCount').textContent =
    `${pending} pending · ${changeLog.length} total`;

  if(!list.length){
    body.innerHTML = `<div class="empty-mini">${
      changeLog.length ? 'No changes match this filter.'
                       : 'No changes recorded yet. Every edit you make here will be listed for you to carry across to the sheet.'
    }</div>`;
    return;
  }

  // Grouped by day, newest first — this is the view used to work through
  // the sheet, so the date heading is the unit of work, not decoration.
  const groups = [];
  const byDay = {};
  list.forEach(c=>{
    const k = dayKey(c.at||0);
    if(!byDay[k]){ byDay[k]=[]; groups.push(k); }
    byDay[k].push(c);
  });

  body.innerHTML = groups.map(k=>`
    <div class="chg-day">
      <div class="chg-day-hdr">${escapeHtml(dayLabel(k))}<span class="chg-day-n">${byDay[k].length}</span></div>
      ${byDay[k].map(c=>renderChangeRow(c)).join('')}
    </div>`).join('');
}

function renderChangeRow(c){
  const time = c.at ? new Date(c.at).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}) : '';
  const code = c.propertyCode || c.propertyId || '';
  const line = [c.propertyName, c.propertyLocation].filter(Boolean).join(' · ');
  const kindCls = c.kind==='delete' ? 'del' : c.kind==='create' ? 'new' : '';
  return `
    <div class="chg-row ${c.appliedToSheet?'applied':''} ${kindCls}">
      <label class="chg-tick" title="${c.appliedToSheet?'Applied to the sheet':'Mark once you have updated the sheet'}">
        <input type="checkbox" ${c.appliedToSheet?'checked':''} onchange="toggleChangeApplied('${escapeHtml(c.id)}',this)">
      </label>
      <div class="chg-main">
        <div class="chg-prop">
          ${code?`<span class="chg-code">${escapeHtml(code)}</span>`:''}
          <span class="chg-name">${escapeHtml(line||'(unnamed property)')}</span>
        </div>
        <div class="chg-delta">
          <span class="chg-field">${escapeHtml(c.label||c.field||'')}</span>
          <span class="chg-from">${escapeHtml(c.from||'—')}</span>
          <span class="chg-arrow">→</span>
          <span class="chg-to">${escapeHtml(c.to||'—')}</span>
        </div>
      </div>
      <div class="chg-meta">
        <span>${escapeHtml(time)}</span>
        ${c.by?`<span class="chg-by">${escapeHtml(c.by)}</span>`:''}
      </div>
    </div>`;
}

async function toggleChangeApplied(changeId, cb){
  const c = changeLog.find(x=>x.id===changeId);
  if(!c) return;
  const prev = !!c.appliedToSheet;
  c.appliedToSheet = cb.checked;
  renderChanges();
  try{
    await window.dashboardFirebase.setChangeApplied(changeId, c.appliedToSheet);
  }catch(e){
    c.appliedToSheet = prev;
    renderChanges();
    showToast('✗ Could not update — check your connection and try again');
  }
}

// Exports what is currently on screen, so filtering to "pending" and
// exporting gives exactly the list of edits still to be made in the sheet.
function exportChangesCsv(){
  const list = visibleChanges();
  if(!list.length){ showToast('Nothing to export in this view'); return; }
  const headers = ['Date','Time','Property Code','Property','Location','Field','From','To','Changed By','Applied To Sheet'];
  const rows = list.map(c=>{
    const d = new Date(c.at||0);
    return [
      d.toLocaleDateString(), d.toLocaleTimeString(),
      c.propertyCode||c.propertyId||'', c.propertyName||'', c.propertyLocation||'',
      c.label||c.field||'', c.from||'', c.to||'', c.by||'',
      c.appliedToSheet?'Yes':'No'
    ];
  });
  const csv = [headers,...rows]
    .map(r=>r.map(v=>`"${String(v==null?'':v).replace(/"/g,'""')}"`).join(','))
    .join('\n');
  downloadFile('﻿'+csv, `3pin_changes_${Date.now()}.csv`, 'text/csv;charset=utf-8');
  showToast(`${list.length} change${list.length===1?'':'s'} exported`);
}

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
