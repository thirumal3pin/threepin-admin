// ═══════ 3 PIN REALTY — FINANCE UI KIT ═══════
//
// Shared rendering helpers for 3pinfinance.html. Kept in its own module so the view files and
// app.js can both use them without importing each other, which would make a cycle.
//
// Views are plain functions that return an HTML string; app.js drops the string into <main>
// and then wires up any listeners. That is the same "one big render()" approach crm.html and
// dashboard.html use, and it keeps the whole page a pure function of the cached state.

import { fmt, esc, num, today } from './finance-core.js';

// ═══════ TOAST ═══════

let toastTimer = null;
export function toast(msg, action) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = () => { hideToast(); action.run(); };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 10000 : 2600);
}
export function hideToast() {
  document.getElementById('toast')?.classList.remove('show');
}

// ═══════ MODAL ═══════
//
// One overlay reused by every dialog. Focus moves into it on open and returns to whatever
// opened it on close, and Escape always works — this is the only dialog surface on the page,
// so getting it right once covers everything.

let lastFocus = null;
let onCloseModal = null;

export function modal({ title, body, foot, onClose }) {
  lastFocus = document.activeElement;
  onCloseModal = onClose || null;
  const ov = document.getElementById('ov');
  ov.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title || 'Dialog')}">
      <div class="modal-head">
        <h3>${esc(title || '')}</h3>
        <div class="spacer"></div>
        <button class="btn ghost sm" type="button" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>`;
  ov.classList.add('show');
  ov.querySelector('[data-close]').onclick = closeModal;
  const focusable = ov.querySelector('input,select,textarea,button:not([data-close])');
  (focusable || ov.querySelector('[data-close]')).focus();
}

export function closeModal() {
  const ov = document.getElementById('ov');
  if (!ov.classList.contains('show')) return;
  ov.classList.remove('show');
  ov.innerHTML = '';
  const cb = onCloseModal;
  onCloseModal = null;
  lastFocus?.focus?.();
  if (cb) cb();
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    modal({
      title,
      body: `<p style="font-size:14.5px">${message}</p>`,
      foot: `<button class="btn" type="button" data-no>Cancel</button>
             <div class="spacer"></div>
             <button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-yes>${esc(confirmLabel)}</button>`,
      onClose: () => resolve(false),
    });
    const ov = document.getElementById('ov');
    ov.querySelector('[data-no]').onclick = () => { onCloseModal = null; closeModal(); resolve(false); };
    ov.querySelector('[data-yes]').onclick = () => { onCloseModal = null; closeModal(); resolve(true); };
  });
}

// ═══════ SMALL BUILDING BLOCKS ═══════

export const stat = (label, value, opts = {}) => `
  <div class="card stat ${opts.hero ? 'hero' : ''}">
    <div class="l">${esc(label)}</div>
    <div class="v ${opts.cls || ''}">${opts.raw ? value : esc(value)}</div>
    ${opts.sub ? `<div class="s">${opts.subRaw ? opts.sub : esc(opts.sub)}</div>` : ''}
  </div>`;

export const money = n => fmt(n);

// Colour a figure only when the sign carries meaning — a profit or a difference.
export const signed = n => `<span class="${num(n) < 0 ? 'neg' : num(n) > 0 ? 'pos' : ''}">${fmt(n)}</span>`;

export const empty = (message, actionHtml = '') =>
  `<div class="empty">${message}${actionHtml}</div>`;

export const loading = (rows = 3) =>
  `<div>${'<div class="skel skel-card"></div>'.repeat(rows)}</div>`;

export const note = (html, kind = '') => `<div class="note ${kind}">${html}</div>`;

export const tag = (text, kind = '') => `<span class="tag ${kind}">${esc(text)}</span>`;

export const table = (head, rows, foot = '') => `
  <div class="card pad0"><div class="tbl-wrap"><table>
    <thead><tr>${head}</tr></thead>
    <tbody>${rows}</tbody>
    ${foot ? `<tfoot>${foot}</tfoot>` : ''}
  </table></div></div>`;

export const seg = (options, current, handler) =>
  `<div class="seg" role="tablist">${options.map(([v, l]) =>
    `<button type="button" role="tab" aria-selected="${v === current}" class="${v === current ? 'on' : ''}" onclick="${handler}('${esc(v)}')">${esc(l)}</button>`
  ).join('')}</div>`;

// ═══════ MONTH HELPERS FOR PICKERS ═══════

export function monthOptions(txns, extra = []) {
  const set = new Set(txns.map(t => String(t.date).slice(0, 7)));
  extra.forEach(m => set.add(m));
  return [...set].filter(Boolean).sort().reverse();
}

// ═══════ CSV ═══════

// Quote every field: descriptions routinely contain commas, and Excel is unforgiving.
export function toCsv(rows) {
  return rows
    .map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}

export function downloadCsv(filename, rows) {
  // The BOM makes Excel open UTF-8 correctly, which matters for the ₹ sign and Tamil names.
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function downloadJson(filename, data) {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

// ═══════ SEARCH PICKER ═══════
//
// Backs the party, property and deal fields. Renders into a container and calls back with the
// chosen value. "Add new" is offered inline but only ever returns a {__new:true,...} object —
// nothing is created until the form is saved, so an abandoned form leaves no orphan records.

export function picker(container, {
  value, placeholder, search, allowNew, newLabel = 'Add', onChange, describe,
}) {
  const render = () => {
    if (value) {
      container.innerHTML = `
        <span class="chip-sel">
          <span>${esc(describe ? describe(value) : (value.name || value))}</span>
          <button type="button" aria-label="Clear">✕</button>
        </span>`;
      container.querySelector('button').onclick = () => { value = null; onChange(null); render(); };
      return;
    }
    container.innerHTML = `
      <div class="picker">
        <input type="search" placeholder="${esc(placeholder || 'Search…')}" autocomplete="off">
        <div class="picker-results" hidden></div>
      </div>`;
    const input = container.querySelector('input');
    const list = container.querySelector('.picker-results');

    const run = async () => {
      const q = input.value.trim();
      const results = await search(q);
      const rows = results.map((r, i) =>
        `<button type="button" data-i="${i}">${esc(describe ? describe(r) : r.name)}</button>`).join('');
      const addRow = (allowNew && q)
        ? `<button type="button" class="add" data-new>+ ${esc(newLabel)} "${esc(q)}"</button>` : '';
      list.innerHTML = rows + addRow;
      list.hidden = !(rows || addRow);
      list.querySelectorAll('[data-i]').forEach(b => {
        b.onclick = () => { value = results[+b.dataset.i]; onChange(value); render(); };
      });
      list.querySelector('[data-new]')?.addEventListener('click', () => {
        value = { __new: true, name: q };
        onChange(value);
        render();
      });
    };

    let debounce;
    input.oninput = () => { clearTimeout(debounce); debounce = setTimeout(run, 140); };
    input.onfocus = run;
    // Let a click on a result land before the list is torn down.
    input.onblur = () => setTimeout(() => { list.hidden = true; }, 180);
  };
  render();
}

// ═══════ ATTACHMENTS WIDGET ═══════

export function attachmentStrip(files, { onRemove } = {}) {
  if (!files.length) return '';
  return `<div class="thumbs">${files.map((f, i) => `
    <div class="thumb">
      ${f.type?.startsWith('image/') && f.url
      ? `<img src="${esc(f.url)}" alt="${esc(f.name)}">`
      : `<span>PDF</span>`}
      ${onRemove ? `<button type="button" data-rm="${i}" aria-label="Remove ${esc(f.name)}">✕</button>` : ''}
    </div>`).join('')}</div>`;
}

// ═══════ DATE HELPERS FOR FORMS ═══════

export const todayStr = today;

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

export function daysAgo(dateStr) {
  return daysBetween(dateStr, today());
}
