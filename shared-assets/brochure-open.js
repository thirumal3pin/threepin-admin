// ═══════ OPENING A BROCHURE — the same everywhere (property page, Shoot board, My listings, Eåsy) ═══════
//
//   PinBrochure.open(link, { name, getToken, toast })
//
// A brochure is a PDF on Google Drive. On a computer or an Android phone it is the straight download
// it always was. On an iPhone / iPad the installed app cannot do that (its in-app browser shows a
// white page while a 3–7 MB file comes down, and often gives up), and Drive's own viewer must never
// be shown: from it anyone can step up into the brochure's folder and see every other file there
// (owner, 24 Nov 2026). So on an iPhone the app downloads the PDF through our server in pieces
// (api/brochure.js ?op=file) and opens it in its own viewer — every page, ✕ to come back, Save / Share.
// Nothing here ever links to a Drive page.
//
// A plain script (window.PinBrochure) so classic and module pages alike can use it.
(function () {
  'use strict';
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // A small notice of its own, for pages that have none.
  function ownToast(msg) {
    let t = document.getElementById('brochureToast');
    if (!t) {
      t = document.createElement('div'); t.id = 'brochureToast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite');
      t.style.cssText = 'position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:700;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:#1f2937;color:#fff;font:600 14px/1.3 var(--sans,system-ui);box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;transition:opacity .2s';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(ownToast.t); ownToast.t = setTimeout(() => { t.style.opacity = '0'; }, 3200);
  }
  let showToast = ownToast;
  // Whatever signed-in auth object the page has (each console names its own).
  async function defaultToken() {
    for (const a of [window.dashboardAuth, window.crmAuth, window.trackAuth, window.financeAuth, window.agentAuth, window.pinAuth]) {
      if (a && typeof a.getIdToken === 'function') { const t = await a.getIdToken(); if (t) return t; }
    }
    return null;
  }
  let getToken = defaultToken;

  // ── The brochure: a direct download, everywhere ──
  //
  // On a computer: Drive's direct-download link, as it always was.
  //
  // On an iPhone / iPad — and in the installed app on any touch phone — that link opens in the app's
  // in-app browser, which has nowhere to save a file: Drive's redirect stalled on a blank white page
  // (owner, 24 Nov 2026). There the app fetches the PDF itself, straight from Google (Drive's download
  // address allows any site to read a public file), and hands the FILE to the phone: the share sheet
  // (Save to Files, WhatsApp, Books…). No Drive page, no redirect. If iOS will not open the sheet after
  // the wait (it wants a fresh tap), a small "Brochure ready" bar does it on the next tap.
  function brochureFileId(link){
    const m=String(link||'').match(/\/d\/([a-zA-Z0-9_-]+)|[?&]id=([a-zA-Z0-9_-]+)/);
    return m?(m[1]||m[2]):null;
  }
  // iPhone / iPad only: Android and computers download the file perfectly well (owner, 24 Nov 2026).
  function inAppPhone(){
    return /iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  }
  // From our own server, in pieces (api/brochure.js ?op=file): Google does not let a web page read a
  // Drive file itself, and one server answer is capped at 4.5 MB while brochures run to ~7 MB.
  async function fetchBrochure(fileId,name,onProgress){
    const token=await getToken();
    if(!token) throw new Error('not signed in');
    const parts=[];let from=0,total=null,guard=0;
    while((total==null||from<total)&&guard++<20){
      const res=await fetch(`/api/brochure?op=file&id=${encodeURIComponent(fileId)}&from=${from}`,{headers:{Authorization:'Bearer '+token}});
      if(!res.ok) throw new Error('server answered '+res.status);
      const buf=await res.arrayBuffer();
      total=Number(res.headers.get('X-File-Total'))||(from+buf.byteLength);
      if(!buf.byteLength) break;
      parts.push(buf);from+=buf.byteLength;
      if(onProgress) onProgress(Math.min(1,from/total));
    }
    const file=new File(parts,name,{type:'application/pdf'});
    // A real PDF starts "%PDF" — anything else is not the brochure.
    const head=new Uint8Array(await file.slice(0,4).arrayBuffer());
    if(String.fromCharCode(...head)!=='%PDF'||(total&&file.size!==total)) throw new Error('incomplete');
    return file;
  }
  function brochureReady(file){
    const url=URL.createObjectURL(file);
    let bar=document.getElementById('brochureReady');
    if(bar) bar.remove();
    bar=document.createElement('div');
    bar.id='brochureReady';
    bar.setAttribute('role','status');
    bar.style.cssText='position:fixed;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 14px;border-radius:14px;background:var(--card,#fff);color:var(--ink,#171717);border:1px solid var(--border,#e5e5e5);box-shadow:0 8px 30px rgba(0,0,0,.18);font:14px/1.3 var(--sans,system-ui)';
    const btn='min-height:44px;padding:0 16px;border-radius:10px;font:inherit;font-weight:650;cursor:pointer;border:1px solid var(--border2,#d4d4d4);background:transparent;color:inherit;-webkit-tap-highlight-color:transparent';
    bar.innerHTML=`<span style="flex:1 1 140px">📄 Brochure ready</span>`
      +`<a id="brOpen" href="${url}" download="${escapeHtml(file.name)}" style="${btn};display:inline-flex;align-items:center;text-decoration:none">Open</a>`
      +(navigator.canShare&&navigator.canShare({files:[file]})?`<button type="button" id="brShare" style="${btn};background:var(--brand,#F57C00);border-color:var(--brand,#F57C00);color:var(--on-brand,#fff)">Save / Share</button>`:'')
      +`<button type="button" id="brClose" aria-label="Close" style="${btn};padding:0 12px">✕</button>`;
    document.body.appendChild(bar);
    const close=()=>{bar.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);};
    const share=bar.querySelector('#brShare');
    if(share) share.addEventListener('click',()=>navigator.share({files:[file],title:file.name}).then(close).catch(e=>{if(e&&e.name!=='AbortError')showToast('Could not open the share sheet — use Open');}));
    bar.querySelector('#brOpen').addEventListener('click',()=>setTimeout(close,1500));
    bar.querySelector('#brClose').addEventListener('click',close);
  }
  // ── The brochure, opened inside the app (iPhone) ──
  // A full-screen sheet with the pages drawn by PDF.js (Mozilla's PDF reader — Safari shows only the
  // first page of a PDF placed in a page), a ✕ to come back, and Save / Share for the file itself.
  // Nothing here links to Drive. Pages are drawn as they scroll into view, each turned into a picture,
  // so a 20-page brochure never holds 20 canvases in a phone's memory.
  const PDFJS='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  let pdfjsP=null;
  function loadPdfJs(){
    if(window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if(pdfjsP) return pdfjsP;
    pdfjsP=new Promise((ok,no)=>{
      const sc=document.createElement('script');
      sc.src=PDFJS+'pdf.min.js';
      sc.onload=()=>{ if(!window.pdfjsLib){pdfjsP=null;return no(new Error('no pdf.js'));} window.pdfjsLib.GlobalWorkerOptions.workerSrc=PDFJS+'pdf.worker.min.js'; ok(window.pdfjsLib); };
      sc.onerror=()=>{pdfjsP=null;no(new Error('pdf.js did not load'));};
      document.head.appendChild(sc);
    });
    return pdfjsP;
  }
  async function openPdfViewer(file){
    const lib=await loadPdfJs();
    const doc=await lib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
    const old=document.getElementById('pdfSheet'); if(old) old.remove();
    const dlg=document.createElement('dialog');
    dlg.id='pdfSheet';
    dlg.setAttribute('aria-label',file.name);
    dlg.style.cssText='margin:0;padding:0;border:0;inset:0;width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;background:#525659;color:#fff;overflow:hidden';
    const btn='min-height:44px;min-width:44px;padding:0 14px;border-radius:10px;font:600 15px/1 var(--sans,system-ui);cursor:pointer;border:0;-webkit-tap-highlight-color:transparent';
    const canShare=!!(navigator.canShare&&navigator.canShare({files:[file]}));
    dlg.innerHTML=`<div style="display:flex;align-items:center;gap:8px;padding:calc(8px + env(safe-area-inset-top)) 10px 8px;background:#323639">
        <button type="button" data-close style="${btn};background:transparent;color:#fff;font-size:22px" aria-label="Close">✕</button>
        <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:600 15px var(--sans,system-ui)">${escapeHtml(file.name.replace(/\.pdf$/i,''))}</span>
        ${canShare?`<button type="button" data-share style="${btn};background:var(--brand,#F57C00);color:#fff">Save / Share</button>`:`<a data-save href="#" download="${escapeHtml(file.name)}" style="${btn};display:inline-flex;align-items:center;background:var(--brand,#F57C00);color:#fff;text-decoration:none">Save</a>`}
      </div>
      <div data-pages style="height:calc(100% - 60px - env(safe-area-inset-top));overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:10px 8px calc(16px + env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center;gap:10px"></div>`;
    document.body.appendChild(dlg);
    const pages=dlg.querySelector('[data-pages]');
    const url=URL.createObjectURL(file);
    const save=dlg.querySelector('[data-save]'); if(save) save.href=url;
    const imgs=[];
    let closed=false;
    const close=()=>{ if(closed) return; closed=true; try{dlg.close();}catch(e){} dlg.remove(); URL.revokeObjectURL(url); imgs.forEach(u=>URL.revokeObjectURL(u)); try{doc.destroy();}catch(e){} };
    dlg.querySelector('[data-close]').addEventListener('click',close);
    dlg.addEventListener('close',close);
    const sh=dlg.querySelector('[data-share]');
    if(sh) sh.addEventListener('click',()=>navigator.share({files:[file],title:file.name}).catch(e=>{if(e&&e.name!=='AbortError')showToast('Could not open the share sheet');}));
    dlg.showModal();
    const width=Math.max(200,Math.min(pages.clientWidth||window.innerWidth,900)-16);
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const first=await doc.getPage(1);
    const v1=first.getViewport({scale:1});
    const holders=[];
    for(let i=1;i<=doc.numPages;i++){
      const h=document.createElement('div');
      h.dataset.page=String(i);
      h.style.cssText=`width:${width}px;aspect-ratio:${v1.width}/${v1.height};background:#fff;border-radius:2px;box-shadow:0 1px 4px rgba(0,0,0,.4);flex:none`;
      h.setAttribute('aria-label','Page '+i);
      pages.appendChild(h);holders.push(h);
    }
    const draw=async h=>{
      if(h.dataset.done||closed) return; h.dataset.done='1';
      const pg=await doc.getPage(Number(h.dataset.page));
      const base=pg.getViewport({scale:1});
      const vp=pg.getViewport({scale:(width/base.width)*dpr});
      const c=document.createElement('canvas');c.width=Math.floor(vp.width);c.height=Math.floor(vp.height);
      await pg.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
      const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.9));
      c.width=c.height=0;
      if(closed||!blob) return;
      const u=URL.createObjectURL(blob);imgs.push(u);
      const img=new Image();img.alt='Page '+h.dataset.page;img.style.cssText='width:100%;height:auto;display:block';img.src=u;
      h.style.aspectRatio='auto';h.appendChild(img);
    };
    const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)draw(e.target);}),{root:pages,rootMargin:'800px 0px'});
    holders.forEach(h=>io.observe(h));
    return true;
  }


  // Open one brochure. link: its Drive link (any form with the file id); name: the file name to use.
  function open(link, opts) {
    const o = opts || {};
    showToast = o.toast || ownToast;
    getToken = o.getToken || defaultToken;
    const fileId = brochureFileId(link);
    if (!fileId) { showToast('No PDF brochure uploaded yet'); return; }
    if (inAppPhone()) {
      const name = `${String(o.name || 'Brochure').replace(/[\\/:*?"<>|]+/g, ' ').trim()} brochure.pdf`;
      showToast('Downloading the brochure…');
      let shown = -1;
      fetchBrochure(fileId, name, f => { const pc = Math.round(f * 100); if (pc - shown >= 25 || pc === 100) { shown = pc; showToast(pc < 100 ? `Downloading the brochure… ${pc}%` : 'Opening the brochure…'); } })
        .then(file => openPdfViewer(file).catch(() => brochureReady(file)))
        .catch(() => showToast('Could not download the brochure — check the connection and try again'));
      return;
    }
    // Computers and Android: the straight download, as it always was — a file, never a Drive page.
    const a = document.createElement('a');
    a.href = `https://drive.google.com/uc?export=download&id=${fileId}`;
    a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    showToast('Brochure downloading…');
  }
  // Wire every [data-brochure] button on a page (Shoot board, My listings, Eåsy cards): one listener.
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-brochure]');
    if (!b) return;
    e.preventDefault();
    open(b.getAttribute('data-brochure'), { name: b.getAttribute('data-brochure-name') || '' });
  });
  window.PinBrochure = { open, fileId: brochureFileId, isIPhone: inAppPhone };
})();
