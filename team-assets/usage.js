// ═══════ TEAM & ACCESS → DATABASE USAGE ═══════
// Every read and write the site made, by what it was for (api/_usage.js on the server,
// shared-assets/fs-metered.js on the pages), per Firebase day (1:30 PM to 1:30 PM India time).
// Owner, 27 Nov 2026: "so that I can find it next time". Admins only (usage-read refuses others).
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { describe } from '../shared-assets/usage-catalog.js';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('en-IN');
const FREE_READS = 50000, FREE_WRITES = 20000;
let days = [], dayId = null, who = 'all', loaded = false, loading = false;

const signedIn = () => new Promise(res => { const a = getAuth(); if (a.currentUser) return res(a.currentUser); const un = onAuthStateChanged(a, u => { if (u) { un(); res(u); } }); });
async function api(action, body = {}) {
  const token = await (await signedIn()).getIdToken();
  const r = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action, ...body }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
// "2026-11-27" (Pacific) → "27 Nov, 1:30 PM → 28 Nov, 1:30 PM"
function dayWords(id) {
  const [y, m, d] = id.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 8, 0));   // ~midnight Pacific (PST) = 8:00 UTC
  const f = t => t.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).replace(/\b(am|pm)\b/g, x => x.toUpperCase());
  return f(start) + ' → ' + f(new Date(start.getTime() + 86400000));
}
function rows(d) {
  const out = [];
  Object.entries(d.srv || {}).forEach(([k, v]) => out.push({ side: 'Server', name: k, r: v.r || 0, w: v.w || 0, n: v.n || 0 }));
  Object.entries(d.cli || {}).forEach(([k, v]) => out.push({ side: 'Page', name: k, r: v.r || 0, w: v.w || 0, n: v.n || 0 }));
  return out.sort((a, b) => b.r - a.r || b.w - a.w);
}
function bar(n, max, cls) { return `<span class="u-bar ${cls || ''}" style="--p:${max ? Math.min(100, Math.round(100 * n / max)) : 0}%"></span>`; }

function render() {
  const box = $('usage');
  if (!box) return;
  if (!days.length) {
    box.innerHTML = `<div class="card"><div class="empty">${loading ? 'Loading…' : 'Nothing counted yet. Counting started with this update — come back after the team has used the site for a while.'}</div></div>`;
    return;
  }
  const d = days.find(x => x.id === dayId) || days[0];
  const tot = d.tot || {}, all = rows(d);
  const list = all.filter(x => who === 'all' || (who === 'srv' ? x.side === 'Server' : x.side === 'Page'));
  const R = tot.r || 0, W = tot.w || 0, logW = d.logW || 0;
  const srvR = all.filter(x => x.side === 'Server').reduce((n, x) => n + x.r, 0), cliR = R - srvR;
  // Hours in Firebase's day order: 13 → 23, 00 → 12 (India time).
  const order = [...Array(24).keys()].map(i => String((13 + i) % 24).padStart(2, '0'));
  const hmax = Math.max(1, ...order.map(h => ((d.hours || {})[h] || {}).r || 0));
  box.innerHTML = `
    <div class="u-head">
      <label class="u-pick"><span>Day</span><select id="uDay">${days.map(x => `<option value="${esc(x.id)}"${x.id === d.id ? ' selected' : ''}>${esc(dayWords(x.id))}</option>`).join('')}</select></label>
      <button type="button" class="btn sm" id="uReload"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Refresh</button>
    </div>
    <div class="u-tiles">
      <div class="u-tile"><b>${fmt(R)}</b><small>reads counted</small>${bar(R, FREE_READS, R > FREE_READS ? 'over' : '')}<small>${Math.round(100 * R / FREE_READS)}% of the free ${fmt(FREE_READS)}</small></div>
      <div class="u-tile"><b>${fmt(W + logW)}</b><small>writes (${fmt(logW)} of them this log)</small>${bar(W + logW, FREE_WRITES)}<small>${Math.round(100 * (W + logW) / FREE_WRITES)}% of the free ${fmt(FREE_WRITES)}</small></div>
      <div class="u-tile"><b>${fmt(srvR)}</b><small>reads by the server</small><small>${fmt(cliR)} by the pages</small></div>
    </div>
    <p class="note">Compare with Firebase: <b>Firebase console → Firestore Database → Usage</b>, the same day. Firebase’s figure also includes its own console (browsing data there costs reads); the pages’ figures here are close estimates (a page cannot see exactly what Firebase bills).</p>
    <div class="card u-hours" aria-label="Reads per hour (India time)">
      ${order.map(h => { const v = ((d.hours || {})[h] || {}).r || 0; return `<div class="u-h" title="${h}:00 — ${fmt(v)} reads"><span style="--p:${Math.round(100 * v / hmax)}%"></span><small>${Number(h) % 3 ? '' : h}</small></div>`; }).join('')}
    </div>
    <div class="chips u-who" role="group" aria-label="Show">
      ${[['all', 'Everything'], ['srv', 'Server'], ['cli', 'Pages']].map(([k, l]) => `<button type="button" class="chip" data-who="${k}" aria-pressed="${who === k}">${l}</button>`).join('')}
    </div>
    <div class="card u-table">
      <div class="u-r u-th"><span>What</span><span>Times</span><span>Reads</span><span>Writes</span></div>
      ${list.length ? list.map(x => { const ds = describe(x.name); return `<div class="u-r">
        <span><b>${esc(ds.what || x.name)}</b><small><span class="tag">${x.side}</span> ${esc(x.name)}</small>${ds.tip ? `<small class="u-tip">${esc(ds.tip)}</small>` : ''}</span>
        <span>${fmt(x.n)}</span><span><b>${fmt(x.r)}</b><small>${R ? Math.round(100 * x.r / R) : 0}%</small></span><span>${fmt(x.w)}</span></div>`; }).join('') : '<div class="empty">Nothing here for this day.</div>'}
    </div>`;
  $('uDay').addEventListener('change', e => { dayId = e.target.value; render(); });
  $('uReload').addEventListener('click', () => load(true));
  box.querySelectorAll('[data-who]').forEach(b => b.addEventListener('click', () => { who = b.dataset.who; render(); }));
}
async function load(force) {
  if (loading || (loaded && !force)) return;
  loading = true; render();
  try { const r = await api('usage-read', { days: 7 }); days = (r.days || []).sort((a, b) => b.id.localeCompare(a.id)); loaded = true; if (!dayId && days[0]) dayId = days[0].id; }
  catch (e) { $('usage').innerHTML = `<div class="card"><div class="empty">${esc(e.message)}</div></div>`; loading = false; return; }
  loading = false; render();
}
document.addEventListener('team-usage-open', () => load(false));
// Opened straight on this tab (team.html?tab=usage): the tab showed before this file was listening.
{ const t = document.getElementById('tab-usage'); if (t && !t.hidden) load(false); }
