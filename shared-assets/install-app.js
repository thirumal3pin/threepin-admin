// ═══════ INSTALL APP ═══════
// "📲 Install app" at the foot of the side menu, the way TailorTalk offers it: the admin saved as an
// app with its own icon (the 3 PIN logo) and its own window. The manifest (/manifest.webmanifest)
// and a service worker that caches nothing (/sw.js) are what make the browser offer it.
//   Android, Chrome and Edge on a computer: the button opens the browser's own install prompt.
//   iPhone / iPad: Apple lets no page install itself, so the button shows the two taps —
//   Share → Add to Home Screen. Safari on a Mac: File → Add to Dock.
// Already installed (opened from the home screen or dock): no button.
(function(){
  const standalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const macSafari = !iOS && /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua);
  let deferred = null;

  if('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; place(); });
  window.addEventListener('appinstalled', () => { deferred = null; const b = document.getElementById('installAppBtn'); if(b) b.remove(); });

  const CSS = `
#installAppBtn{display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;padding:8px 9px;border-radius:9px;font:inherit;font-size:13px;font-weight:600;color:inherit;cursor:pointer;text-align:left;margin-bottom:2px}
#installAppBtn:hover{background:var(--rl-hover,rgba(0,0,0,.05))}
#installAppBtn .rl-ico{width:19px;flex:none;text-align:center;font-size:14px}
body.rail-min #appRail #installAppBtn span.tx{display:none}
#installAppHelp{position:fixed;inset:0;z-index:1200;background:rgba(20,18,15,.5);display:flex;align-items:flex-end;justify-content:center;padding:16px}
#installAppHelp .ia-box{background:var(--card,#fff);color:var(--ink,#1c1917);border-radius:16px;max-width:380px;width:100%;padding:20px 20px 16px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-size:14px;line-height:1.5}
#installAppHelp .ia-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
#installAppHelp .ia-head img{width:48px;height:48px;border-radius:11px;box-shadow:0 1px 4px rgba(0,0,0,.15)}
#installAppHelp ol{margin:0 0 14px;padding-left:20px}
#installAppHelp li{margin:6px 0}
#installAppHelp .ia-share{display:inline-block;vertical-align:-3px;width:18px;height:18px}
#installAppHelp button{width:100%;border:1px solid var(--border,#d6d3d1);background:var(--card,#fff);border-radius:10px;padding:10px;font:inherit;font-weight:600;cursor:pointer;color:inherit}`;
  const SHARE = '<svg class="ia-share" viewBox="0 0 24 24" fill="none" stroke="#0a84ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';

  function help(){
    const steps = iOS
      ? `<ol><li>Tap ${SHARE} <b>Share</b> at the bottom of Safari (in Chrome: ${SHARE} at the top right).</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b> — the 3 PIN icon is on your home screen.</li></ol>`
      : macSafari
      ? `<ol><li>In the menu bar, click <b>File</b> → <b>Add to Dock…</b></li><li>Click <b>Add</b> — 3 PIN opens from the Dock in its own window.</li></ol>`
      : `<ol><li>Open the browser menu <b>⋮</b>.</li><li>Choose <b>Install app</b> or <b>Add to Home screen</b>.</li></ol>`;
    const el = document.createElement('div');
    el.id = 'installAppHelp';
    el.innerHTML = `<div class="ia-box" role="dialog" aria-modal="true" aria-label="Install the 3 PIN app"><div class="ia-head"><img src="/apple-touch-icon.png" alt=""><div><b>Install 3 PIN</b><br><span style="opacity:.7;font-size:13px">Opens like an app, from your ${iOS ? 'home screen' : macSafari ? 'Dock' : 'apps'}</span></div></div>${steps}<button type="button">Got it</button></div>`;
    el.addEventListener('click', e => { if(e.target === el || e.target.tagName === 'BUTTON') el.remove(); });
    document.body.appendChild(el);
  }
  async function install(){
    if(deferred){
      const d = deferred; deferred = null;
      d.prompt();
      try { await d.userChoice; } catch(e){}
      place();
      return;
    }
    help();
  }
  // At the foot of the side menu, above Sign out. The menu is drawn (and redrawn) by appnav.js.
  function place(){
    const foot = document.querySelector('#appRail .rail-foot');
    const old = document.getElementById('installAppBtn');
    const want = !standalone() && (deferred || iOS || macSafari);
    if(!want || !foot){ if(old && !want) old.remove(); return; }
    if(old) return;
    if(!document.getElementById('installAppCss')){ const st = document.createElement('style'); st.id = 'installAppCss'; st.textContent = CSS; document.head.appendChild(st); }
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'installAppBtn'; b.title = 'Install 3 PIN as an app';
    b.innerHTML = '<span class="rl-ico" aria-hidden="true">📲</span><span class="tx">Install app</span>';
    b.addEventListener('click', install);
    const out = foot.querySelector('.rail-out');
    foot.insertBefore(b, out || null);
  }
  const watch = () => { place(); new MutationObserver(place).observe(document.body, { childList: true, subtree: false }); };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
  window.PinInstallApp = { open: install };
})();
