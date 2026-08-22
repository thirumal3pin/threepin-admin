// ═══════ SHARED PROPERTY VIEW ═══════
// One copy of the property detail markup and its share/export actions, used
// by BOTH the dashboard's slide-over panel (dashboard.html) and the
// standalone single-property page (property.html). Keeping it here is what
// guarantees a shared link renders exactly what the panel renders — if this
// were duplicated the two would drift apart the first time either changed.
//
// Everything lives inside this IIFE so the small helpers below (isReady,
// splitList, escapeHtml) don't collide with app.js's top-level copies —
// two classic scripts share one global lexical scope, so a second top-level
// `const isReady` would be a hard SyntaxError, not a silent override.
//
// The host page registers a resolver, because each stores its properties
// differently: the dashboard searches its in-memory list, property.html
// just hands back the single doc it loaded.
(function(){
  let resolveProperty = () => null;

  const isReady = p => p.status === 'Ready to Move';
  const splitList = s => s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
  function escapeHtml(s){
    return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ── URL for one property. Same shape from both pages, so whatever is in
  // the address bar is always the link worth pasting into chat.
  function propertyUrl(id){
    return new URL('property.html?id=' + encodeURIComponent(id), location.href).href;
  }

  // ═══════ RENDERERS ═══════
  function hero(p){
    return `
    <div style="flex:1;min-width:240px;">
      <div class="dp-builder-tag">${p.propertyCode?escapeHtml(p.propertyCode)+' · ':''}${p.builder} · ${p.type}</div>
      <h1 class="dp-title">${p.name}</h1>
      <div class="dp-loc">📍 ${p.location}</div>
      <a href="tel:${p.contactNumber}" class="dp-call">📞 Call ${p.contactName} — ${p.contactNumber}</a>
    </div>
    <div class="dp-price-box">
      <div class="dp-price">${p.startingPrice}</div>
      ${p.pricePerSqft?`<div class="dp-psf">${p.pricePerSqft}</div>`:''}
      <div style="margin-top:8px;"><span class="badge ${isReady(p)?'bg':'ba'}">${isReady(p)?'✓ Ready to Move':'⏳ Under Construction'}</span></div>
    </div>`;
  }

  function overviewTab(p){
    const highlights = splitList(p.highlights);
    const amenities = splitList(p.amenities);
    return `
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
          <div class="export-btn" onclick="sharePropertyLink('${p.id}')"><div class="export-btn-icon">🔗</div>Share Link</div>
          <div class="export-btn" onclick="printProperty('${p.id}')"><div class="export-btn-icon">🖨️</div>Print</div>
          <div class="export-btn" onclick="exportProperty('${p.id}')"><div class="export-btn-icon">📄</div>JSON</div>
          <div class="export-btn" onclick="downloadBrochure('${p.id}')"><div class="export-btn-icon">📑</div>Brochure</div>
          <div class="export-btn" onclick="openPhotos('${p.id}')"><div class="export-btn-icon">🖼️</div>Photos</div>
          <div class="export-btn" onclick="shareProperty('${p.id}')"><div class="export-btn-icon">💬</div>Details</div>
        </div>
      </div>
    </div>`;
  }

  function specsTab(p){
    return `
    <div class="tab-panel">
      <div class="sec"><table class="spec-t">
        ${p.propertyCode?`<tr><td>Property Code</td><td>${escapeHtml(p.propertyCode)}</td></tr>`:''}
        <tr><td>Property Name</td><td>${p.name}</td></tr>
        <tr><td>Builder</td><td>${p.builder}</td></tr>
        <tr><td>Type</td><td>${p.type}</td></tr>
        <tr><td>Location</td><td>${p.location}</td></tr>
        <tr><td>Configuration</td><td>${p.config}</td></tr>
        <tr><td>Area Range</td><td>${p.sqftRange||'—'}</td></tr>
        <tr><td>Total Units</td><td>${p.totalUnits||'—'}</td></tr>
        <tr><td>Land Area</td><td>${p.totalLandArea||'—'}</td></tr>
        <tr><td>UDS</td><td>${p.uds||'—'}</td></tr>
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
  }

  function pitchTab(p){
    const highlights = splitList(p.highlights);
    return `
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
  }

  // ═══════ SHARE / EXPORT ACTIONS ═══════
  // Global by design — the markup above wires them through inline onclick,
  // exactly like the rest of this codebase does.
  function downloadFile(content,filename,type){
    const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
  }

  function copyToClipboard(text,okMsg){
    const done=()=>showToast(okMsg);
    if(navigator.clipboard&&window.isSecureContext){
      navigator.clipboard.writeText(text).then(done).catch(()=>fallbackCopy(text,done));
    } else fallbackCopy(text,done);
  }
  // Clipboard API needs HTTPS + a user gesture; this keeps Copy working on
  // plain-http previews and older mobile browsers instead of silently failing.
  function fallbackCopy(text,done){
    const ta=document.createElement('textarea');
    ta.value=text;ta.setAttribute('readonly','');
    ta.style.cssText='position:fixed;top:-1000px;opacity:0;';
    document.body.appendChild(ta);ta.select();
    try{ document.execCommand('copy'); done(); }
    catch(e){ showToast('Copy failed — select the text and copy manually'); }
    ta.remove();
  }

  // Phones get the OS share sheet (one tap straight into WhatsApp, which is
  // how these actually get sent); desktop gets a clipboard copy, because a
  // share sheet there is a detour when you're pasting into a chat window
  // that's already open. Pointer type is the honest signal for that, not
  // screen width — a small desktop window still wants copy.
  function prefersNativeShare(){
    return !!navigator.share && window.matchMedia('(pointer: coarse)').matches;
  }

  const COPIED_MSG = '🔗 Link copied — only logged-in team members can open it';

  function sharePropertyLink(id, ev){
    if(ev) ev.stopPropagation();
    if(!id) return;
    const p = resolveProperty(id);
    const url = propertyUrl(id);
    if(prefersNativeShare()){
      navigator.share({
        title: p ? p.name : 'Property',
        text: p ? `${p.name} — ${p.location} · ${p.startingPrice}` : '',
        url
      }).catch(err => {
        // Dismissing the sheet is a normal outcome, not a failure.
        if(err && err.name === 'AbortError') return;
        copyToClipboard(url, COPIED_MSG);
      });
      return;
    }
    copyToClipboard(url, COPIED_MSG);
  }

  function exportProperty(id){
    const p=resolveProperty(id); if(!p) return;
    downloadFile(JSON.stringify(p,null,2),`${p.name.replace(/\s+/g,'_')}.json`,'application/json');
    showToast('JSON downloaded');
  }

  function openPhotos(id){
    const p=resolveProperty(id); if(!p) return;
    if(!p.photosLink){showToast('No photos link saved for this property yet');return;}
    window.open(p.photosLink,'_blank','noopener');
  }

  function downloadBrochure(id){
    const p=resolveProperty(id); if(!p) return;
    const m=p.brochureLink&&p.brochureLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if(m){
      const a=document.createElement('a');
      a.href=`https://drive.google.com/uc?export=download&id=${m[1]}`;
      a.target='_blank';a.rel='noopener';
      document.body.appendChild(a);a.click();a.remove();
      showToast('Brochure downloading…');
      return;
    }
    showToast('No PDF brochure uploaded yet for this property');
  }

  // The CLIENT-facing WhatsApp blurb. Deliberately plain text with NO
  // property link in it: customers have no login, so an admin.threepin.in
  // URL would be dead weight to them and leaks an internal address. The
  // internal link is a separate action — sharePropertyLink above.
  function shareProperty(id){
    const p=resolveProperty(id); if(!p) return;
    const body=(p.detailsText&&p.detailsText.trim())
      ? p.detailsText.trim()
      : `${p.name}, ${p.location} — ${p.startingPrice} (${p.config}). Contact ${p.contactName}: ${p.contactNumber}`;
    document.getElementById('shareDetailsTa').value=body;
    document.getElementById('shareDetailsModal').classList.add('open');
  }
  function closeShareDetailsModal(){
    document.getElementById('shareDetailsModal').classList.remove('open');
  }
  function copyShareDetails(){
    const ta=document.getElementById('shareDetailsTa');
    ta.select();
    copyToClipboard(ta.value,'Copied to clipboard');
  }

  function printProperty(id){
    const p=resolveProperty(id); if(!p) return;
    const w=window.open('','_blank');
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

  // ═══════ TOAST ═══════
  let toastTimer;
  function showToast(msg){
    const t=document.getElementById('toast');
    if(!t) return;
    t.textContent=msg;t.classList.add('show');
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2400);
  }

  // ═══════ VIEWED-PROPERTY CACHE ═══════
  // Makes property.html paint instantly on a revisit: the last-seen copy is
  // rendered before Firebase has even finished loading, then replaced the
  // moment the live doc arrives (stale-while-revalidate). Bounded by how
  // many properties this browser has actually opened, at a few KB each.
  const CACHE_PREFIX = 'pinProp:';
  function cacheProperty(p){
    if(!p||!p.id) return;
    try{ localStorage.setItem(CACHE_PREFIX+p.id, JSON.stringify(p)); }
    catch(e){ /* quota or private mode — the cache is an optimisation only */ }
  }
  function cachedProperty(id){
    try{ const raw=localStorage.getItem(CACHE_PREFIX+id); return raw?JSON.parse(raw):null; }
    catch(e){ return null; }
  }

  // Click the backdrop to dismiss the share modal (both pages host one).
  document.addEventListener('click', e => {
    if(e.target && e.target.id === 'shareDetailsModal') closeShareDetailsModal();
  });

  // Share glyph, inline so it inherits currentColor and stays crisp beside
  // the monochrome ★ on each card.
  const SHARE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/></svg>';

  window.PinPropertyView = {
    setResolver: fn => { resolveProperty = fn; },
    hero, overviewTab, specsTab, pitchTab,
    propertyUrl, cacheProperty, cachedProperty,
    escapeHtml, isReady, splitList,
    SHARE_ICON, prefersNativeShare
  };

  // Shared globals the inline onclick handlers (and app.js) call by name.
  window.showToast = showToast;
  window.downloadFile = downloadFile;
  window.copyToClipboard = copyToClipboard;
  window.sharePropertyLink = sharePropertyLink;
  window.exportProperty = exportProperty;
  window.openPhotos = openPhotos;
  window.downloadBrochure = downloadBrochure;
  window.shareProperty = shareProperty;
  window.closeShareDetailsModal = closeShareDetailsModal;
  window.copyShareDetails = copyShareDetails;
  window.printProperty = printProperty;
})();
