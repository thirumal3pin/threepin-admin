// ═══════════════════════════════════════════════════════════════════════
// EÅSY — the CRM's assistant (Eåsy Requirements Document v2, MVP).
//
// Plug-and-play: this file and easy.css are the whole page side. Remove the two lines in
// crm.html and Eåsy is gone; set EASY_DISABLED=1 on the server and the button never appears.
// The only things it reads from the page are crmAuth (the sign-in), openDetail (to open a
// lead) and the page's `leads` list (for the Log call picker) — all optional.
//
// Talks to /api/easy:
//   { history }                      a question → { reply, drafts, changes, links, plan }
//   { action:'draft', … }            Send was tapped / "Sent?" Yes / Discard        (MVP-08)
//   { action:'confirm', … }          Yes / No on a prepared change          (MVP-01/02/15)
//   { action:'reminders' }           polled each minute → visit, gist, follow-up (MVP-11/12/13)
//   { action:'ping' }                is Eåsy switched on?
// ═══════════════════════════════════════════════════════════════════════
(function(){
  const SUGGESTIONS = ['What is my day?', 'Who went cold? Draft the follow-ups', 'What is missing on my properties?', 'Seller summaries for this week'];
  const POLL_MS = 60000;
  const SHOWN_KEY = 'easy.shownReminders';
  const history = [];   // { role, text }
  let busy = false;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  // Plain text → safe HTML: **bold**, line breaks, and [lead:ID] as an open-lead button.
  function render(text){
    return esc(text)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[lead:([^\]\s]+)\]/g, (m, id) => `<button type="button" class="easy-lead" data-lead="${id}">Open lead</button>`)
      .replace(/\n/g, '<br>');
  }
  const leadBtn = id => id ? `<button type="button" class="easy-lead" data-lead="${esc(id)}">Open lead</button>` : '';

  async function post(body){
    const token = window.crmAuth && await window.crmAuth.getIdToken();
    if(!token) throw new Error('Sign in first');
    const res = await fetch('/api/easy', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + token },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) { const e = new Error(data.error || 'Eåsy could not answer just now'); e.disabled = !!data.disabled; throw e; }
    return data;
  }

  const root = document.createElement('div');
  root.className = 'easy';
  root.hidden = true;     // shown once the server says Eåsy is on
  root.innerHTML = `
    <button type="button" class="easy-fab" aria-expanded="false" aria-controls="easyPanel" title="Ask Eåsy">e<span class="easy-ring">å</span>sy<span class="easy-dot" hidden></span></button>
    <section class="easy-panel" id="easyPanel" role="dialog" aria-label="Ask Eåsy" hidden>
      <header class="easy-head">
        <div><b class="easy-mark">e<span class="easy-ring">å</span>sy</b> <span class="easy-by">by 3 PIN</span></div>
        <div class="easy-head-btns">
          <button type="button" class="easy-lang" title="Language you speak in">EN</button>
          <button type="button" class="easy-speaker" title="Read answers aloud" aria-pressed="true">🔊</button>
          <button type="button" class="easy-logcall" title="Notes after a call">📞 Log call</button>
          <button type="button" class="easy-close" aria-label="Close">×</button>
        </div>
      </header>
      <div class="easy-log" aria-live="polite">
        <p class="easy-hello">Tap 🎤 and speak — in English or Tamil — or type. I read, draft and prepare changes; you send, and you say Yes before anything is saved.</p>
        <div class="easy-chips">${SUGGESTIONS.map(s => `<button type="button" class="easy-chip">${esc(s)}</button>`).join('')}</div>
      </div>
      <form class="easy-form">
        <button type="button" class="easy-mic" title="Speak" aria-label="Speak">🎤</button>
        <input class="easy-input" type="text" placeholder="Ask Eåsy…" autocomplete="off" maxlength="1000">
        <button type="submit" class="easy-send">Ask</button>
      </form>
    </section>`;
  document.body.appendChild(root);

  const fab = root.querySelector('.easy-fab');
  const dot = root.querySelector('.easy-dot');
  const panel = root.querySelector('.easy-panel');
  const log = root.querySelector('.easy-log');
  const form = root.querySelector('.easy-form');
  const input = root.querySelector('.easy-input');

  // ── Voice: speak to Eåsy, hear it answer ──
  // The browser's own speech recognition (Chrome, Edge, Safari — phones included) and its own
  // voices. The language is the one the agent picks (EN / தமிழ்), remembered on this device.
  // Asked by voice → the answer is read aloud too, unless the speaker is off.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const LANGS = [['en-IN', 'EN'], ['ta-IN', 'தமிழ்']];
  const store = { get: k => { try { return localStorage.getItem(k); } catch(e){ return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch(e){} } };
  let lang = store.get('easy.voiceLang') === 'ta-IN' ? 'ta-IN' : 'en-IN';
  let speakOn = store.get('easy.speak') !== 'off';
  const langBtn = root.querySelector('.easy-lang');
  const speakerBtn = root.querySelector('.easy-speaker');
  const micBtn = root.querySelector('.easy-mic');
  const showLang = () => { langBtn.textContent = LANGS.find(l => l[0] === lang)[1]; };
  const showSpeaker = () => { speakerBtn.textContent = speakOn ? '🔊' : '🔇'; speakerBtn.setAttribute('aria-pressed', String(speakOn)); };
  showLang(); showSpeaker();
  langBtn.addEventListener('click', () => { lang = lang === 'en-IN' ? 'ta-IN' : 'en-IN'; store.set('easy.voiceLang', lang); showLang(); });
  speakerBtn.addEventListener('click', () => { speakOn = !speakOn; store.set('easy.speak', speakOn ? 'on' : 'off'); showSpeaker(); if(!speakOn) hush(); });

  /** Listen once. onText(text, final) as words arrive; resolves with the final text ('' if nothing). */
  let listening = null;
  function listen({ continuous = false, onText = () => {} } = {}){
    if(!SR) return Promise.reject(new Error('Voice needs Chrome, Edge or Safari on this device'));
    hush();
    return new Promise((resolve, reject) => {
      const r = new SR();
      r.lang = lang; r.interimResults = true; r.continuous = continuous; r.maxAlternatives = 1;
      let finalText = '', err = null;
      r.onresult = e => {
        let interim = '';
        for(let i = e.resultIndex; i < e.results.length; i++){
          if(e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
          else interim += e.results[i][0].transcript;
        }
        onText((finalText + interim).trim(), !interim);
      };
      r.onerror = e => { err = e.error; };
      r.onend = () => {
        listening = null;
        if(err && err !== 'no-speech' && err !== 'aborted') reject(new Error(err === 'not-allowed' || err === 'service-not-allowed' ? 'Allow the microphone for this site to talk to Eåsy' : 'Could not hear that — try again'));
        else resolve(finalText.trim());
      };
      listening = r;
      try { r.start(); } catch(e){ listening = null; reject(e); }
    });
  }
  const stopListening = () => { if(listening) try { listening.stop(); } catch(e){} };

  // Reading aloud: the words only — no ids, no markdown, no links.
  function speakable(text){
    return String(text || '').replace(/\[lead:[^\]]+\]/g, '').replace(/\*\*/g, '').replace(/https?:\/\/\S+/g, 'the link')
      .replace(/^[•\-\d.)\s]+/gm, '').replace(/\n{2,}/g, '. ').replace(/\n/g, '. ').replace(/\s{2,}/g, ' ').trim();
  }
  function say(text){
    if(!speakOn || !('speechSynthesis' in window)) return;
    const t = speakable(text);
    if(!t) return;
    hush();
    const u = new SpeechSynthesisUtterance(t.length > 900 ? t.slice(0, t.lastIndexOf('. ', 900) + 1 || 900) : t);
    u.lang = /[஀-௿]/.test(t) ? 'ta-IN' : 'en-IN';
    const v = speechSynthesis.getVoices().find(x => x.lang === u.lang) || speechSynthesis.getVoices().find(x => x.lang && x.lang.startsWith(u.lang.slice(0, 2)));
    if(v) u.voice = v;
    u.rate = 1.02;
    speechSynthesis.speak(u);
  }
  function hush(){ try { if('speechSynthesis' in window) speechSynthesis.cancel(); } catch(e){} }

  micBtn.addEventListener('click', async () => {
    if(listening){ stopListening(); return; }
    if(busy) return;
    micBtn.classList.add('on'); input.placeholder = lang === 'ta-IN' ? 'பேசுங்கள்…' : 'Listening…';
    try {
      const text = await listen({ onText: t => { input.value = t; } });
      if(text) ask(text, { voice: true });
    } catch(err){
      add('easy-bot easy-err', esc(err.message));
    } finally {
      micBtn.classList.remove('on'); input.placeholder = 'Ask Eåsy…';
    }
  });
  if(!SR) { micBtn.disabled = true; micBtn.title = 'Voice needs Chrome, Edge or Safari'; }

  function setOpen(open){
    panel.hidden = !open;
    fab.setAttribute('aria-expanded', String(open));
    if(open){ dot.hidden = true; input.focus(); askNotifyPermission(); }
  }
  fab.addEventListener('click', () => setOpen(panel.hidden));
  root.querySelector('.easy-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && !panel.hidden) setOpen(false); });

  function add(cls, html){
    const el = document.createElement('div');
    el.className = 'easy-msg ' + cls;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  const dropChips = () => { const c = log.querySelector('.easy-chips'); if(c) c.remove(); };

  // ── Cards ──
  function draftCard(d){
    const el = add('easy-card easy-draft', `
      <div class="easy-card-head">To ${esc(d.toName)} · WhatsApp</div>
      <textarea class="easy-draft-text" rows="4" maxlength="1000">${esc(d.text)}</textarea>
      <div class="easy-row">
        <button type="button" class="easy-btn primary" data-do="send">Send</button>
        <button type="button" class="easy-btn" data-do="drop">Discard</button>
      </div>`);
    el.dataset.draft = d.id; el.dataset.phone = d.phone;
  }
  function changeCard(c){
    const el = add('easy-card easy-change', `
      <div class="easy-card-head">${esc(c.title)}</div>
      <ul class="easy-lines">${(c.lines || []).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      <div class="easy-row">
        <button type="button" class="easy-btn primary" data-do="yes">Yes</button>
        <button type="button" class="easy-btn" data-do="no">No</button>
      </div>`);
    el.dataset.change = c.id;
  }
  function linkCard(l){
    add('easy-card', `<div class="easy-card-head">${esc(l.label)}</div><a class="easy-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a>`);
  }
  function planCard(plan){
    if(!plan || !plan.length) return;
    add('easy-card easy-plan', `<div class="easy-card-head">Today's plan</div><ol class="easy-plan-list">${plan.map(p =>
      `<li class="pr-${esc(p.priority)}"><span class="easy-plan-time">${esc(p.time)}</span><span class="easy-plan-what">${esc(p.title)}${p.detail ? `<small>${esc(p.detail)}</small>` : ''}</span>${leadBtn(p.leadId)}</li>`).join('')}</ol>`);
  }
  function gistCard(r){
    const g = r.gist || {}, L = g.lead || {}, P = g.property, O = g.owner;
    add('easy-card easy-gist', `
      <div class="easy-card-head">${esc(r.title)}</div>
      <div><b>${esc(L.name || '')}</b>${L.phone ? ' · ' + esc(L.phone) : ''}${L.wants ? `<br>${esc(L.wants)}` : ''}</div>
      ${(L.lastNotes || []).map(n => `<div class="easy-gist-note">“${esc(n)}”</div>`).join('')}
      ${P ? `<div><b>${esc(P.code || '')}</b> ${esc(P.name || '')}${P.config ? ' · ' + esc(P.config) : ''}${P.price ? ' · ' + esc(P.price) : ''}${P.facing ? ' · ' + esc(P.facing) + ' facing' : ''}</div>` : ''}
      ${P && P.map ? `<a class="easy-link" href="${esc(P.map)}" target="_blank" rel="noopener">Map pin</a>` : ''}
      ${O && O.name ? `<div>Owner: ${esc(O.name)}${O.phone ? ' · ' + esc(O.phone) : ''}</div>` : ''}
      ${leadBtn(r.leadId)}`);
  }
  function reminderCard(r){
    if(r.kind === 'gist') return gistCard(r);
    add('easy-card easy-remind', `<div class="easy-card-head">⏰ ${esc(r.title)}</div>${r.body ? `<div>${esc(r.body)}</div>` : ''}${leadBtn(r.leadId)}`);
  }

  function showResult(data){
    planCard(data.plan);
    (data.links || []).forEach(linkCard);
    (data.drafts || []).forEach(draftCard);
    (data.changes || []).forEach(changeCard);
  }

  // ── Clicks ──
  function markDraft(card, status){
    const t = card.querySelector('.easy-draft-text');
    return post({ action:'draft', draftId: card.dataset.draft, status, text: t ? t.value : undefined }).catch(() => {});
  }
  log.addEventListener('click', async e => {
    const chip = e.target.closest('.easy-chip');
    if(chip){ ask(chip.textContent); return; }
    const lead = e.target.closest('.easy-lead');
    if(lead){ if(typeof openDetail === 'function'){ setOpen(false); openDetail(lead.dataset.lead); } return; }
    const btn = e.target.closest('[data-do]');
    if(!btn) return;
    const card = btn.closest('.easy-card');
    const row = card.querySelector('.easy-row');
    const act = btn.dataset.do;
    if(card.dataset.draft){
      if(act === 'send'){
        // The edited text is what the link carries (MVP-08).
        const text = card.querySelector('.easy-draft-text').value.trim();
        if(!text) return;
        window.open('https://wa.me/' + card.dataset.phone + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
        markDraft(card, 'opened');
        row.innerHTML = '<span class="easy-q">Sent?</span><button type="button" class="easy-btn primary" data-do="sent">Yes</button><button type="button" class="easy-btn" data-do="send">Open again</button>';
      } else if(act === 'sent'){
        markDraft(card, 'sent');
        card.querySelector('.easy-draft-text').readOnly = true;
        row.innerHTML = '<span class="easy-ok">✓ Sent</span>';
      } else if(act === 'drop'){
        markDraft(card, 'discarded');
        card.remove();
      }
    } else if(card.dataset.change){
      row.innerHTML = '<span class="easy-q">Saving…</span>';
      try{
        const r = await post({ action:'confirm', changeId: card.dataset.change, yes: act === 'yes' });
        row.innerHTML = r.status === 'applied' ? `<span class="easy-ok">✓ ${esc(r.done || 'Done')}</span>` : '<span class="easy-q">Not saved</span>';
      } catch(err){ row.innerHTML = `<span class="easy-err-text">${esc(err.message)}</span>`; }
    }
  });
  form.addEventListener('submit', e => { e.preventDefault(); ask(input.value); });

  async function ask(text, opts = {}){
    text = String(text || '').trim();
    if(!text || busy) return;
    busy = true;
    input.value = '';
    dropChips();
    add('easy-user', (opts.voice ? '🎤 ' : '') + esc(text));
    history.push({ role:'user', text });
    const wait = add('easy-bot', '<span class="easy-dots">Looking</span>');
    try{
      const data = await post({ history, voice: !!opts.voice });
      wait.innerHTML = render(data.reply || '');
      showResult(data);
      if(opts.voice) say(data.reply);
      // What was drafted and prepared goes back as text too, so "make it shorter" knows what it was.
      const extra = [...(data.drafts || []).map(d => `[Drafted for ${d.toName}: ${d.text}]`), ...(data.changes || []).map(c => `[Prepared: ${c.title} ${c.lines.join('; ')}]`)].join('\n');
      history.push({ role:'assistant', text: (data.reply || '') + (extra ? '\n' + extra : '') });
    } catch(err){
      wait.classList.add('easy-err');
      wait.textContent = err.message || 'Something went wrong';
      history.pop();   // the question was not answered — don't send it back as if it were
    } finally {
      busy = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  // ── Log call (MVP-09): the lead and what was said; Eåsy prepares the note and the follow-up ──
  root.querySelector('.easy-logcall').addEventListener('click', () => {
    if(panel.hidden) setOpen(true);
    if(log.querySelector('.easy-callform')) return;
    dropChips();
    const list = (typeof leads !== 'undefined' && Array.isArray(leads)) ? leads : [];
    const recent = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 200);
    const el = add('easy-card easy-callform', `
      <div class="easy-card-head">📞 Notes after a call</div>
      <input class="easy-call-lead" list="easyCallLeads" placeholder="Who was the call with?" autocomplete="off">
      <datalist id="easyCallLeads">${recent.map(l => `<option value="${esc((l.name || 'Lead') + ' · ' + (l.phone || l.id))}">`).join('')}</datalist>
      <textarea class="easy-call-text" rows="4" placeholder="Tap 🎤 Speak and say what was said — requirement changes, feedback, next step and when"></textarea>
      <div class="easy-row">
        <button type="button" class="easy-btn easy-call-mic">🎤 Speak</button>
        <button type="button" class="easy-btn primary easy-call-save">Prepare note</button>
        <button type="button" class="easy-btn easy-call-cancel">Cancel</button>
      </div>`);
    el.querySelector('.easy-call-lead').focus();
    el.querySelector('.easy-call-cancel').addEventListener('click', () => { stopListening(); el.remove(); });
    // Dictation: keeps listening until tapped again; what is heard is added to what is there.
    const callMic = el.querySelector('.easy-call-mic'), callText = el.querySelector('.easy-call-text');
    if(!SR) callMic.hidden = true;
    callMic.addEventListener('click', async () => {
      if(listening){ stopListening(); return; }
      const before = callText.value.trim();
      callMic.classList.add('on'); callMic.textContent = '■ Stop';
      try { await listen({ continuous: true, onText: t => { callText.value = (before ? before + ' ' : '') + t; } }); }
      catch(err){ add('easy-bot easy-err', esc(err.message)); }
      finally { callMic.classList.remove('on'); callMic.textContent = '🎤 Speak'; }
    });
    el.querySelector('.easy-call-save').addEventListener('click', () => {
      const who = el.querySelector('.easy-call-lead').value.trim();
      const text = el.querySelector('.easy-call-text').value.trim();
      if(!who || !text) return;
      const lead = recent.find(l => who === (l.name || 'Lead') + ' · ' + (l.phone || l.id));
      stopListening();
      el.remove();
      ask(`Call notes for ${lead ? `${lead.name || 'lead'} [lead:${lead.id}]` : who}: ${text}\n(Prepare these as call notes on the lead, with the next follow-up if I gave one.)`);
    });
  });

  // ── Reminders (MVP-11/12/13): asked each minute while the page is open ──
  let shown = [];
  try { shown = JSON.parse(localStorage.getItem(SHOWN_KEY) || '[]'); } catch(e){ shown = []; }
  const remember = key => { shown = [...shown.filter(k => k !== key), key].slice(-300); try { localStorage.setItem(SHOWN_KEY, JSON.stringify(shown)); } catch(e){} };
  let asked = false;
  function askNotifyPermission(){
    if(asked || !('Notification' in window) || Notification.permission !== 'default') return;
    asked = true;
    try { Notification.requestPermission(); } catch(e){}
  }
  function notify(r){
    try {
      if('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible'){
        const n = new Notification('Eåsy — ' + r.title, { body: r.body || (r.gist && r.gist.lead && r.gist.lead.wants) || '', tag: r.key });
        n.onclick = () => { window.focus(); setOpen(true); };
      }
    } catch(e){}
  }
  async function poll(){
    if(document.visibilityState === 'hidden' && !('Notification' in window)) return;
    try{
      const data = await post({ action:'reminders' });
      for(const r of data.reminders || []){
        if(shown.includes(r.key)) continue;
        remember(r.key);
        dropChips();
        reminderCard(r);
        notify(r);
        // Heard as well as seen, when the page is in front and the speaker is on.
        if(document.visibilityState === 'visible') say(r.kind === 'gist' ? `${r.title}. ${(r.gist && r.gist.lead && r.gist.lead.wants) || ''}` : r.title);
        if(panel.hidden) dot.hidden = false;
      }
    } catch(e){}
  }

  // ── Switched on? Only then does the button appear and the reminders start. ──
  (async function boot(){
    for(let i = 0; i < 40 && !(window.crmAuth && await window.crmAuth.getIdToken().catch(() => null)); i++) await new Promise(r => setTimeout(r, 500));
    try { await post({ action:'ping' }); }
    catch(e){ if(e.disabled) return; }
    root.hidden = false;
    poll();
    setInterval(poll, POLL_MS);
  })();
})();
