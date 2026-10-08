// ═══════ CREATE BROCHURE (embedded Google Form submit) ═══════
// Submits directly to the "3 PIN Realty - New Listing Intake" Google Form's
// response endpoint, so the same automation (brochure build + inventory sync)
// still fires — without ever leaving or showing the Google Forms UI.
const BROCHURE_FORM_ACTION = 'https://docs.google.com/forms/d/e/1FAIpQLSdhhCVV3frLlFaN8FXpGB0exOXT2He4VWPnOqTdEUeV82fLMA/formResponse';
const BROCHURE_FIELD_MAP = {
  title:    'entry.1238821452', // Property ID & Title
  drive:    'entry.1785532374', // Google Drive Photo Folder Link
  details:  'entry.134248436',  // Property Details (required)
  // Q4 on the form, and column E of the Queue sheet. Submitting without it
  // is what left the Internal Notes tab permanently empty for every listing
  // created from this modal rather than from the Google Form UI — the
  // scheduler imports that column, but nothing was ever putting anything in
  // it from here.
  internal: 'entry.1764716931'  // Internal TEAM Instructions and Notes
};

// A page now, not a pop-up: room to paste a long description, a checklist beside it, and a
// draft kept on this device so leaving the page loses nothing.
const BF_DRAFT_KEY = 'brochureDraft';
const BF_RECENT_KEY = 'brochureRecent';
const BF_FIELDS = ['bfTitle', 'bfDrive', 'bfDetails', 'bfInternal'];
const bfEl = id => document.getElementById(id);
const bfStore = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* this visit only */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* fine */ } }
};

function bfCountUpdate(){
  const n = (bfEl('bfDetails').value || '').trim().length;
  bfEl('bfCount').textContent = n ? `${n.toLocaleString()} characters` : '';
}
function saveBrochureDraft(){
  const d = {}; BF_FIELDS.forEach(id => { d[id] = bfEl(id).value; });
  if (BF_FIELDS.some(id => d[id].trim())) { bfStore.set(BF_DRAFT_KEY, { at: Date.now(), d }); bfEl('bfDraftNote').textContent = 'Draft saved on this device'; }
  else { bfStore.del(BF_DRAFT_KEY); bfEl('bfDraftNote').textContent = ''; }
  bfCountUpdate();
}
function clearBrochureDraft(ask){
  const any = BF_FIELDS.some(id => bfEl(id).value.trim());
  if (ask && any && !confirm('Clear everything typed here?')) return;
  bfEl('brochureForm').reset();
  bfStore.del(BF_DRAFT_KEY);
  bfEl('bfDraftNote').textContent = '';
  bfCountUpdate();
  bfCodeVerdict();
}

// ── The code: existing codes suggested as it is typed, marked "Already exists", with the next
// free number in each series — so a new listing never takes a code the inventory already has,
// and the series show how codes are numbered. The rules are the Property & Media board's
// (track-assets/brochure-flow.js), loaded as window.BrochureCodes.
const bfRules = () => window.BrochureCodes;
const bfInventory = () => (typeof properties !== 'undefined' ? properties : [])
  .map(p => ({ id: p.id, propertyCode: String(p.propertyCode || p.id || ''), name: p.name || '', location: p.location || '' }))
  // A property added in the dashboard without a code is filed as p<timestamp> — not a code anyone types.
  .filter(p => !/\d{9,}$/.test(p.propertyCode));
// Until the real inventory has arrived `properties` is only sample data (no real codes), and a
// "new code" verdict then would be a guess.
const bfReady = () => bfRules() && bfInventory().some(p => bfRules().isRealCode(p.propertyCode) && bfRules().looksLikeCode(p.propertyCode));
// The code as the pipeline will file it: the inventory's own spelling for a code that exists
// (SRS_OMR001 keeps its underscore), capitals otherwise, a proper code without dashes.
function bfCanon(raw, inv){
  const B = bfRules(), key = B.codeKey(raw);
  const hit = inv.find(p => B.isRealCode(p.propertyCode) && B.codeKey(p.propertyCode) === key);
  if (hit) return hit.propertyCode;
  return /_/.test(raw) ? raw.toUpperCase() : B.normCode(raw);
}
// "TNAG0002 - T Nagar 2BHK": the code is the first word.
const bfTypedCode = v => String(v || '').trim().split(/\s+/)[0];
// Each series of codes (TNAG0001, TNAG0002 … is the TNAG series): how many, the latest, the next free.
function bfSeries(inv){
  const B = bfRules(), m = new Map();
  for (const p of inv) {
    if (!B.isRealCode(p.propertyCode) || /_/.test(p.propertyCode) || !B.looksLikeCode(p.propertyCode)) continue;
    const s = B.codeKey(p.propertyCode).match(/^([A-Z]+)(\d+)$/);
    if (!s) continue;
    const n = parseInt(s[2], 10);
    const g = m.get(s[1]) || { letters: s[1], count: 0, max: -1, width: s[2].length, last: '' };
    g.count++;
    if (n > g.max) { g.max = n; g.width = s[2].length; g.last = p.propertyCode; }
    m.set(s[1], g);
  }
  const taken = new Set(inv.map(p => B.codeKey(p.propertyCode)));
  for (const g of m.values()) {
    let n = g.max + 1;
    while (taken.has(g.letters + String(n).padStart(g.width, '0'))) n++;
    g.next = g.letters + String(n).padStart(g.width, '0');
  }
  return m;
}
const bfPlural = n => n === 1 ? '1 property' : `${n} properties`;

let bfCodeOpts = [], bfCodeAt = -1;
function bfCodeInput(){
  const B = bfRules(), inp = bfEl('bfTitle');
  if (!B || !inp || !bfEl('bfCodePop')) return;
  bfCodeVerdict();
  if (!bfReady()) { bfCodeClose(); return; }
  const v = inp.value, lead = v.length - v.trimStart().length;
  // Only while the code itself is being typed — once the caret is in the title, the list steps aside.
  const codeEnd = lead + v.trimStart().search(/\s|$/);
  if (document.activeElement !== inp || inp.selectionStart > codeEnd) { bfCodeClose(); return; }
  const inv = bfInventory(), series = bfSeries(inv);
  const key = B.codeKey(bfTypedCode(v));
  const opts = [];
  let head = '';
  if (!key) {
    head = 'Codes are locality letters, then a number. Pick a series for its next free code.';
    [...series.values()].sort((a, b) => a.letters.localeCompare(b.letters))
      .forEach(g => opts.push({ code: g.next, main: g.letters, sub: `${bfPlural(g.count)} · latest ${g.last}`, tag: `Next: ${g.next}`, kind: 'next' }));
  } else {
    const letters = (key.match(/^[A-Z]+/) || [''])[0];
    // Letters only ("TNA") — every series it could be; letters and a number — that series.
    const fits = [...series.values()].filter(g => /\d/.test(key) ? g.letters === letters : g.letters.startsWith(key))
      .sort((a, b) => a.letters.localeCompare(b.letters)).slice(0, 3);
    fits.forEach(g => opts.push({ code: g.next, main: g.next, sub: `Next free in ${g.letters} · ${bfPlural(g.count)}, latest ${g.last}`, tag: 'New', kind: 'next' }));
    const exact = inv.filter(p => B.isRealCode(p.propertyCode) && B.codeKey(p.propertyCode) === key);
    const near = B.codeSuggestions(key, inv, 30).filter(p => B.codeKey(p.propertyCode) !== key);
    [...exact, ...near].slice(0, 12).forEach(p => opts.push({ code: p.propertyCode, main: p.propertyCode,
      sub: [p.name, p.location].filter(Boolean).join(' · '), tag: 'Already exists', kind: 'dup' }));
  }
  bfCodeOpts = opts;
  if (bfCodeAt >= opts.length) bfCodeAt = -1;
  const pop = bfEl('bfCodePop');
  if (!opts.length) { bfCodeClose(); return; }
  pop.innerHTML = (head ? `<div class="bf-code-head">${escapeHtml(head)}</div>` : '') + opts.map((o, i) =>
    `<button type="button" class="bf-code-opt ${o.kind}${i === bfCodeAt ? ' at' : ''}" role="option" id="bfCodeOpt${i}" data-i="${i}" tabindex="-1" aria-selected="${i === bfCodeAt}">
      <span class="bf-code-main"><b>${escapeHtml(o.main)}</b><small>${escapeHtml(o.sub)}</small></span>
      <span class="bf-code-tag ${o.kind}">${escapeHtml(o.tag)}</span>
    </button>`).join('');
  pop.hidden = false;
  inp.setAttribute('aria-expanded', 'true');
  if (bfCodeAt >= 0) inp.setAttribute('aria-activedescendant', 'bfCodeOpt' + bfCodeAt); else inp.removeAttribute('aria-activedescendant');
}
function bfCodeClose(){
  const pop = bfEl('bfCodePop');
  if (!pop) return;
  pop.hidden = true; pop.innerHTML = '';
  bfCodeOpts = []; bfCodeAt = -1;
  bfEl('bfTitle').setAttribute('aria-expanded', 'false');
  bfEl('bfTitle').removeAttribute('aria-activedescendant');
}
// Picking a code puts it first and keeps any title already typed after it.
function bfCodeUse(i){
  const o = bfCodeOpts[i]; if (!o) return;
  const inp = bfEl('bfTitle');
  const rest = inp.value.trim().split(/\s+/).slice(1).join(' ').replace(/^[-–—:]\s*/, '');
  inp.value = `${o.code} - ${rest}`;
  inp.setSelectionRange(inp.value.length, inp.value.length);
  bfCodeClose();
  saveBrochureDraft();
  bfCodeVerdict();
}
// Caret moved by keys: the list follows whether the caret is still in the code.
function bfCodeKeyup(e){ if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) bfCodeInput(); }
function bfCodePick(e){ const b = e.target.closest('.bf-code-opt'); if (b) bfCodeUse(+b.dataset.i); }
function bfCodeKey(e){
  // Escape closes the list only — not the page behind it.
  if (e.key === 'Escape' && !bfEl('bfCodePop').hidden) { e.preventDefault(); e.stopPropagation(); bfCodeClose(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (bfEl('bfCodePop').hidden) { bfCodeInput(); if (bfEl('bfCodePop').hidden) return; }
    e.preventDefault();
    const n = bfCodeOpts.length;
    bfCodeAt = e.key === 'ArrowDown' ? (bfCodeAt + 1) % n : (bfCodeAt <= 0 ? n - 1 : bfCodeAt - 1);
    bfCodeInput();
    const at = bfEl('bfCodeOpt' + bfCodeAt); if (at) at.scrollIntoView({ block: 'nearest' });
    return;
  }
  // With the list showing, Enter picks (or just closes it) — it never submits the form from here.
  if (e.key === 'Enter' && !e.isComposing && !bfEl('bfCodePop').hidden) { e.preventDefault(); if (bfCodeAt >= 0) bfCodeUse(bfCodeAt); else bfCodeClose(); }
}
// The line under the field: taken, a near-miss, off the series' numbering, or new.
function bfCodeCheck(){
  const B = bfRules(), raw = bfTypedCode(bfEl('bfTitle').value);
  if (!B || !raw) return null;
  const inv = bfInventory(), key = B.codeKey(raw), code = bfCanon(raw, inv);
  const f = B.findCode(raw, inv, []);
  const g = bfSeries(inv).get((key.match(/^[A-Z]+/) || [''])[0]);
  if (f.inventory) return { kind: 'dup', prop: f.inventory, code: f.inventory.propertyCode, next: g && g.next };
  if (!B.looksLikeCode(raw)) return { kind: 'shape', next: g && g.next };
  const sim = B.similarCodes(raw, inv);
  if (sim.length) return { kind: 'near', sim, code };
  const n = parseInt(key.match(/\d+$/)[0], 10);
  if (g && (n !== g.max + 1 || key.match(/\d+$/)[0].length !== g.width) && code !== g.next) return { kind: 'off', code, g };
  return { kind: 'new', code };
}
function bfCodeVerdict(){
  const box = bfEl('bfCodeVerdict'); if (!box) return;
  const c = bfReady() ? bfCodeCheck() : null;
  if (!c) { box.innerHTML = ''; box.className = 'bf-code-v'; return; }
  const e = escapeHtml, place = p => [p.name, p.location].filter(Boolean).map(e).join(', ');
  const html = {
    dup: () => `<b>${e(c.code)} already exists</b> — ${place(c.prop) || 'in the inventory'}. Keep it only if this brochure is for that property${c.next ? `; for a new one use <b>${e(c.next)}</b>` : ''}.`,
    shape: () => c.next ? `Add the number — the next free code is <b>${e(c.next)}</b>.` : 'Codes look like <b>TNAG0002</b> — locality letters, then a number.',
    near: () => `<b>Did you mean ${c.sim.map(p => e(p.propertyCode)).join(' or ')}?</b> ${c.sim.length === 1 ? (place(c.sim[0]) || 'It') + ' is' : 'Those are'} already in the inventory. If ${e(c.code)} really is a new property, carry on.`,
    off: () => `${e(c.code)} is not taken, but the ${e(c.g.letters)} series is at ${e(c.g.last)} — the next free code is <b>${e(c.g.next)}</b>.`,
    new: () => `✓ ${e(c.code)} is a new code — not in the inventory yet.`
  }[c.kind]();
  box.className = 'bf-code-v ' + ({ dup: 'dup', near: 'warn', off: 'warn', shape: 'hint', new: 'ok' }[c.kind]);
  box.innerHTML = html;
}

// The team's log: title, who, when — and a link once the brochure is on that property.
async function brochureApi(method, body){
  const token = window.dashboardAuth && await window.dashboardAuth.getIdToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch('/api/brochure?op=log', {
    method, headers: { 'Authorization': 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}
let bfLog = null;
// Two tabs: the form, and the team's log of everything submitted with where each one stands.
let bfTab = 'new';
let bfStatus = 'all';
function setBrochureTab(tab){
  bfTab = tab === 'recent' ? 'recent' : 'new';
  bfEl('bpNew').hidden = bfTab !== 'new';
  bfEl('bpRecent').hidden = bfTab !== 'recent';
  bfEl('bpTabNew').classList.toggle('on', bfTab === 'new');
  bfEl('bpTabRecent').classList.toggle('on', bfTab === 'recent');
  if (bfTab === 'recent') renderBrochureRecent();
}
function setBrochureStatus(s){ bfStatus = s; drawBrochureLog(); }

async function renderBrochureRecent(){
  const box = bfEl('bfRecent');
  if (!bfLog) box.innerHTML = '<div class="empty-mini">Loading…</div>';
  try {
    const d = await brochureApi('GET');
    if (d && d.ok) bfLog = d.entries || [];
  } catch (e) { if (!bfLog) { box.innerHTML = '<div class="empty-mini">Could not load the log — check your connection.</div>'; return; } }
  drawBrochureLog();
}
const BF_STATES = [['all', 'All'], ['queued', 'In queue'], ['generated', 'Generated'], ['delivered', 'Delivered'], ['error', 'Needs attention']];
function drawBrochureLog(){
  const box = bfEl('bfRecent');
  const all = bfLog || [];
  const stOf = r => (r.status && r.status.state) || 'queued';
  bfEl('bpTabCount').textContent = all.length ? String(all.length) : '';
  bfEl('bpStatusFilter').innerHTML = BF_STATES.map(([k, l]) => {
    const n = k === 'all' ? all.length : all.filter(r => stOf(r) === k).length;
    return `<button type="button" class="fbtn${bfStatus === k ? ' at' : ''}${k === 'error' && n ? ' warn' : ''}" onclick="setBrochureStatus('${k}')">${l} <span class="bp-n">${n}</span></button>`;
  }).join('');
  const q = (bfEl('bpSearch').value || '').trim().toLowerCase();
  const list = all.filter(r => (bfStatus === 'all' || stOf(r) === bfStatus)
    && (!q || `${r.title} ${r.by || ''}`.toLowerCase().includes(q)));
  if (!list.length) { box.innerHTML = `<div class="empty-mini">${all.length ? 'Nothing matches.' : 'Nothing submitted yet.'}</div>`; return; }
  const byId = new Map((typeof properties !== 'undefined' ? properties : []).map(p => [String(p.id || '').toUpperCase(), p]));
  const fmt = ts => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const rows = list.map(r => {
    const st = r.status || { state: 'queued', label: 'In queue' };
    const pid = String(r.title || '').trim().split(/\s+/)[0].toUpperCase();
    const prop = byId.get(pid);
    const link = st.link || (prop && prop.brochureLink ? String(prop.brochureLink).trim() : '');
    const who = r.by ? r.by.split('@')[0].replace(/^./, c => c.toUpperCase()) : '<span class="bp-muted">not recorded</span>';
    return `<tr>
      <td class="bp-t">${escapeHtml(r.title || 'Untitled')}${st.state === 'error' && st.detail ? `<div class="bp-log-e">${escapeHtml(st.detail)}</div>` : ''}</td>
      <td>${r.by ? escapeHtml(who) : who}</td>
      <td class="bp-nw">${escapeHtml(fmt(r.at))}</td>
      <td><span class="bp-log-s ${escapeHtml(st.state)}"><span class="bp-dot"></span>${escapeHtml(st.label)}</span></td>
      <td class="bp-nw">${st.at ? escapeHtml(fmt(st.at)) : '<span class="bp-muted">—</span>'}</td>
      <td>${link ? `<a class="bp-open" href="${escapeHtml(link)}" target="_blank" rel="noopener">Open ↗</a>` : '<span class="bp-muted">—</span>'}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="bp-table-wrap"><table class="bp-table">
    <thead><tr><th>Property</th><th>Created by</th><th>Submitted</th><th>Status</th><th>Delivered</th><th>Brochure</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function openBrochureModal(){ openBrochurePage(); }
function openBrochurePage(){
  const err = bfEl('bfErr');
  err.classList.remove('show');
  err.textContent = '';
  bfEl('bfDone').hidden = true;
  bfEl('brochureForm').hidden = false;
  const draft = bfStore.get(BF_DRAFT_KEY, null);
  if (draft && draft.d) {
    BF_FIELDS.forEach(id => { bfEl(id).value = draft.d[id] || ''; });
    bfEl('bfDraftNote').textContent = 'Draft restored from ' + new Date(draft.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  bfCountUpdate();
  bfCodeVerdict();
  setBrochureTab(bfTab);
  renderBrochureRecent();
  bfEl('brochurePanel').classList.add('open');
  bfEl('brochurePanel').scrollTop = 0;
  setTimeout(() => bfEl(bfEl('bfTitle').value ? 'bfDetails' : 'bfTitle').focus(), 50);
}
function closeBrochureModal(){ closeBrochurePage(); }
function closeBrochurePage(){
  bfEl('brochurePanel').classList.remove('open');
}
function newBrochure(){
  clearBrochureDraft(false);
  bfEl('bfDone').hidden = true;
  bfEl('brochureForm').hidden = false;
  bfEl('bfTitle').focus();
}

async function submitBrochureForm(){
  let title = bfEl('bfTitle').value.trim();
  const drive = bfEl('bfDrive').value.trim();
  const details = bfEl('bfDetails').value.trim();
  const internal = bfEl('bfInternal').value.trim();
  const err = bfEl('bfErr');

  if(!details){
    err.textContent = 'Property details is required.';
    err.classList.add('show');
    bfEl('bfDetails').focus();
    return;
  }
  // A code already in the inventory sends this brochure to that property — fine for a redo,
  // wrong for a new listing. Asked, not refused.
  const taken = bfCodeCheck();
  if (taken && taken.kind === 'dup' && !confirm(`${taken.code} already exists — ${taken.prop.name || 'in the inventory'}.\n\nSubmit this brochure for that property?${taken.next ? `\n(For a new property, cancel and use ${taken.next}.)` : ''}`)) {
    bfEl('bfTitle').focus();
    return;
  }
  err.classList.remove('show');
  // The pipeline takes the first word exactly as typed and files the property under it, so the
  // code goes out as checked above: tnag-0002 would otherwise become a second, lower-case record.
  if (bfRules() && bfReady() && title) {
    const [first, ...rest] = title.split(/\s+/);
    if (bfRules().looksLikeCode(first) || /^[A-Za-z]+[_-]?[A-Za-z]*\d+$/.test(first)) title = [bfCanon(first, bfInventory()), ...rest].join(' ');
  }

  const btn = bfEl('bfSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  const body = new URLSearchParams();
  body.append(BROCHURE_FIELD_MAP.title, title);
  body.append(BROCHURE_FIELD_MAP.drive, drive);
  body.append(BROCHURE_FIELD_MAP.details, details);
  // Optional on the form, so only send it when there is something to send —
  // an empty value would still create a blank column E cell.
  if(internal) body.append(BROCHURE_FIELD_MAP.internal, internal);

  try {
    // Google Forms' response endpoint doesn't send CORS headers, so the
    // request must be fired "no-cors" — the browser still delivers it,
    // we just can't read the (opaque) response back.
    await fetch(BROCHURE_FORM_ACTION, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    // Logged for the team: the title only (or the first words of the details), who, when.
    try {
      const r = await brochureApi('POST', { title: title || details.replace(/\s+/g, ' ').slice(0, 80) });
      if (r && r.ok && r.entry) bfLog = [r.entry, ...(bfLog || [])];
    } catch (e) { /* the brochure is submitted; the log entry is best effort */ }
    clearBrochureDraft(false);
    bfEl('bfDoneWhat').textContent = title ? `“${title}” — you can close this page or create another.` : 'You can close this page or create another.';
    bfEl('bfDone').hidden = false;
    bfEl('brochureForm').hidden = true;
    drawBrochureLog();
    bfEl('brochurePanel').scrollTop = 0;
    showToast('✓ Submitted — brochure will be ready in ~30 min');
  } catch(e) {
    err.textContent = 'Could not submit — check your connection and try again. Your text is kept.';
    err.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Submit';
  }
}

// The verdict follows the inventory: it is blank until the real properties load, and refreshed when they do.
(function(){
  const hook = window.applyPropertiesSnapshot;
  if (typeof hook === 'function') window.applyPropertiesSnapshot = function(){ const r = hook.apply(this, arguments); try { bfCodeVerdict(); } catch (e) { /* cosmetic */ } return r; };
})();
