// ═══════ PROPERTY PICKER — type to find a property, by its code, its title or anything in its details ═══════
// A long <select> of 131 properties could only be scrolled. This puts a search box on top of the
// select it is given (the select stays, hidden, and keeps its value and change event — so the code
// that reads it does not change): type a code ("NGMA002"), part of a title ("srivaradha"), or what is
// in its details ("3bhk anna nagar", "uds 675", "rent") and pick with a click, or ↑ ↓ Enter.
// Every word typed must be found somewhere in the property; a code match ranks first, then the title.
//
//   PinPropertyPicker.attach(select, { lookup: value => property|null, placeholder })
// The select's own options are the choices (so "Something not in the inventory…" and the like stay);
// lookup gives each option's property, whose code, name, location, configuration, type, price and
// details are searched. Options replaced later (the inventory arriving) are picked up by themselves.
(function(){
  const CSS = `
.ppk{position:relative}
.ppk-in{width:100%;box-sizing:border-box}
.ppk-list{margin-top:4px;border:1px solid var(--border,#d6d3d1);border-radius:9px;background:var(--card,var(--raised,#fff));max-height:280px;overflow-y:auto;overscroll-behavior:contain;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.12)}
.ppk-list[hidden]{display:none}
.ppk-opt{display:block;width:100%;text-align:left;border:0;background:none;border-radius:7px;padding:7px 10px;font:inherit;font-size:13px;font-weight:600;color:var(--ink,#1c1917);cursor:pointer;line-height:1.35}
.ppk-opt small{display:block;font-weight:400;font-size:11.5px;color:var(--ink3,#78716c);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ppk-opt mark{background:var(--brand-soft,#fff1dc);color:inherit;border-radius:2px;padding:0 1px}
.ppk-opt.at,.ppk-opt:hover{background:var(--brand-soft,#fff4e5)}
.ppk-opt.on{box-shadow:inset 3px 0 0 var(--brand,#fe8d00)}
.ppk-empty{padding:10px;font-size:12.5px;color:var(--ink3,#78716c)}
.ppk-more{padding:6px 10px;font-size:11.5px;color:var(--ink3,#78716c)}`;
  const MAX = 60;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  // Lower case, accents and punctuation folded, so "Sq.Ft" finds "sqft" and "3-BHK" finds "3bhk".
  const fold = s => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9₹]+/g, ' ').trim();
  const tight = s => fold(s).replace(/ /g, '');

  function haystacks(o, p){
    const code = p ? String(p.propertyCode || '') : '';
    const title = (p ? p.name : '') || o.text;
    const rest = p ? [p.location, p.config, p.type, p.saleType, p.startingPrice, p.sqftRange, p.uds, p.builder, p.zone, p.nearbyLandmark, p.detailsText].filter(Boolean).join(' \n ') : '';
    return { code: fold(code), codeT: tight(code), title: fold(title), titleT: tight(title), rest: fold(rest), restT: tight(rest), raw: rest };
  }
  // Each word typed must be in the code, the title or the details — "3bhk" also matches "3 BHK".
  function score(h, words){
    let s = 0;
    for(const w of words){
      const wt = w.replace(/ /g, '');
      if(h.codeT && h.codeT === wt) s += 100;
      else if(h.codeT.startsWith(wt)) s += 60;
      else if(h.codeT.includes(wt)) s += 40;
      else if(h.title.split(' ').some(t => t.startsWith(w))) s += 25;
      else if(h.titleT.includes(wt)) s += 15;
      else if(h.rest.split(' ').some(t => t.startsWith(w)) || h.restT.includes(wt)) s += 5;
      else return -1;
    }
    return s;
  }
  // Where in the details a word was found, for the line under the title.
  function snippet(raw, words){
    const flat = String(raw || '').replace(/\s+/g, ' ');
    const low = flat.toLowerCase();
    for(const w of words){
      const i = low.indexOf(w);
      if(i < 0) continue;
      const a = Math.max(0, i - 30), b = Math.min(flat.length, i + w.length + 50);
      return (a ? '…' : '') + flat.slice(a, b).trim() + (b < flat.length ? '…' : '');
    }
    return '';
  }
  function mark(text, words){
    let out = esc(text);
    for(const w of words.filter(x => x.length > 1)){
      const re = new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      out = out.replace(re, '<mark>$1</mark>');
    }
    return out;
  }

  function attach(select, opts){
    if(!select || select.dataset.ppk) return null;
    if(!document.getElementById('ppkCss')){ const st = document.createElement('style'); st.id = 'ppkCss'; st.textContent = CSS; document.head.appendChild(st); }
    const o = opts || {};
    select.dataset.ppk = '1';
    const wrap = document.createElement('div');
    wrap.className = 'ppk';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'ppk-in';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = o.placeholder || 'Type a code, a name or anything in its details…';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    if(select.id) input.id = select.id + 'Search';
    const list = document.createElement('div');
    list.className = 'ppk-list';
    list.hidden = true;
    list.setAttribute('role', 'listbox');
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(input); wrap.appendChild(list); wrap.appendChild(select);
    select.hidden = true;
    // The label the select's label pointed at now points at the search box.
    if(select.id){ const lab = document.querySelector(`label[for="${select.id}"]`); if(lab) lab.htmlFor = input.id; }

    let shown = [], at = 0;
    const choices = () => [...select.options].map(op => ({ value: op.value, text: op.textContent, p: o.lookup ? o.lookup(op.value) : null }));
    const labelOf = v => { const op = [...select.options].find(x => x.value === v); return op && v ? op.textContent : ''; };
    function sync(){ if(document.activeElement !== input) input.value = labelOf(select.value); }
    function render(){
      const q = fold(input.value === labelOf(select.value) ? '' : input.value);
      const words = q ? q.split(' ').filter(Boolean) : [];
      const all = choices().filter(c => c.value !== '' || !words.length);
      // Nothing typed: every choice, in the select's own order. Typed: the matches, best first —
      // and the select's own non-property choices ("Something not in the inventory…") always last.
      shown = !words.length ? all : all.map(c => ({ c, s: c.p ? score(haystacks(c, c.p), words) : (fold(c.text).includes(q) ? 1 : -1) }))
        .filter(x => x.s >= 0 || (!x.c.p && x.c.value)).sort((a, b) => (!!b.c.p - !!a.c.p) || b.s - a.s).map(x => x.c);
      const extra = shown.length - MAX;
      if(extra > 0) shown = shown.slice(0, MAX);
      at = Math.max(0, Math.min(at, shown.length - 1));
      const real = shown.filter(c => c.p).length;
      list.innerHTML = (words.length && !real ? `<div class="ppk-empty">No property has “${esc(input.value.trim())}” in its code, title or details.</div>` : '')
        + shown.map((c, i) => {
          const sub = c.p ? [c.p.location, c.p.config && !/^(-+|multiple)$/i.test(c.p.config) ? c.p.config : '', c.p.startingPrice].filter(Boolean).join(' · ') : '';
          const h = c.p && words.length ? haystacks(c, c.p) : null;
          const inDetails = h && words.some(w => !h.code.includes(w) && !h.title.includes(w));
          const sn = inDetails ? snippet(h.raw, words) : '';
          return `<button type="button" class="ppk-opt${i === at ? ' at' : ''}${c.value === select.value && c.value ? ' on' : ''}" role="option" data-i="${i}">${mark(c.text, words)}${sn ? `<small>${mark(sn, words)}</small>` : sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
        }).join('')
        + (extra > 0 ? `<div class="ppk-more">${extra} more — type more of the name, code or details</div>` : '');
      const cur = list.querySelector('.ppk-opt.at');
      if(cur) cur.scrollIntoView({ block: 'nearest' });
    }
    function open(){ list.hidden = false; input.setAttribute('aria-expanded', 'true'); render(); }
    function close(){ list.hidden = true; input.setAttribute('aria-expanded', 'false'); sync(); }
    function pick(i){
      const c = shown[i];
      if(!c) return;
      select.value = c.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      list.hidden = true; input.setAttribute('aria-expanded', 'false');
      input.value = labelOf(c.value);
      if(document.activeElement === input && c.value !== '__free') input.blur();
    }
    input.addEventListener('focus', () => { input.select(); at = Math.max(0, shown.findIndex(c => c.value === select.value)); open(); });
    input.addEventListener('input', () => { at = 0; open(); });
    input.addEventListener('keydown', e => {
      if(e.key === 'ArrowDown'){ e.preventDefault(); if(list.hidden) open(); else { at = Math.min(at + 1, shown.length - 1); render(); } }
      else if(e.key === 'ArrowUp'){ e.preventDefault(); at = Math.max(at - 1, 0); render(); }
      else if(e.key === 'Enter'){ if(!list.hidden && shown[at]){ e.preventDefault(); pick(at); } }
      else if(e.key === 'Escape'){ if(!list.hidden){ e.preventDefault(); e.stopPropagation(); close(); input.blur(); } }
    });
    input.addEventListener('blur', () => setTimeout(() => { if(document.activeElement !== input) close(); }, 120));
    list.addEventListener('mousedown', e => e.preventDefault());
    list.addEventListener('click', e => { const b = e.target.closest('.ppk-opt'); if(b) pick(+b.dataset.i); });
    // The options replaced (the inventory arriving) or the value set from code: the box follows.
    new MutationObserver(() => { sync(); if(!list.hidden) render(); }).observe(select, { childList: true, subtree: true, attributes: true });
    select.addEventListener('change', sync);
    sync();
    return { sync, input };
  }
  window.PinPropertyPicker = { attach, score: (p, q, text) => score(haystacks({ text: text || '' }, p), fold(q).split(' ').filter(Boolean)) };
})();
