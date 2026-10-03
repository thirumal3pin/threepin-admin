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
async function renderBrochureRecent(){
  const box = bfEl('bfRecent');
  bfEl('bfRecentCard').hidden = false;
  if (!bfLog) box.innerHTML = '<div class="bp-p">Loading…</div>';
  try {
    const d = await brochureApi('GET');
    if (d && d.ok) bfLog = d.entries || [];
  } catch (e) { if (!bfLog) { box.innerHTML = '<div class="bp-p">Could not load the log.</div>'; return; } }
  drawBrochureLog();
}
function drawBrochureLog(){
  const box = bfEl('bfRecent');
  const list = bfLog || [];
  if (!list.length) { box.innerHTML = '<div class="bp-p">Nothing submitted yet.</div>'; return; }
  const byId = new Map((typeof properties !== 'undefined' ? properties : []).map(p => [String(p.id || '').toUpperCase(), p]));
  box.innerHTML = list.slice(0, 40).map(r => {
    const pid = String(r.title || '').trim().split(/\s+/)[0].toUpperCase();
    const prop = byId.get(pid);
    const st = r.status || null;
    const link = (st && st.link) || (prop && prop.brochureLink ? String(prop.brochureLink).trim() : '');
    const who = r.by ? r.by.split('@')[0].replace(/^./, c => c.toUpperCase()) : 'sender not recorded';
    const when = new Date(r.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return `<div class="bp-log">
      <div class="bp-log-t">${escapeHtml(r.title || 'Untitled')}</div>
      <div class="bp-log-m">${escapeHtml(who)} · ${escapeHtml(when)}</div>
      ${st ? `<div class="bp-log-s ${escapeHtml(st.state)}"><span class="bp-dot"></span>${escapeHtml(st.label)}${st.state === 'delivered' && st.at ? ' · ' + escapeHtml(new Date(st.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })) : ''}${link ? ` · <a href="${escapeHtml(link)}" target="_blank" rel="noopener">Open brochure ↗</a>` : ''}</div>` : ''}
      ${st && st.state === 'error' && st.detail ? `<div class="bp-log-e">${escapeHtml(st.detail)}</div>` : ''}
    </div>`;
  }).join('');
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
  const title = bfEl('bfTitle').value.trim();
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
  err.classList.remove('show');

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
    renderBrochureRecent();
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
