// ═══════════════════════════════════════════════════════════════════════
// EÅSY — the CRM's assistant (Eåsy Requirements Document v2, MVP).
//
// Plug-and-play: this file and easy.css are the whole page side, on every admin page (CRM,
// Properties, the property page, the board, Finance, Home). Remove their two lines from a page
// and Eåsy is gone there; set EASY_DISABLED=1 on the server and the button never appears.
// It needs nothing from the page: the sign-in is whichever the page has (crmAuth,
// dashboardAuth, trackAuth, financeAuth — or Firebase's own, all one project), and it appears
// only once someone is signed in. On the CRM it opens a lead in place and uses the page's
// lead list for Log call; elsewhere it opens crm.html?lead=… and asks the server for the list.
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
  // ── Kept in this browser, so Eåsy asks the server only when it has to ──
  // Every server ask can cost Firestore reads (and the free plan stops every page at 50K a day —
  // it did on 28 Oct 2026, when each open page asked for reminders every minute). So, per person:
  //   the day's schedule   fetched at most every 20 minutes (and right after a change Eåsy made),
  //                        by one tab, shared by every page and tab; reminders are timed from it here
  //   the chat             kept for the day across pages and reloads (↺ starts a new one)
  //   answers              the same question in the same place within 5 minutes is answered from
  //                        here, with its time and ↻ Refresh — no reads, no model call
  //   the Log call list    kept for 30 minutes
  const SCHED_TTL = 20 * 60000, ANSWER_TTL = 5 * 60000, LEADS_TTL = 30 * 60000;
  let me = '';          // the signed-in email, from the sign-in token — keys everything below
  const K = name => 'easy.' + name + '.' + (me || 'anon');
  const load = name => { try { return JSON.parse(localStorage.getItem(K(name)) || 'null'); } catch(e){ return null; } };
  const keep = (name, v) => { try { localStorage.setItem(K(name), JSON.stringify(v)); } catch(e){} };
  const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const hhmm = t => new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const hash = str => { let h = 5381; for(let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  function emailFromToken(t){
    if(/^dev:/.test(t)) return t.slice(4).toLowerCase();
    try { const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return String(JSON.parse(decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))))).email || '').toLowerCase(); }
    catch(e){ return ''; }
  }
  let history = [];   // { role, text }
  let busy = false;
  let isAdmin = false, isOff = false;   // the admin's switch (Eåsy on or off for the whole team)

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  // Plain text → safe HTML: **bold**, line breaks, and [lead:ID] as an open-lead button.
  function render(text){
    return esc(text)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[lead:([^\]\s]+)\]/g, (m, id) => `<button type="button" class="easy-lead" data-lead="${id}">Open lead</button>`)
      .replace(/\n/g, '<br>');
  }
  const leadBtn = id => id ? `<button type="button" class="easy-lead" data-lead="${esc(id)}">Open lead</button>` : '';

  // Whoever is signed in on this page. Every console signs in to the same Firebase project; the
  // home page keeps no object of its own, so Firebase is asked directly (the app it already started).
  const AUTHS = ['crmAuth', 'dashboardAuth', 'trackAuth', 'financeAuth'];
  const FB = 'https://www.gstatic.com/firebasejs/12.16.0/firebase-';
  async function idToken(){
    for(const k of AUTHS){
      const a = window[k];
      if(a && typeof a.getIdToken === 'function'){
        const t = await Promise.resolve(a.getIdToken()).catch(() => null);
        if(t) return t;
      }
    }
    try {
      const [{ getApps }, { getAuth }] = await Promise.all([import(FB + 'app.js'), import(FB + 'auth.js')]);
      const app = getApps()[0];
      const u = app && getAuth(app).currentUser;
      if(u) return await u.getIdToken();
    } catch(e){}
    return null;
  }
  const onCrm = () => !!window.crmAuth && typeof window.openDetail === 'function' && !!document.getElementById('dp');
  function openLead(id){
    if(onCrm()){ setOpen(false); openDetail(id); }
    else location.href = 'crm.html?lead=' + encodeURIComponent(id);
  }

  async function post(body){
    const token = await idToken();
    if(!token) throw new Error('Sign in first');
    const res = await fetch('/api/easy', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + token },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) {
      const e = new Error(data.error || 'Eåsy could not answer just now'); e.disabled = !!data.disabled;
      // Switched off while this page was open: an admin keeps the button (to switch it back), others lose it.
      // Either way the page goes quiet at once — no saved schedule left to remind from.
      if(e.disabled && body.action !== 'ping'){ isOff = true; hush(); keep('schedule', null); if(isAdmin && data.off) setOff(true); else root.hidden = true; }
      throw e;
    }
    return data;
  }

  const INTRO = `<p class="easy-hello">Tap 🎤 and speak — in English or Tamil — or type. I read, draft and prepare changes; you send, and you say Yes before anything is saved.</p>
        <div class="easy-chips">${SUGGESTIONS.map(s => `<button type="button" class="easy-chip">${esc(s)}</button>`).join('')}</div>`;
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
          <button type="button" class="easy-power" title="Switch Eåsy off for everyone" aria-label="Switch Eåsy on or off" hidden>⏻</button>
          <button type="button" class="easy-new" title="New chat" aria-label="New chat">↺</button>
          <button type="button" class="easy-logcall" title="Notes after a call">📞 Log call</button>
          <button type="button" class="easy-close" aria-label="Close">×</button>
        </div>
      </header>
      <div class="easy-log" aria-live="polite">${INTRO}</div>
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

  // ── The chat, kept for the day ──
  // What is on screen (cards and their state included) and what goes back to the model. A card
  // half-way through (Log call open, "Looking…") is not kept.
  let saveTimer = null;
  function writeChat(){
    saveTimer = null;
    if(!me) return;
    const c = log.cloneNode(true);
    c.querySelectorAll('.easy-callform, .easy-chips').forEach(x => x.remove());
    c.querySelectorAll('.easy-dots').forEach(x => { const m = x.closest('.easy-msg'); if(m) m.remove(); });
    keep('chat', { day: istToday(), history: history.slice(-24), html: c.innerHTML.slice(-150000) });
  }
  // At most every 300 ms however busy the chat is, and always on the way out of the page.
  function saveChat(){ if(me && !saveTimer) saveTimer = setTimeout(writeChat, 300); }
  addEventListener('pagehide', () => { if(saveTimer){ clearTimeout(saveTimer); writeChat(); } });
  function restoreChat(){
    const c = load('chat');
    if(!(c && c.day === istToday() && c.html && c.html.includes('easy-msg'))) return false;
    log.innerHTML = c.html;
    history = Array.isArray(c.history) ? c.history : [];
    log.scrollTop = log.scrollHeight;
    return true;
  }
  root.querySelector('.easy-new').addEventListener('click', () => {
    if(busy) return;
    stopListening(); hush();
    history = [];
    log.innerHTML = INTRO;
    keep('chat', null);
    input.focus();
  });
  // A draft edited by hand is kept as edited.
  log.addEventListener('input', e => { if(e.target.matches('textarea.easy-draft-text')){ e.target.textContent = e.target.value; saveChat(); } });
  new MutationObserver(() => saveChat()).observe(log, { childList: true, subtree: true, characterData: true });

  // ── Answers kept for 5 minutes: the same question after the same answer ──
  // The key is the question and what came before it — skipping earlier askings of this same
  // question, so asking it twice in a row finds the first answer.
  const norm = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  function answerKey(text){
    let i = history.length - 1;
    while(i >= 1 && history[i].role === 'assistant' && history[i - 1].role === 'user' && norm(history[i - 1].text) === norm(text)) i -= 2;
    return hash(norm(text)) + ':' + hash(i >= 0 ? history[i].text : '');
  }
  function cachedAnswer(key){
    const all = load('answers') || {};
    const a = all[key];
    return a && Date.now() - a.at < ANSWER_TTL ? a : null;
  }
  function keepAnswer(key, data){
    // Only what reads: an answer that drafted or prepared something is never replayed.
    if((data.drafts && data.drafts.length) || (data.changes && data.changes.length)) return;
    const all = load('answers') || {};
    for(const [k, v] of Object.entries(all)) if(Date.now() - v.at > ANSWER_TTL) delete all[k];
    all[key] = { at: Date.now(), data: { reply: data.reply, plan: data.plan, links: data.links } };
    keep('answers', all);
  }
  const forgetAnswers = () => keep('answers', null);

  // ── Clicks ──
  function markDraft(card, status){
    const t = card.querySelector('.easy-draft-text');
    return post({ action:'draft', draftId: card.dataset.draft, status, text: t ? t.value : undefined }).catch(() => {});
  }
  log.addEventListener('click', async e => {
    const chip = e.target.closest('.easy-chip');
    if(chip){ ask(chip.textContent); return; }
    const again = e.target.closest('.easy-refresh');
    if(again){ again.closest('.easy-asof').remove(); ask(again.dataset.q, { fresh: true }); return; }
    const lead = e.target.closest('.easy-lead');
    if(lead){ openLead(lead.dataset.lead); return; }
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
        // Something changed: saved answers may be out of date, and a new follow-up belongs in the schedule.
        if(r.status === 'applied'){ forgetAnswers(); refreshSchedule(true); }
      } catch(err){ row.innerHTML = `<span class="easy-err-text">${esc(err.message)}</span>`; }
    }
  });
  form.addEventListener('submit', e => { e.preventDefault(); ask(input.value); });

  async function ask(text, opts = {}){
    text = String(text || '').trim();
    if(!text || busy || isOff) return;
    busy = true;
    input.value = '';
    dropChips();
    add('easy-user', (opts.voice ? '🎤 ' : '') + esc(text));
    const key = answerKey(text);
    history.push({ role:'user', text });
    // Asked a moment ago, after the same answer: the saved answer, with its time and ↻ Refresh.
    const saved = !opts.fresh && cachedAnswer(key);
    if(saved){
      const d = saved.data;
      add('easy-bot', render(d.reply || ''));
      showResult(d);
      add('easy-asof', `Answered at ${esc(hhmm(saved.at))} <button type="button" class="easy-refresh" data-q="${esc(text)}">↻ Refresh</button>`);
      if(opts.voice) say(d.reply);
      history.push({ role:'assistant', text: d.reply || '' });
      busy = false;
      log.scrollTop = log.scrollHeight;
      return;
    }
    const wait = add('easy-bot', '<span class="easy-dots">Looking</span>');
    try{
      const data = await post({ history, voice: !!opts.voice });
      wait.innerHTML = render(data.reply || '');
      showResult(data);
      keepAnswer(key, data);
      if((data.changes && data.changes.length) || (data.drafts && data.drafts.length)) forgetAnswers();
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
  root.querySelector('.easy-logcall').addEventListener('click', async () => {
    if(panel.hidden) setOpen(true);
    if(log.querySelector('.easy-callform')) return;
    dropChips();
    // The CRM has every lead on the page already; anywhere else the server sends the short list.
    let list = (onCrm() && typeof leads !== 'undefined' && Array.isArray(leads)) ? leads : null;
    if(!list){
      const c = load('leads');
      if(c && Date.now() - c.at < LEADS_TTL) list = c.leads;
      else { try { list = (await post({ action:'leads' })).leads || []; keep('leads', { at: Date.now(), leads: list }); } catch(e){ list = (c && c.leads) || []; } }
    }
    if(log.querySelector('.easy-callform')) return;
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

  // ── On / off for the whole team (admins only) ──
  const powerBtn = root.querySelector('.easy-power');
  function setOff(off){
    isOff = off;
    root.classList.toggle('is-off', off);
    powerBtn.title = off ? 'Switch Eåsy on for everyone' : 'Switch Eåsy off for everyone';
    input.disabled = micBtn.disabled = off;
    input.placeholder = off ? 'Eåsy is off for everyone' : 'Ask Eåsy…';
    const note = log.querySelector('.easy-offnote');
    if(off && !note) add('easy-card easy-offnote', '<div class="easy-card-head">Eåsy is off</div><div>No one sees Eåsy and it reads nothing, until you switch it back on. The rest of the site works as usual.</div><div class="easy-row"><button type="button" class="easy-btn primary" data-power="on">Switch Eåsy on</button></div>');
    if(!off && note) note.remove();
  }
  async function switchEasy(on){
    if(!on && !confirm('Switch Eåsy off for everyone?\n\nNo one will see Eåsy and it will read nothing until an admin switches it back on. The rest of the site keeps working.')) return;
    try { const r = await post({ action:'switch', on }); setOff(r.off); if(!r.off) tick(); }
    catch(e){ add('easy-bot easy-err', esc(e.message)); }
  }
  powerBtn.addEventListener('click', () => switchEasy(isOff));
  log.addEventListener('click', e => { const b = e.target.closest('[data-power]'); if(b) switchEasy(b.dataset.power === 'on'); });

  // ── Reminders (MVP-11/12/13): timed here, from the day's schedule ──
  // The schedule comes from the server at most every 20 minutes, asked by one tab (the one in
  // front) and shared with every page and tab; checking it each half-minute costs nothing.
  // Every tab reads which reminders have been shown, so each shows once.
  const shownList = () => load('shown') || [];
  const remember = key => keep('shown', [...shownList().filter(k => k !== key), key].slice(-300));
  let fetching = null;
  function refreshSchedule(force){
    const s = load('schedule');
    if(!force && s && Date.now() - s.at < SCHED_TTL) return Promise.resolve(s);
    if(!force && document.visibilityState !== 'visible') return Promise.resolve(s);
    const lock = Number(load('schedLock')) || 0;
    if(!force && Date.now() - lock < 60000) return Promise.resolve(s);    // another tab is asking
    if(fetching) return fetching;
    keep('schedLock', Date.now());
    fetching = post({ action:'schedule' })
      .then(d => { const ns = { at: Date.now(), items: d.schedule || [] }; keep('schedule', ns); return ns; })
      .catch(e => e.disabled ? null : s)
      .finally(() => { fetching = null; });
    return fetching;
  }
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
  async function tick(){
    if(isOff) return;
    try{
      const s = await refreshSchedule(false);
      const now = Date.now();
      const shown = shownList();
      for(const r of (s && s.items) || []){
        if(!(r.from <= now && now < r.until) || shown.includes(r.key)) continue;
        remember(r.key);
        dropChips();
        reminderCard(r);
        notify(r);
        // Seen, not heard: Eåsy speaks only to answer a question asked by voice, never on its own.
        if(panel.hidden) dot.hidden = false;
      }
    } catch(e){}
  }

  // ── Switched on? Only then does the button appear and the reminders start. ──
  // Waits for a sign-in (a page may still be on its login screen), however long that takes.
  (async function boot(){
    while(!(await idToken())) await new Promise(r => setTimeout(r, 1500));
    let st = { enabled: true };
    try { st = await post({ action:'ping' }); }
    catch(e){ if(e.disabled) return; }                     // the site's master switch (Vercel)
    isAdmin = !!st.admin;
    if(st.off && !isAdmin) return;                          // switched off by the admin: no button
    me = emailFromToken((await idToken()) || '');
    restoreChat();
    root.hidden = false;
    root.querySelector('.easy-power').hidden = !isAdmin;
    setOff(!!st.off);
    liftAboveBars();
    tick();
    setInterval(tick, 30000);                               // looks at the saved schedule; asks the server at most every 20 min
    document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') tick(); });
    // Another tab started a new chat, or the day changed: keep this one in step when it comes to the front.
    addEventListener('storage', e => { if(e.key === K('chat') && e.newValue === 'null' && !busy){ history = []; log.innerHTML = INTRO; } });
  })();

  // On a phone, Finance has bottom tabs and the property page a bottom action bar: sit above them.
  function liftAboveBars(){
    const bars = [...document.querySelectorAll('.bottom, .mobile-actionbar')];
    const lift = () => {
      const h = Math.max(0, ...bars.map(b => { const s = getComputedStyle(b); return s.display === 'none' || s.position !== 'fixed' ? 0 : b.getBoundingClientRect().height; }));
      root.style.setProperty('--easy-lift', h + 'px');
    };
    lift();
    addEventListener('resize', lift);
  }
})();
