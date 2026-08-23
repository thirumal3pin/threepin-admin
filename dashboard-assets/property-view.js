// ═══════ SHARED PROPERTY VIEW ═══════
// One copy of the property detail markup and its share/export actions, used
// by BOTH the dashboard's slide-over panel (dashboard.html) and the
// standalone single-property page (property.html). Keeping it here is what
// guarantees a shared link renders exactly what the panel renders — if this
// were duplicated the two would drift apart the first time either changed.
//
// esc()/escapeHtml() also live here rather than in app.js: property.html
// doesn't load app.js at all, so anything the shared templates need for
// safe HTML interpolation has to be defined in this file, loaded first.
//
// Everything lives inside this IIFE so these top-level names don't collide
// with app.js's own — two classic scripts share one global lexical scope,
// so a second top-level `const isReady` would be a hard SyntaxError, not a
// silent override.
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

  // Every property field is free text — typed into the Google Form intake,
  // pasted from a listing, or read out of the inventory sheet — so it can
  // legitimately contain &, <, > or quotes. Interpolating it raw into the
  // card/detail templates silently mangled such values (a name with "&" or a
  // dimension written as 2<3 broke the surrounding markup) and let anything
  // pasted into the intake form inject script. esc() returns a shallow copy
  // with every string escaped, for use in HTML interpolation only —
  // filtering, sorting and saving all keep using the raw property object.
  // A missing key reads as '' rather than the literal text "undefined". The
  // pipeline passes through whatever the source JSON contained, so any field
  // can legitimately be absent on a scheduler-created property — without
  // this, those cards rendered "undefined" in the badge and stat rows.
  function esc(p){
    const out = {};
    for(const k in p) out[k] = typeof p[k] === 'string' ? escapeHtml(p[k]) : p[k];
    return new Proxy(out, { get:(t,k)=> k in t ? t[k] : '' });
  }

  // ── URL for one property. Same shape from both pages, so whatever is in
  // the address bar is always the link worth pasting into chat.
  function propertyUrl(id){
    return new URL('property.html?id=' + encodeURIComponent(id), location.href).href;
  }

  // The sheet's Location_Pin column holds either a real Maps URL or just a
  // place name (both occur in live data). A name still deserves a working
  // pin — it becomes a Maps search for that name plus the locality.
  function mapsHref(p){
    const v = String(p.mapLink||'').trim();
    if(!v) return '';
    if(/^https?:\/\//i.test(v)) return v;
    return 'https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(v + (p.location ? ', ' + p.location : ''));
  }

  // What an agent needs to know they can send RIGHT NOW, before the client
  // asks: brochure, photos, location pin, shareable details. Rendered as one
  // chips row — green means one tap away, dimmed means not on file yet.
  function resourceChips(p, compact){
    const items = [
      { ok: !!(p.brochureLink && String(p.brochureLink).trim()), icon:'📑', label:'Brochure' },
      { ok: !!(p.photosLink && String(p.photosLink).trim()),     icon:'🖼️', label:'Photos' },
      { ok: !!mapsHref(p),                                       icon:'📍', label:'Map Pin' },
      { ok: !!(p.detailsText && String(p.detailsText).trim()),   icon:'💬', label:'Details' }
    ];
    return items.map(it =>
      `<span class="res-chip ${it.ok?'have':'miss'}" title="${it.label}${it.ok?' available':' not on file yet'}">` +
      `${it.icon}${compact?'':' '+it.label+' '+(it.ok?'✓':'—')}</span>`).join('');
  }

  // ═══════ RENDERERS ═══════
  function hero(p){
    const e = esc(p);
    const map = mapsHref(p);
    return `
    <div style="flex:1;min-width:240px;">
      <div class="dp-builder-tag">${e.propertyCode?e.propertyCode+' · ':''}${e.builder} · ${e.type}${e.saleType?' · '+e.saleType:''}${e.zone?' · '+e.zone:''}</div>
      <h1 class="dp-title">${e.name}</h1>
      <div class="dp-loc">📍 ${e.location}${map?` &nbsp;<a class="dp-maplink" href="${escapeHtml(map)}" target="_blank" rel="noopener">Open Map Pin ↗</a>`:''}</div>
      <a href="tel:${encodeURIComponent(p.contactNumber||'')}" class="dp-call">📞 Call ${e.contactName} — ${e.contactNumber}</a>
      <div class="res-chips">${resourceChips(p)}</div>
    </div>
    <div class="dp-price-box">
      <div class="dp-price">${e.startingPrice}</div>
      ${e.pricePerSqft?`<div class="dp-psf">${e.pricePerSqft}</div>`:''}
      <div style="margin-top:8px;"><span class="badge ${isReady(p)?'bg':'ba'}">${isReady(p)?'✓ Ready to Move':'⏳ '+(e.constructionStage||'Under Construction')}</span></div>
      ${e.propertyAge?`<div class="dp-age">${e.propertyAge}</div>`:''}
    </div>`;
  }

  // Renders every inventory-sheet column that has no dedicated field of its
  // own, straight from the sheetExtras map the sync writes. Because it loops
  // over whatever keys are present rather than a fixed list, a column that
  // only some properties use — or a new one added to the sheet later — shows
  // up here automatically with no code change. Long free-text cells (the
  // notes column especially, which holds many separate details in one cell)
  // keep their line breaks instead of collapsing into a paragraph.
  function renderSheetExtras(p){
    const extras = p.sheetExtras;
    if(!extras || typeof extras !== 'object') return '';
    const keys = Object.keys(extras).filter(k => {
      const v = extras[k];
      return v != null && String(v).trim() !== '';
    }).sort();
    if(!keys.length) return '';
    return `
      <div class="sec">
        <div class="sec-title">📋 From the Inventory Sheet</div>
        <div class="sheet-wrap">
          ${keys.map(k=>{
            const val = String(extras[k]).trim();
            const isLong = val.length > 90 || val.includes('\n');
            return `<div class="sheet-row${isLong?' sheet-row-long':''}">
              <div class="sheet-k">${escapeHtml(k)}</div>
              <div class="sheet-v">${escapeHtml(val)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  // The agent-on-a-call section: the sheet's free-text notes cell, which
  // holds the details that fit no structured column (pricing nuance, seller
  // situation, per-typology breakdowns). Rendered prominently, line breaks
  // intact — this is what keeps the agent ahead of the client.
  function sheetNotesBlock(p){
    const v = String(p.sheetNotes||'').trim();
    if(!v) return '';
    return `
      <div class="sec">
        <div class="sec-title">📝 Notes (Inventory Sheet)</div>
        <div class="sheetnotes">${escapeHtml(v)}</div>
      </div>`;
  }

  // The WhatsApp-ready description from the intake queue — the exact text
  // the client receives, so the agent can read from the same script.
  function detailsTextBlock(p){
    const v = String(p.detailsText||'').trim();
    if(!v) return '';
    return `
      <div class="sec">
        <div class="sec-title">💬 Shareable Details (WhatsApp copy)</div>
        <div class="detailstext">${escapeHtml(v)}</div>
        <button class="dt-copy" onclick="shareProperty('${escapeHtml(p.id||'')}')">📋 Open & Copy</button>
      </div>`;
  }

  function overviewTab(p){
    const e = esc(p);
    const highlights = splitList(p.highlights).map(escapeHtml);
    const amenities = splitList(p.amenities).map(escapeHtml);
    const sheetBlock = renderSheetExtras(p);
    const map = mapsHref(p);
    const fact = (v,l) => v ? `<div class="stat-b"><div class="stat-b-v">${v}</div><div class="stat-b-l">${l}</div></div>` : '';
    return `
    <div class="tab-panel active">
      <div class="sec">
        <div class="sec-title">📊 Key Facts</div>
        <div class="stats-g">
          <div class="stat-b"><div class="stat-b-v">${e.config||'—'}</div><div class="stat-b-l">Configuration</div></div>
          <div class="stat-b"><div class="stat-b-v">${e.sqftRange||'—'}</div><div class="stat-b-l">Area</div></div>
          <div class="stat-b"><div class="stat-b-v">${e.possession||'—'}</div><div class="stat-b-l">Possession</div></div>
          ${fact(e.floorNo,'Floor')}
          ${fact(e.facing,'Facing')}
          ${fact(e.bathrooms,'Bathrooms')}
          ${fact(e.furnishing,'Furnishing')}
          ${fact(e.parking?e.parking+(e.parkingType?' '+e.parkingType:''):'','Parking')}
          ${fact(e.totalUnits,'Total Units')}
          ${fact(e.totalFloors,'Floors')}
          ${fact(e.vastu,'Vastu')}
          ${fact(e.propertyAge,'Age')}
          ${fact(e.approval,'Approval')}
          ${fact(e.powerBackup,'Power Backup')}
        </div>
      </div>
      ${sheetNotesBlock(p)}
      ${highlights.length?`<div class="sec"><div class="sec-title">✨ Highlights</div><div class="hi-grid">${highlights.map(h=>`<div class="hi-item">✓ ${h}</div>`).join('')}</div></div>`:''}
      ${amenities.length?`<div class="sec"><div class="sec-title">🏢 Amenities</div><div class="am-wrap">${amenities.map(a=>`<span class="am-chip">${a}</span>`).join('')}</div></div>`:''}
      <div class="sec">
        <div class="sec-title">📍 Location & Connectivity</div>
        <div class="conn-wrap">
          ${e.zone?`<div class="conn-row"><div class="conn-k">Zone</div><div class="conn-v">${e.zone}</div></div>`:''}
          ${map?`<div class="conn-row"><div class="conn-k">Map Pin</div><div class="conn-v"><a href="${escapeHtml(map)}" target="_blank" rel="noopener" class="conn-maplink">📍 Open in Google Maps ↗</a></div></div>`:''}
          ${e.nearby?`<div class="conn-row"><div class="conn-k">Nearby</div><div class="conn-v">${e.nearby}</div></div>`:''}
          ${e.nearbyLandmark?`<div class="conn-row"><div class="conn-k">Landmark</div><div class="conn-v">${e.nearbyLandmark}</div></div>`:''}
          ${e.connectivity?`<div class="conn-row"><div class="conn-k">Connectivity</div><div class="conn-v">${e.connectivity}</div></div>`:''}
          ${!p.zone&&!map&&!p.nearby&&!p.nearbyLandmark&&!p.connectivity?`<div class="conn-row"><div class="conn-v">Information not available</div></div>`:''}
        </div>
      </div>
      ${detailsTextBlock(p)}
      ${sheetBlock}
      <div class="sec">
        <div class="sec-title">📤 Share & Export</div>
        <div class="export-g">
          <div class="export-btn" onclick="sharePropertyLink('${e.id}')"><div class="export-btn-icon">🔗</div>Share Link</div>
          <div class="export-btn" onclick="printProperty('${e.id}')"><div class="export-btn-icon">🖨️</div>Print</div>
          <div class="export-btn" onclick="exportProperty('${e.id}')"><div class="export-btn-icon">📄</div>JSON</div>
          <div class="export-btn" onclick="downloadBrochure('${e.id}')"><div class="export-btn-icon">📑</div>Brochure</div>
          <div class="export-btn" onclick="openPhotos('${e.id}')"><div class="export-btn-icon">🖼️</div>Photos</div>
          <div class="export-btn" onclick="shareProperty('${e.id}')"><div class="export-btn-icon">💬</div>Details</div>
        </div>
      </div>
    </div>`;
  }

  function specsTab(p){
    const e = esc(p);
    const map = mapsHref(p);
    const group = t => `<tr class="spec-group"><td colspan="2">${t}</td></tr>`;
    const link = (url,label) => url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${label} ↗</a>` : '—';
    return `
    <div class="tab-panel">
      <div class="sec"><table class="spec-t">
        ${group('Identity')}
        ${e.propertyCode?`<tr><td>Property Code</td><td>${e.propertyCode}</td></tr>`:''}
        <tr><td>Property Name</td><td>${e.name}</td></tr>
        <tr><td>Builder</td><td>${e.builder}</td></tr>
        <tr><td>Type</td><td>${e.type}${e.saleType?' · '+e.saleType:''}</td></tr>
        ${e.propertyAge?`<tr><td>Property Age</td><td>${e.propertyAge}</td></tr>`:''}
        ${group('Location')}
        <tr><td>Location</td><td>${e.location}</td></tr>
        ${e.zone?`<tr><td>Zone</td><td>${e.zone}</td></tr>`:''}
        <tr><td>Map Pin</td><td>${map?link(map,'Open in Google Maps'):'—'}</td></tr>
        ${e.nearby?`<tr><td>Nearby</td><td>${e.nearby}</td></tr>`:''}
        ${e.nearbyLandmark?`<tr><td>Landmark</td><td>${e.nearbyLandmark}</td></tr>`:''}
        ${e.connectivity?`<tr><td>Connectivity</td><td>${e.connectivity}</td></tr>`:''}
        ${group('Pricing & Status')}
        <tr><td>Starting Price</td><td>${e.startingPrice}</td></tr>
        <tr><td>Price / SqFt</td><td>${e.pricePerSqft||'—'}</td></tr>
        <tr><td>Status</td><td>${e.status}${e.constructionStage&&e.constructionStage!==e.status?' ('+e.constructionStage+')':''}</td></tr>
        <tr><td>Possession</td><td>${e.possession}</td></tr>
        <tr><td>Availability</td><td>${e.availability||'—'}</td></tr>
        ${group('Dimensions')}
        <tr><td>Configuration</td><td>${e.config||'—'}</td></tr>
        <tr><td>Built-up Area</td><td>${e.sqftRange||'—'}</td></tr>
        ${e.superBuiltupArea?`<tr><td>Super Built-up</td><td>${e.superBuiltupArea}</td></tr>`:''}
        ${e.carpetArea?`<tr><td>Carpet Area</td><td>${e.carpetArea}</td></tr>`:''}
        <tr><td>Land Area</td><td>${e.totalLandArea||'—'}</td></tr>
        <tr><td>UDS</td><td>${e.uds||'—'}</td></tr>
        ${group('Building')}
        <tr><td>Total Units</td><td>${e.totalUnits||'—'}</td></tr>
        ${e.totalTowers?`<tr><td>Total Towers</td><td>${e.totalTowers}</td></tr>`:''}
        <tr><td>Total Floors</td><td>${e.totalFloors||'—'}</td></tr>
        ${e.floorNo?`<tr><td>Floor</td><td>${e.floorNo}</td></tr>`:''}
        ${e.facing?`<tr><td>Facing</td><td>${e.facing}</td></tr>`:''}
        ${e.bathrooms?`<tr><td>Bathrooms</td><td>${e.bathrooms}</td></tr>`:''}
        <tr><td>Parking</td><td>${e.parking?e.parking+' '+(e.parkingType||''):'—'}</td></tr>
        ${e.furnishing?`<tr><td>Furnishing</td><td>${e.furnishing}</td></tr>`:''}
        ${e.cornerUnit?`<tr><td>Corner Unit</td><td>${e.cornerUnit}</td></tr>`:''}
        <tr><td>Vastu</td><td>${e.vastu||'—'}</td></tr>
        ${e.powerBackup?`<tr><td>Power Backup</td><td>${e.powerBackup}</td></tr>`:''}
        ${e.approval?`<tr><td>Approval</td><td>${e.approval}</td></tr>`:''}
        ${group('Resources & Contact')}
        <tr><td>Brochure</td><td>${link(p.brochureLink,'Open Brochure')}</td></tr>
        <tr><td>Photos</td><td>${link(p.photosLink,'Open Photo Folder')}</td></tr>
        <tr><td>Contact</td><td>${e.contactName} — ${e.contactNumber}</td></tr>
        ${p.sheetExtras&&p.sheetExtras['Owner_Builder_Contact']?`<tr><td>Owner / Builder</td><td>${escapeHtml(p.sheetExtras['Owner_Builder_Contact'])}</td></tr>`:''}
      </table></div>
    </div>`;
  }

  function pitchTab(p){
    const e = esc(p);
    const highlights = splitList(p.highlights).map(escapeHtml);
    return `
    <div class="tab-panel">
      <div class="sec">
        <div class="summary-card">
          <div class="sum-lbl">💬 Sales Talking Points</div>
          <div class="sum-txt">
            <p><strong>${e.name}</strong> by ${e.builder} is a premium ${escapeHtml(String(p.type||'').toLowerCase())} project in <strong>${e.location}</strong>.</p>
            <p>Offering ${e.config} configurations${e.sqftRange?` spanning ${e.sqftRange}`:''}, priced from <strong>${e.startingPrice}</strong>.</p>
            <p><strong>Possession:</strong> ${e.possession} · <strong>Status:</strong> ${e.status}</p>
            ${highlights.length?`<p><strong>Why buy:</strong> ${highlights.join(' · ')}</p>`:''}
            ${e.connectivity?`<p><strong>Connectivity:</strong> ${e.connectivity}</p>`:''}
            <p style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);"><strong>📞 Close with:</strong> "Shall I block a site visit for you this weekend? Call ${e.contactName} at ${e.contactNumber}."</p>
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
    const p=resolveProperty(id);
    if(!p){showToast('Property not found');return;}
    downloadFile(JSON.stringify(p,null,2),`${String(p.name||'property').replace(/[^\w\-]+/g,'_')}.json`,'application/json');
    showToast('JSON downloaded');
  }

  function openPhotos(id){
    const p=resolveProperty(id);
    if(!p||!p.photosLink){showToast('No photos link saved for this property yet');return;}
    window.open(p.photosLink,'_blank','noopener');
  }

  function downloadBrochure(id){
    const p=resolveProperty(id);
    if(!p){showToast('Property not found');return;}
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
    const p=resolveProperty(id);
    if(!p){showToast('Property not found');return;}
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
    const raw=resolveProperty(id);
    if(!raw){showToast('Property not found');return;}
    const p=esc(raw);const w=window.open('','_blank');
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

  // Share glyph, inline so it inherits currentColor and stays crisp beside
  // the monochrome ★ on each card.
  const SHARE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/></svg>';

  // Click the backdrop to dismiss the share modal (both pages host one).
  document.addEventListener('click', e => {
    if(e.target && e.target.id === 'shareDetailsModal') closeShareDetailsModal();
  });

  window.PinPropertyView = {
    setResolver: fn => { resolveProperty = fn; },
    hero, overviewTab, specsTab, pitchTab, renderSheetExtras,
    propertyUrl, cacheProperty, cachedProperty,
    escapeHtml, esc, isReady, splitList,
    mapsHref, resourceChips,
    SHARE_ICON, prefersNativeShare
  };

  // Shared globals the inline onclick handlers (and app.js) call by name.
  window.escapeHtml = escapeHtml;
  window.esc = esc;
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
