// ═══════ THE DATABASE'S DAILY LIMIT, SAID PLAINLY ═══════
// On the free Spark plan Firestore stops every page for the rest of the day once 50K reads are
// used (it did on 28 Oct 2026). The pages then fail quietly — lists stay empty, saves error in the
// console. This notices Firestore's "quota exceeded" wherever it surfaces (an error a page logs, or
// a promise nobody caught) and shows one banner: what happened, when it comes back (midnight US
// Pacific, in Indian time), that nothing is lost. Standalone: one <script> tag per page; it reads
// and writes nothing.
(function(){
  if (window.__quotaNotice) return;
  window.__quotaNotice = true;
  const QUOTA = /resource[-_ ]exhausted|quota exceeded|exceeded.*quota/i;
  const textOf = a => { try { return a instanceof Error ? (a.code || '') + ' ' + a.message : typeof a === 'string' ? a : (a && (a.code || '') + ' ' + (a.message || '')) || ''; } catch (e) { return ''; } };

  // When Google's quota day next starts, as Indian time ("12:30 pm" in US summer, "1:30 pm" in winter).
  function resetIST(){
    const day = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const now = Date.now(), today = day(now);
    for (let h = 0; h < 48; h++) {
      const t = Math.floor(now / 3600e3) * 3600e3 + h * 3600e3;
      if (day(t) !== today && day(t - 3600e3) === today) return new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
    }
    return 'midnight US time';
  }

  let shown = false;
  function show(){
    if (shown || !document.body) return;
    shown = true;
    const bar = document.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2000;max-width:min(560px,calc(100vw - 24px));'
      + 'background:#7F1D1D;color:#fff;font:600 13.5px/1.45 system-ui,-apple-system,sans-serif;padding:11px 40px 11px 14px;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.25)';
    bar.innerHTML = '<b>The database has reached its free daily limit.</b> Pages can’t load or save until it resets at about '
      + resetIST() + ' today. Nothing is lost — reload after that.'
      + '<button type="button" aria-label="Close" style="position:absolute;right:8px;top:6px;border:0;background:none;color:#fff;font-size:20px;cursor:pointer">×</button>';
    bar.querySelector('button').onclick = () => bar.remove();
    document.body.appendChild(bar);
  }
  const check = (...args) => { if (!shown && args.some(a => QUOTA.test(textOf(a)))) show(); };

  const err = console.error, warn = console.warn;
  console.error = function(...a){ check(...a); return err.apply(this, a); };
  console.warn = function(...a){ check(...a); return warn.apply(this, a); };
  addEventListener('unhandledrejection', e => check(e.reason));
  addEventListener('error', e => check(e.error || e.message));
  window.showQuotaNotice = show;
})();
