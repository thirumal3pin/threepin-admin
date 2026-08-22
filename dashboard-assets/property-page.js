// ═══════ STANDALONE SINGLE-PROPERTY PAGE ═══════
// Controller for property.html — the shareable per-property URL.
//
// Speed is the whole point of this page, so it paints in three stages and
// never blocks on the slowest one:
//   1. Cached copy (if this browser has opened the property before) renders
//      immediately, before Firebase has even downloaded.
//   2. Otherwise a skeleton shows, so the page is never blank.
//   3. The live Firestore doc arrives and replaces whichever of those showed.
// A single-doc listener does that in one document read rather than pulling
// the whole inventory the way the dashboard grid has to.

const params = new URLSearchParams(location.search);
const propertyId = params.get('id') || '';

let currentProperty = null;
let unsubscribe = null;
let renderedOnce = false;

let favorites = JSON.parse(localStorage.getItem('pinFavorites')) || [];

// The shared actions in property-view.js ask for properties by id; this page
// only ever holds one.
PinPropertyView.setResolver(id => (currentProperty && currentProperty.id === id) ? currentProperty : null);

// ═══════ RENDER ═══════
function renderProperty(p){
  currentProperty = p;
  renderedOnce = true;
  document.title = `${p.name} — 3 PIN Realty`;
  document.getElementById('dpHero').innerHTML = PinPropertyView.hero(p);
  document.getElementById('dpBody').innerHTML =
    PinPropertyView.overviewTab(p) + PinPropertyView.specsTab(p) + PinPropertyView.pitchTab(p);
  document.querySelector('.dp-tabs').style.display = 'flex';
  document.querySelectorAll('.dp-tab').forEach((t,i)=>t.classList.toggle('active',i===0));
  document.getElementById('dpHdrActions').style.display = 'flex';
  syncFavButton();
}

function syncFavButton(){
  if(!currentProperty) return;
  const on = favorites.includes(currentProperty.id);
  const btn = document.getElementById('dpFav');
  btn.classList.toggle('active', on);
  btn.textContent = on ? '★ Saved' : '★ Save';
}

function showMessage(title, detail){
  document.querySelector('.dp-tabs').style.display = 'none';
  document.getElementById('dpHdrActions').style.display = 'none';
  document.getElementById('dpHero').innerHTML =
    `<div><div class="dp-builder-tag">Property</div><h1 class="dp-title">${PinPropertyView.escapeHtml(title)}</h1></div>`;
  document.getElementById('dpBody').innerHTML = `
    <div class="nores">
      <div class="nores-i">🏡</div>
      <div class="nores-t">${PinPropertyView.escapeHtml(title)}</div>
      <div class="nores-s">${PinPropertyView.escapeHtml(detail)}</div>
      <div style="margin-top:22px;"><a href="dashboard.html" class="dp-call">← Back to all properties</a></div>
    </div>`;
}

// Grey placeholder blocks in the real layout's shape — the page reads as
// "loading" rather than "broken" while the first document read is in flight.
function showSkeleton(){
  document.getElementById('dpHero').innerHTML = `
    <div style="flex:1;min-width:240px;">
      <div class="sk sk-sm"></div><div class="sk sk-lg"></div><div class="sk sk-md"></div>
    </div>`;
  document.getElementById('dpBody').innerHTML = `
    <div class="sec"><div class="sk sk-md"></div>
      <div class="stats-g">${'<div class="stat-b"><div class="sk sk-sm"></div><div class="sk sk-xs"></div></div>'.repeat(6)}</div>
    </div>
    <div class="sec"><div class="sk sk-md"></div><div class="sk sk-row"></div><div class="sk sk-row"></div></div>`;
}

// ═══════ ACTIONS ═══════
function toggleFavFromDetail(){
  if(!currentProperty) return;
  const id = currentProperty.id;
  const i = favorites.indexOf(id);
  if(i===-1){ favorites.push(id); showToast('★ Added to favorites'); }
  else { favorites.splice(i,1); showToast('Removed from favorites'); }
  localStorage.setItem('pinFavorites', JSON.stringify(favorites));
  syncFavButton();
}

function openLeadCrm(){
  if(!currentProperty) return;
  window.location.href = 'crm.html?propertyId=' + encodeURIComponent(currentProperty.id);
}

function openInDashboard(){
  window.location.href = 'dashboard.html';
}

function showTab(name, btn){
  document.querySelectorAll('.dp-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  const idx = ['overview','specs','pitch'].indexOf(name);
  const panels = document.querySelectorAll('.tab-panel');
  if(panels[idx]) panels[idx].classList.add('active');
}

// ═══════ BOOT ═══════
// Paint the cached copy the moment the script runs — this happens whether or
// not the user is signed in yet, but only ever shows data this same browser
// already had, so it exposes nothing new.
if(propertyId){
  const cached = PinPropertyView.cachedProperty(propertyId);
  if(cached) renderProperty(cached);
  else showSkeleton();
} else {
  showMessage('No property specified', 'This link is missing its property id.');
}

// Called by firebase-sync.js once the tenant claim is resolved.
window.onPinTenantReady = function(){
  if(!propertyId) return;
  if(unsubscribe) return;
  unsubscribe = window.dashboardFirebase.subscribeToProperty(
    propertyId,
    p => {
      if(!p){
        showMessage('Property not found', `No property matches "${propertyId}". It may have been deleted, or the link may be for a different account.`);
        return;
      }
      PinPropertyView.cacheProperty(p);
      renderProperty(p);
    },
    () => {
      // A permission error here means the signed-in account belongs to a
      // different tenant — the rules did their job. Don't leave a stale
      // cached copy on screen pretending it's live.
      if(!renderedOnce || currentProperty){
        showMessage('No access to this property', 'This property belongs to a different account. Ask whoever shared the link to add you, or log in with the right account.');
        currentProperty = null;
      }
    }
  );
};

// Auth gate — mirrors dashboard-assets/auth.js, minus the dashboard's init().
window.onDashboardAuthChange = function(user){
  if(user){
    document.getElementById('loginScreen').classList.remove('open');
    document.getElementById('appRoot').style.display = '';
  } else {
    if(unsubscribe){ unsubscribe(); unsubscribe = null; }
    document.getElementById('loginScreen').classList.add('open');
    document.getElementById('appRoot').style.display = 'none';
  }
};

window.pinAuth = {
  attemptLogin: function(e){
    e.preventDefault();
    const email = document.getElementById('loginUser').value.trim();
    const password = document.getElementById('loginPass').value;
    const errBox = document.getElementById('loginErr');
    errBox.classList.remove('show');
    window.dashboardAuth.login(email, password).catch(()=>{
      errBox.textContent = 'Invalid email or password.';
      errBox.classList.add('show');
    });
  },
  logout: () => window.dashboardAuth.logout()
};

document.addEventListener('keydown', e => { if(e.key==='Escape') closeShareDetailsModal(); });
